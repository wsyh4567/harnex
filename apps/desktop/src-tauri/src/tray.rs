use crate::{
    budget::Budget,
    executor::{ApprovalHandler, Executor},
    git_store::{GenomeBundle, GitStore},
    keyring::{Keyring, NativeKeyring},
    persist_json,
    protocol::*,
    sandbox_os::Backend,
    security::TrustStore,
    sidecar::{rpc_error, RpcHandler, Sidecar},
    updater::{NativeInstallerLauncher, Updater},
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    ffi::OsString,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, State,
};
use tokio::sync::oneshot;

type Pending = Arc<Mutex<HashMap<String, (ApprovalRequest, oneshot::Sender<ApprovalDecision>)>>>;

struct PendingCleanup(Pending, String);
impl Drop for PendingCleanup {
    fn drop(&mut self) {
        self.0.lock().unwrap().remove(&self.1);
    }
}

struct Desktop {
    core: Arc<Executor>,
    git: Arc<GitStore>,
    pending: Pending,
    sidecar: Sidecar,
    bun_present: bool,
    data: PathBuf,
    updater: Arc<Updater>,
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn emit_update(app: &tauri::AppHandle, status: UpdateStatus) {
    let _ = app.emit(
        "harnex://event",
        json!({"type": "update.status_changed", "status": status}),
    );
}

#[tauri::command]
fn updater_get_status(state: State<'_, Desktop>) -> UpdateStatus {
    state.updater.status()
}

#[tauri::command]
async fn updater_check(state: State<'_, Desktop>) -> Result<UpdateStatus, ()> {
    Ok(state.updater.check().await)
}

#[tauri::command]
async fn updater_download(
    app: tauri::AppHandle,
    state: State<'_, Desktop>,
) -> Result<UpdateStatus, ()> {
    Ok(state
        .updater
        .download(Some(&|status| emit_update(&app, status)))
        .await)
}

#[tauri::command]
async fn updater_install(
    app: tauri::AppHandle,
    state: State<'_, Desktop>,
) -> Result<UpdateStatus, String> {
    state
        .updater
        .install(
            &NativeInstallerLauncher,
            Some(&|status| emit_update(&app, status)),
        )
        .await
        .map_err(message)
}

#[tauri::command]
async fn sidecar_rpc(
    method: String,
    mut params: Value,
    state: State<'_, Desktop>,
) -> Result<Value, JsonRpcError> {
    let workspace = if matches!(
        method.as_str(),
        "thread.create" | "onboarding.start_live_challenge"
    ) {
        let root = if method == "thread.create" {
            Some(required(&params, "workspacePath")?.to_owned())
        } else {
            None
        };
        let sha = state.git.head_sha().map_err(internal)?;
        let genome = Arc::new(state.git.read_tree(&sha).map_err(internal)?);
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
    let mut answer = state.sidecar.call(&method, params).await?;
    if let Some((root, genome, sha)) = workspace {
        let thread = required(&answer, "id")?.to_owned();
        let root = match root {
            Some(root) => root,
            None => required(&answer, "workspacePath")?.to_owned(),
        };
        state
            .core
            .bind_workspace(&thread, root, SandboxMode::WorkspaceWrite, Some(genome))
            .map_err(internal)?;
        if method == "onboarding.start_live_challenge" {
            answer = state
                .sidecar
                .call(
                    "onboarding.activate_live_challenge",
                    json!({"threadId": thread}),
                )
                .await
                .inspect_err(|_| state.core.clear_workspace(&thread))?;
        }
        answer["pinnedCommitSha"] = json!(sha);
    }
    if let Some(mode) = mode {
        state.core.set_mode(mode);
    }
    Ok(answer)
}

#[tauri::command]
fn get_system_health(state: State<'_, Desktop>) -> Result<SystemHealth, String> {
    let health = state.sidecar.health();
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
        bun_embedded_ok: state.bun_present && health.alive,
        active_commit_sha: state.git.head_sha().map_err(message)?,
        rsi_mode: state.core.mode(),
    })
}

#[tauri::command]
fn security_list_pending_approvals(state: State<'_, Desktop>) -> Vec<ApprovalRequest> {
    state
        .pending
        .lock()
        .unwrap()
        .values()
        .map(|(request, _)| request.clone())
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalParams {
    request_id: String,
    decision: ApprovalDecision,
}

#[tauri::command]
fn security_resolve_approval(
    params: ApprovalParams,
    app: tauri::AppHandle,
    state: State<'_, Desktop>,
) -> Result<(), String> {
    let (_, sender) = state
        .pending
        .lock()
        .unwrap()
        .remove(&params.request_id)
        .ok_or("approval is no longer pending")?;
    sender
        .send(params.decision)
        .map_err(|_| "operation is no longer pending")?;
    let _ = app.emit("harnex://event", json!({"type": "security.approval_resolved", "requestId": params.request_id, "decision": params.decision}));
    Ok(())
}

#[tauri::command]
fn security_list_exec_policy(state: State<'_, Desktop>) -> Vec<ExecPolicyRule> {
    state.core.policy.read().unwrap().rules().to_vec()
}

#[tauri::command]
fn security_upsert_exec_policy(
    rule: ExecPolicyRule,
    state: State<'_, Desktop>,
) -> Result<Vec<ExecPolicyRule>, String> {
    let mut policy = state.core.policy.write().unwrap();
    policy.upsert(rule).map_err(message)?;
    Ok(policy.rules().to_vec())
}

#[tauri::command]
fn security_delete_exec_policy(rule_id: String, state: State<'_, Desktop>) -> Vec<ExecPolicyRule> {
    let mut policy = state.core.policy.write().unwrap();
    policy.delete(&rule_id);
    policy.rules().to_vec()
}

#[tauri::command]
fn trust_list_records(state: State<'_, Desktop>) -> Vec<TrustRecord> {
    state.core.trust.list()
}

#[tauri::command]
fn hooks_list(state: State<'_, Desktop>) -> Result<Vec<GlobalHookItem>, String> {
    crate::hooks::list_global_hooks(&state.git, &state.core.trust).map_err(message)
}

#[tauri::command]
fn hooks_upsert(
    path: String,
    event: String,
    content: String,
    trust_immediately: bool,
    state: State<'_, Desktop>,
) -> Result<GlobalHookItem, String> {
    crate::hooks::upsert_global_hook(
        &state.git,
        &state.core.trust,
        &path,
        &event,
        &content,
        trust_immediately,
    )
    .map_err(message)
}

#[tauri::command]
fn hooks_delete(path: String, state: State<'_, Desktop>) -> Result<(), String> {
    crate::hooks::delete_global_hook(&state.git, &state.core.trust, &path).map_err(message)
}

#[tauri::command]
fn trust_update_status(
    id: String,
    status: TrustStatus,
    state: State<'_, Desktop>,
) -> Result<Vec<TrustRecord>, String> {
    if status == TrustStatus::Trusted {
        let record = state
            .core
            .trust
            .list()
            .into_iter()
            .find(|entry| entry.id == id)
            .ok_or("trust record not found")?;
        let tree = state
            .git
            .read_tree(&state.git.head_sha().map_err(message)?)
            .map_err(message)?;
        let text = tree
            .get(&record.identifier)
            .ok_or("approve this asset when it runs")?;
        state
            .core
            .trust
            .trust(
                record.kind,
                &record.identifier,
                text.as_bytes(),
                &record.sha256.ok_or("asset digest missing")?,
            )
            .map_err(message)?;
    } else {
        state.core.trust.revoke(&id, status).map_err(message)?;
    }
    Ok(state.core.trust.list())
}

#[tauri::command]
fn guardian_list_decisions(state: State<'_, Desktop>) -> Vec<GuardianDecision> {
    state.core.guardian_decisions()
}

#[tauri::command]
fn git_log(limit: usize, state: State<'_, Desktop>) -> Result<Vec<GenomeCommit>, String> {
    state.git.log(limit).map_err(message)
}

#[tauri::command]
fn git_read_tree(commit_sha: String, state: State<'_, Desktop>) -> Result<Vec<Value>, String> {
    Ok(state.git.read_tree(&commit_sha).map_err(message)?.into_iter().map(|(path, content)|
        json!({"path": path, "content": content, "sizeBytes": content.len(), "component": crate::git_store::component(&path)})).collect())
}

#[tauri::command]
fn git_revert(
    target_sha: String,
    reason: String,
    state: State<'_, Desktop>,
) -> Result<GenomeCommit, String> {
    state.git.revert(&target_sha, &reason).map_err(message)?;
    state
        .git
        .log(1)
        .map_err(message)?
        .pop()
        .ok_or_else(|| "rollback commit missing".into())
}

#[tauri::command]
fn git_scan_export(state: State<'_, Desktop>) -> Result<ExportScanResult, String> {
    state
        .git
        .scan_export(&state.git.head_sha().map_err(message)?, false)
        .map_err(message)
}

#[tauri::command]
fn git_confirm_export(strip_findings: bool, state: State<'_, Desktop>) -> Result<Value, String> {
    let bundle = state
        .git
        .export_bundle(
            &state.git.head_sha().map_err(message)?,
            false,
            strip_findings,
        )
        .map_err(message)?;
    let path = state
        .data
        .join("exports")
        .join(format!("genome-{}.json", uuid::Uuid::new_v4()));
    persist_json(&path, &bundle).map_err(message)?;
    Ok(json!({"archivePath": path, "fileCount": bundle.len()}))
}

fn load_bundle(path: &Path) -> Result<GenomeBundle, String> {
    const LIMIT: u64 = 32 * 1024 * 1024;
    let file = fs::File::open(path).map_err(message)?;
    if !file.metadata().map_err(message)?.is_file() {
        return Err("bundle must be a regular file".into());
    }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(message)?;
    if bytes.len() as u64 > LIMIT {
        return Err("bundle too large".into());
    }
    serde_json::from_slice(&bytes).map_err(message)
}

#[tauri::command]
fn trust_preview_import(archive_path: String) -> Result<Value, String> {
    let files: Vec<_> = load_bundle(Path::new(&archive_path))?.into_keys().collect();
    let executables: Vec<_> = files
        .iter()
        .filter(|path| crate::git_store::executable_kind(path).is_some())
        .collect();
    Ok(json!({"archivePath": archive_path, "files": files, "untrustedExecutables": executables}))
}

#[tauri::command]
fn trust_execute_import(
    archive_path: String,
    trust_paths: Vec<String>,
    state: State<'_, Desktop>,
) -> Result<Value, String> {
    if !trust_paths.is_empty() {
        return Err("approve imported executable digests individually after import".into());
    }
    let bundle = load_bundle(Path::new(&archive_path))?;
    let count = bundle.len();
    state
        .git
        .import_bundle(bundle, &state.core.trust, true)
        .map_err(message)?;
    Ok(json!({"importedCount": count}))
}

#[tauri::command]
fn budget_get_status(state: State<'_, Desktop>) -> BudgetStatus {
    state.core.budget.status()
}

#[tauri::command]
async fn budget_sync_pricing(
    params: Option<PricingSyncParams>,
    state: State<'_, Desktop>,
) -> Result<PricingSyncResult, String> {
    Ok(state
        .core
        .budget
        .pricing_sync(params.unwrap_or_default())
        .await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BudgetParams {
    daily_limit_usd: f64,
    pricing_table: Vec<ModelPricing>,
}

#[tauri::command]
fn budget_update_settings(
    params: BudgetParams,
    state: State<'_, Desktop>,
) -> Result<BudgetStatus, String> {
    state
        .core
        .budget
        .update_settings(params.daily_limit_usd, params.pricing_table)
        .map_err(message)
}

fn internal(error: impl std::fmt::Display) -> JsonRpcError {
    rpc_error(rpc_error_code::INTERNAL_ERROR, error.to_string())
}
fn encode(value: impl Serialize) -> Result<Value, JsonRpcError> {
    serde_json::to_value(value).map_err(internal)
}
fn decode<T: DeserializeOwned>(value: Value) -> Result<T, JsonRpcError> {
    serde_json::from_value(value)
        .map_err(|e| rpc_error(rpc_error_code::INVALID_PARAMS, e.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShadowParams {
    thread_id: String,
    workspace_root: String,
    commit_sha: Option<String>,
    override_tree: Option<GenomeBundle>,
}

fn l0_handler(core: Arc<Executor>, git: Arc<GitStore>, events: tauri::AppHandle) -> RpcHandler {
    Arc::new(move |request| {
        let (core, git, events) = (core.clone(), git.clone(), events.clone());
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
                    events.emit("harnex://event", params).map_err(internal)?;
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

fn required<'a>(params: &'a Value, field: &str) -> Result<&'a str, JsonRpcError> {
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

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data = dirs::home_dir()
                .ok_or_else(|| io::Error::other("home directory unavailable"))?
                .join(".harnex");
            let seed = app
                .path()
                .resource_dir()
                .ok()
                .map(|dir| dir.join("harness-seed"))
                .filter(|path| path.is_dir())
                .or_else(|| {
                    let source =
                        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../harness-seed");
                    (cfg!(debug_assertions) && source.is_dir()).then_some(source)
                });
            let git = Arc::new(GitStore::open_seeded(
                data.join("harness"),
                seed.as_deref(),
            )?);
            let trust = Arc::new(TrustStore::open(data.join("trust.json"))?);
            let budget = Arc::new(Budget::open(data.join("budget.json"))?);
            let pricing_budget = Arc::clone(&budget);
            tauri::async_runtime::spawn(async move {
                loop {
                    pricing_budget.pricing_sync(PricingSyncParams::default()).await;
                    tokio::time::sleep(crate::pricing_catalog::REFRESH_INTERVAL).await;
                }
            });
            let pending = Pending::default();
            let approval: ApprovalHandler = Arc::new({
                let pending = pending.clone();
                let app = app.handle().clone();
                move |request| {
                    let (app, pending) = (app.clone(), pending.clone());
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
                        let _ =
                            app.emit("harnex://event", json!({"type": event, "request": request}));
                        let answer = tokio::time::timeout(Duration::from_secs(120), receiver).await;
                        answer
                            .ok()
                            .and_then(Result::ok)
                            .unwrap_or(ApprovalDecision::Deny)
                    })
                }
            });
            let bundled = std::env::current_exe()?.with_file_name(if cfg!(windows) {
                "harnex-sidecar.exe"
            } else {
                "harnex-sidecar"
            });
            let executable = std::env::var_os("HARNEX_SIDECAR")
                .map(PathBuf::from)
                .unwrap_or_else(|| bundled.clone());
            let bun_present = executable.is_absolute() && executable.is_file();
            let executable = if bun_present {
                executable.canonicalize()?
            } else {
                bundled
            };
            let core = Arc::new(Executor::new(trust, budget, executable.clone(), approval));
            let handler = l0_handler(core.clone(), git.clone(), app.handle().clone());
            let sidecar_env = vec![(
                OsString::from("HARNEX_SIDECAR_DB"),
                data.join("trace.sqlite").into_os_string(),
            )];
            let sidecar = tauri::async_runtime::block_on(async {
                Sidecar::start_with_env(executable, Vec::new(), sidecar_env, Some(handler))
            });
            let updater = Arc::new(Updater::new(data.clone(), git.clone())?);
            app.manage(Desktop {
                core,
                git,
                pending,
                sidecar,
                bun_present,
                data,
                updater: updater.clone(),
            });

            let show = MenuItem::with_id(app, "show", "Show Harnex", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Harnex", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .tooltip("Harnex")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => (),
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let status = updater.check_background().await;
                if status.checked_at.is_some() {
                    emit_update(&handle, status);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sidecar_rpc,
            get_system_health,
            security_list_pending_approvals,
            security_resolve_approval,
            security_list_exec_policy,
            security_upsert_exec_policy,
            security_delete_exec_policy,
            trust_list_records,
            hooks_list,
            hooks_upsert,
            hooks_delete,
            trust_update_status,
            guardian_list_decisions,
            git_log,
            git_read_tree,
            git_revert,
            git_scan_export,
            git_confirm_export,
            trust_preview_import,
            trust_execute_import,
            budget_get_status,
            budget_sync_pricing,
            budget_update_settings,
            updater_get_status,
            updater_check,
            updater_download,
            updater_install,
        ])
        .run(tauri::generate_context!())
        .expect("Harnex desktop runtime failed");
}
