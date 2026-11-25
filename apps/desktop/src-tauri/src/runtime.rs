use crate::{
    budget::Budget,
    executor::{ApprovalHandler, Executor},
    git_store::{GenomeBundle, GitStore},
    keyring::{Keyring, NativeKeyring},
    protocol::*,
    sandbox_os::Backend,
    security::TrustStore,
    sidecar::{rpc_error, RpcHandler, Sidecar},
    updater::Updater,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    ffi::OsString,
    io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::oneshot;

pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, payload: Value);
}

pub struct NoopEventSink;

impl EventSink for NoopEventSink {
    fn emit(&self, _payload: Value) {}
}

pub type PendingApprovals =
    Arc<Mutex<HashMap<String, (ApprovalRequest, oneshot::Sender<ApprovalDecision>)>>>;

struct PendingCleanup(PendingApprovals, String);

impl Drop for PendingCleanup {
    fn drop(&mut self) {
        self.0.lock().unwrap().remove(&self.1);
    }
}

#[derive(Default, Clone)]
pub struct L0StartOptions {
    pub data_dir: Option<PathBuf>,
    pub seed_dir: Option<PathBuf>,
    pub sidecar_override: Option<PathBuf>,
    pub start_background_pricing: bool,
}

pub struct L0Runtime {
    pub core: Arc<Executor>,
    pub git: Arc<GitStore>,
    pub pending: PendingApprovals,
    pub sidecar: Sidecar,
    pub bun_present: bool,
    pub data: PathBuf,
    pub updater: Arc<Updater>,
    pub events: Arc<dyn EventSink>,
}

pub fn resolve_sidecar_command(
    sidecar_override: Option<&Path>,
) -> io::Result<(PathBuf, Vec<OsString>, bool)> {
    let bundled = std::env::current_exe()?.with_file_name(if cfg!(windows) {
        "harnex-sidecar.exe"
    } else {
        "harnex-sidecar"
    });
    let explicit = sidecar_override
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HARNEX_SIDECAR").map(PathBuf::from));
    let candidate = explicit.unwrap_or_else(|| bundled.clone());
    if candidate.is_absolute() && candidate.is_file() {
        return Ok((candidate.canonicalize()?, Vec::new(), true));
    }
    if candidate.is_file() {
        return Ok((candidate.canonicalize()?, Vec::new(), true));
    }
    #[cfg(debug_assertions)]
    {
        let dev_entry = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/sidecar/src/index.ts");
        if dev_entry.is_file() {
            let bun = if cfg!(windows) { "bun.exe" } else { "bun" };
            return Ok((
                PathBuf::from(bun),
                vec![OsString::from("run"), dev_entry.into_os_string()],
                true,
            ));
        }
    }
    Ok((bundled, Vec::new(), false))
}

pub fn resolve_seed_dir(explicit: Option<&Path>) -> Option<PathBuf> {
    if let Some(dir) = explicit {
        if dir.is_dir() {
            return Some(dir.to_path_buf());
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sibling = dir.join("harness-seed");
            if sibling.is_dir() {
                return Some(sibling);
            }
            let resources = dir.join("resources").join("harness-seed");
            if resources.is_dir() {
                return Some(resources);
            }
        }
    }
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../harness-seed");
    (cfg!(debug_assertions) && source.is_dir()).then_some(source)
}

impl L0Runtime {
    pub fn start(options: L0StartOptions, events: Arc<dyn EventSink>) -> io::Result<Self> {
        let data = match options.data_dir {
            Some(dir) => dir,
            None => dirs::home_dir()
                .ok_or_else(|| io::Error::other("home directory unavailable"))?
                .join(".harnex"),
        };
        let seed = resolve_seed_dir(options.seed_dir.as_deref());
        let git = Arc::new(
            GitStore::open_seeded(data.join("harness"), seed.as_deref())
                .map_err(io::Error::other)?,
        );
        let trust = Arc::new(TrustStore::open(data.join("trust.json"))?);
        let budget = Arc::new(Budget::open(data.join("budget.json")).map_err(io::Error::other)?);

        if options.start_background_pricing {
            let pricing_budget = Arc::clone(&budget);
            tokio::spawn(async move {
                loop {
                    pricing_budget
                        .pricing_sync(PricingSyncParams::default())
                        .await;
                    tokio::time::sleep(crate::pricing_catalog::REFRESH_INTERVAL).await;
                }
            });
        }

        let pending = PendingApprovals::default();
        let approval: ApprovalHandler = Arc::new({
            let pending = pending.clone();
            let events = Arc::clone(&events);
            move |request| {
                let (events, pending) = (Arc::clone(&events), pending.clone());
                Box::pin(async move {
                    let id = request.request_id.clone();
                    let (sender, receiver) = oneshot::channel();
                    pending
                        .lock()
                        .unwrap()
                        .insert(id.clone(), (request.clone(), sender));
                    let _cleanup = PendingCleanup(pending, id);
                    let event = if request.kind == ApprovalRequestKind::HookTrust {
                        "trust.hook_confirm"
                    } else {
                        "security.approval_required"
                    };
                    events.emit(json!({"type": event, "request": request}));
                    let answer = tokio::time::timeout(Duration::from_secs(120), receiver).await;
                    answer
                        .ok()
                        .and_then(Result::ok)
                        .unwrap_or(ApprovalDecision::Deny)
                })
            }
        });

        let (executable, args, bun_present) =
            resolve_sidecar_command(options.sidecar_override.as_deref())?;
        let core = Arc::new(Executor::new(trust, budget, executable.clone(), approval));
        let handler = l0_handler(core.clone(), git.clone(), Arc::clone(&events));
        let sidecar_env = vec![(
            OsString::from("HARNEX_SIDECAR_DB"),
            data.join("trace.sqlite").into_os_string(),
        )];
        let sidecar = Sidecar::start_with_env(executable, args, sidecar_env, Some(handler));
        let updater = Arc::new(Updater::new(data.clone(), git.clone())?);

        Ok(Self {
            core,
            git,
            pending,
            sidecar,
            bun_present,
            data,
            updater,
            events,
        })
    }

    pub async fn sidecar_rpc(
        &self,
        method: &str,
        mut params: Value,
    ) -> Result<Value, JsonRpcError> {
        let workspace = if matches!(method, "thread.create" | "onboarding.start_live_challenge") {
            let root = if method == "thread.create" {
                Some(required(&params, "workspacePath")?.to_owned())
            } else {
                None
            };
            let sha = self.git.head_sha().map_err(internal)?;
            let genome = Arc::new(self.git.read_tree(&sha).map_err(internal)?);
            params
                .as_object_mut()
                .ok_or_else(|| {
                    rpc_error(
                        rpc_error_code::INVALID_PARAMS,
                        "parameters must be an object",
                    )
                })?
                .insert("pinnedCommitSha".into(), json!(sha));
            Some((root, genome, sha))
        } else {
            None
        };
        let mode = if method == "config.set_rsi_mode" || method == "config.update" {
            params
                .get("rsiMode")
                .cloned()
                .map(decode::<RsiMode>)
                .transpose()?
        } else {
            None
        };
        let mut answer = self.sidecar.call(method, params).await?;
        if let Some((root, genome, sha)) = workspace {
            let thread = required(&answer, "id")?.to_owned();
            let root = match root {
                Some(root) => root,
                None => required(&answer, "workspacePath")?.to_owned(),
            };
            self.core
                .bind_workspace(&thread, root, SandboxMode::WorkspaceWrite, Some(genome))
                .map_err(internal)?;
            if method == "onboarding.start_live_challenge" {
                answer = self
                    .sidecar
                    .call(
                        "onboarding.activate_live_challenge",
                        json!({"threadId": thread}),
                    )
                    .await
                    .inspect_err(|_| self.core.clear_workspace(&thread))?;
            }
            answer["pinnedCommitSha"] = json!(sha);
        }
        if let Some(mode) = mode {
            self.core.set_mode(mode);
        }
        Ok(answer)
    }

    pub fn system_health(&self) -> Result<SystemHealth, String> {
        let health = self.sidecar.health();
        let backend = Backend::detect();
        Ok(SystemHealth {
            sidecar_alive: health.alive,
            sidecar_restart_count: health.restart_count,
            platform: std::env::consts::OS.into(),
            sandbox_backend: backend.name().into(),
            os_sandbox_level: match backend {
                Backend::WindowsAppContainer | Backend::Unavailable => "beta",
                _ => "full",
            }
            .into(),
            bun_embedded_ok: self.bun_present && health.alive,
            active_commit_sha: self.git.head_sha().map_err(|e| e.to_string())?,
            rsi_mode: self.core.mode(),
        })
    }

    pub fn list_pending_approvals(&self) -> Vec<ApprovalRequest> {
        self.pending
            .lock()
            .unwrap()
            .values()
            .map(|(request, _)| request.clone())
            .collect()
    }

    pub fn resolve_approval(
        &self,
        request_id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), String> {
        let (_, sender) = self
            .pending
            .lock()
            .unwrap()
            .remove(request_id)
            .ok_or("approval is no longer pending")?;
        sender
            .send(decision)
            .map_err(|_| "operation is no longer pending")?;
        self.events.emit(json!({
            "type": "security.approval_resolved",
            "requestId": request_id,
            "decision": decision,
        }));
        Ok(())
    }
}

pub(crate) fn internal(error: impl std::fmt::Display) -> JsonRpcError {
    rpc_error(rpc_error_code::INTERNAL_ERROR, error.to_string())
}

pub(crate) fn encode(value: impl Serialize) -> Result<Value, JsonRpcError> {
    serde_json::to_value(value).map_err(internal)
}

pub(crate) fn decode<T: DeserializeOwned>(value: Value) -> Result<T, JsonRpcError> {
    serde_json::from_value(value)
        .map_err(|e| rpc_error(rpc_error_code::INVALID_PARAMS, e.to_string()))
}

pub(crate) fn required<'a>(params: &'a Value, field: &str) -> Result<&'a str, JsonRpcError> {
    params
        .get(field)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            rpc_error(
                rpc_error_code::INVALID_PARAMS,
                format!("{field} is required"),
            )
        })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShadowParams {
    thread_id: String,
    workspace_root: String,
    commit_sha: Option<String>,
    override_tree: Option<GenomeBundle>,
}

pub fn l0_handler(
    core: Arc<Executor>,
    git: Arc<GitStore>,
    events: Arc<dyn EventSink>,
) -> RpcHandler {
    Arc::new(move |request| {
        let (core, git, events) = (core.clone(), git.clone(), Arc::clone(&events));
        Box::pin(async move {
            let params = request.params.unwrap_or(Value::Null);
            match request.method.as_str() {
                "exec.write_file" => encode(core.exec_write_file(decode(params)?).await?),
                "exec.delete_file" => encode(core.exec_delete_file(decode(params)?).await?),
                "exec.shell" => encode(core.exec_shell(decode(params)?).await?),
                "exec.script" => encode(core.exec_script(decode(params)?).await?),
                "exec.hook" => encode(core.exec_hook(decode(params)?).await?),
                "git.head_sha" => encode(git.head_sha().map_err(internal)?),
                "git.log" => encode(
                    git.log(
                        params
                            .get("limit")
                            .and_then(Value::as_u64)
                            .unwrap_or(50)
                            .min(1000) as usize,
                    )
                    .map_err(internal)?,
                ),
                "git.read_tree" => encode(
                    git.read_tree(required(&params, "commitSha")?)
                        .map_err(internal)?,
                ),
                "git.commit_patch" => {
                    let tags: Vec<UntrustedSourceTag> = params
                        .get("sourceTags")
                        .cloned()
                        .map(decode)
                        .transpose()?
                        .unwrap_or_else(|| vec![UntrustedSourceTag::ExternalFile]);
                    let thread = params
                        .get("threadId")
                        .and_then(Value::as_str)
                        .unwrap_or("evolution")
                        .to_owned();
                    let patch = decode(params.get("patch").cloned().unwrap_or(params))?;
                    encode(core.commit_patch(&git, &thread, &patch, &tags).await?)
                }
                "git.revert" => {
                    let target = required(&params, "targetSha")?;
                    let reason = required(&params, "reason")?;
                    git.read_tree(target).map_err(internal)?;
                    core.approve_revert(target).await?;
                    encode(git.revert(target, reason).map_err(internal)?)
                }
                "git.record_health" => {
                    let success =
                        params
                            .get("success")
                            .and_then(Value::as_bool)
                            .ok_or_else(|| {
                                rpc_error(rpc_error_code::INVALID_PARAMS, "success is required")
                            })?;
                    encode(
                        git.record_health(
                            required(&params, "domain")?,
                            required(&params, "commitSha")?,
                            success,
                        )
                        .map_err(internal)?,
                    )
                }
                "budget.check" => {
                    let usd = params
                        .get("estimatedCostUsd")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0);
                    let tokens = params
                        .get("estimatedTokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    let check = core.budget.check_budget(usd, tokens);
                    Ok(match check {
                        Ok(status) => json!({"allowed": true, "status": status}),
                        Err(e) => {
                            json!({"allowed": false, "status": core.budget.status(), "reason": e.to_string()})
                        }
                    })
                }
                "budget.record_usage" => encode(
                    core.budget
                        .record_usage(
                            required(&params, "modelId")?,
                            &decode(params["usage"].clone())?,
                        )
                        .map_err(internal)?,
                ),
                "budget.merge_pricing" => encode(
                    core.budget
                        .merge_pricing(decode(params["pricing"].clone())?)
                        .map_err(internal)?,
                ),
                "budget.model_pricing" => {
                    encode(core.budget.model_pricing(required(&params, "modelId")?))
                }
                "budget.sync_pricing" => {
                    let options = if params.is_null() {
                        PricingSyncParams::default()
                    } else {
                        decode(params)?
                    };
                    encode(core.budget.pricing_sync(options).await)
                }
                "sandbox.bind_shadow" => {
                    let params: ShadowParams = decode(params)?;
                    if params.thread_id.is_empty() {
                        return Err(rpc_error(
                            rpc_error_code::INVALID_PARAMS,
                            "threadId is required",
                        ));
                    }
                    let sha = match params.commit_sha {
                        Some(sha) => sha,
                        None => git.head_sha().map_err(internal)?,
                    };
                    let pinned = git.read_tree(&sha).map_err(internal)?;
                    let tree = if let Some(tree) = params.override_tree {
                        crate::git_store::validate_files(&tree).map_err(|error| {
                            rpc_error(rpc_error_code::INVALID_PARAMS, error.to_string())
                        })?;
                        tree
                    } else {
                        pinned
                    };
                    core.bind_workspace(
                        &params.thread_id,
                        params.workspace_root,
                        SandboxMode::CowShadow,
                        Some(Arc::new(tree)),
                    )
                    .map_err(|error| {
                        rpc_error(rpc_error_code::SANDBOX_DENIED, error.to_string())
                    })?;
                    Ok(Value::Null)
                }
                "sandbox.clear_shadow" => {
                    core.clear_shadow(required(&params, "threadId")?);
                    Ok(Value::Null)
                }
                "keyring.get" | "keyring.set" | "keyring.delete" => {
                    let reference = required(&params, "keyringRef")?.to_owned();
                    let method = request.method;
                    let secret = if method == "keyring.set" {
                        Some(required(&params, "secret")?.to_owned())
                    } else {
                        None
                    };
                    tokio::task::spawn_blocking(move || match method.as_str() {
                        "keyring.get" => encode(NativeKeyring.get(&reference).map_err(internal)?),
                        "keyring.set" => encode(
                            NativeKeyring
                                .set(&reference, secret.as_deref().unwrap())
                                .map_err(internal)?,
                        ),
                        _ => encode(NativeKeyring.delete(&reference).map_err(internal)?),
                    })
                    .await
                    .map_err(internal)?
                }
                "event.emit" => {
                    if !params
                        .get("type")
                        .and_then(Value::as_str)
                        .is_some_and(|event| {
                            event.starts_with("runner.") || event.starts_with("evolution.")
                        })
                    {
                        return Err(rpc_error(
                            rpc_error_code::INVALID_PARAMS,
                            "event is not a runner or evolution event",
                        ));
                    }
                    events.emit(params);
                    Ok(Value::Null)
                }
                _ => Err(rpc_error(
                    rpc_error_code::METHOD_NOT_FOUND,
                    "unknown L0 bridge method",
                )),
            }
        })
    })
}
