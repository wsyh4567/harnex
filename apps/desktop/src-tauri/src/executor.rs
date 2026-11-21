use crate::{
    budget::Budget,
    git_store::{GenomeBundle, GitStore},
    guardian::{Evaluator, Guardian, Operation, ReviewInput, RulesEvaluator, Verdict},
    protocol::*,
    sandbox_os::{self, ProcessSpec, Program, Sandbox},
    security::{sha256, ExecPolicy, TrustStore},
    sidecar::rpc_error,
};
use chrono::Utc;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    future::Future,
    io,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex, RwLock},
    time::{Duration, Instant},
};

type L0Result<T> = Result<T, JsonRpcError>;
type DecisionFuture = Pin<Box<dyn Future<Output = ApprovalDecision> + Send>>;
pub type ApprovalHandler = Arc<dyn Fn(ApprovalRequest) -> DecisionFuture + Send + Sync>;

fn sandbox_error(error: io::Error) -> JsonRpcError {
    rpc_error(rpc_error_code::SANDBOX_DENIED, error.to_string())
}
fn invalid(message: &str) -> JsonRpcError {
    rpc_error(rpc_error_code::INVALID_PARAMS, message)
}

struct Binding {
    workspace_root: String,
    sandbox: Sandbox,
    mode: SandboxMode,
    genome: Option<Arc<GenomeBundle>>,
}

pub struct Executor {
    workspaces: RwLock<HashMap<String, Arc<Binding>>>,
    sessions: Mutex<HashSet<(String, String)>>,
    decisions: Mutex<VecDeque<GuardianDecision>>,
    mode: RwLock<RsiMode>,
    guardian: Guardian<Box<dyn Evaluator>>,
    approval: ApprovalHandler,
    bun: PathBuf,
    pub policy: RwLock<ExecPolicy>,
    pub trust: Arc<TrustStore>,
    pub budget: Arc<Budget>,
}

impl Executor {
    pub fn new(
        trust: Arc<TrustStore>,
        budget: Arc<Budget>,
        bun: PathBuf,
        approval: ApprovalHandler,
    ) -> Self {
        Self::with_guardian(trust, budget, bun, approval, Box::new(RulesEvaluator))
    }

    pub fn with_guardian(
        trust: Arc<TrustStore>,
        budget: Arc<Budget>,
        bun: PathBuf,
        approval: ApprovalHandler,
        guardian: Box<dyn Evaluator>,
    ) -> Self {
        Self {
            workspaces: RwLock::new(HashMap::new()),
            sessions: Mutex::new(HashSet::new()),
            decisions: Mutex::new(VecDeque::new()),
            mode: RwLock::new(RsiMode::Manual),
            guardian: Guardian(guardian),
            approval,
            bun,
            trust,
            budget,
            policy: RwLock::new(ExecPolicy::default()),
        }
    }

    pub fn mode(&self) -> RsiMode {
        *self.mode.read().unwrap()
    }
    pub fn set_mode(&self, mode: RsiMode) {
        *self.mode.write().unwrap() = mode;
    }
    pub fn guardian_decisions(&self) -> Vec<GuardianDecision> {
        self.decisions.lock().unwrap().iter().cloned().collect()
    }

    /// Workspace and optional pinned tree are chosen by trusted desktop code for this thread.
    pub fn bind_workspace(
        &self,
        thread: &str,
        workspace_root: String,
        mode: SandboxMode,
        genome: Option<Arc<GenomeBundle>>,
    ) -> io::Result<()> {
        let shadow = mode == SandboxMode::CowShadow;
        let sandbox = if shadow {
            Sandbox::new_shadow(Path::new(&workspace_root))?
        } else {
            Sandbox::new(Path::new(&workspace_root))?
        };
        let mut bindings = self.workspaces.write().unwrap();
        if bindings
            .get(thread)
            .is_some_and(|binding| shadow || binding.mode == SandboxMode::CowShadow)
            || bindings.values().any(|binding| {
                (shadow || binding.mode == SandboxMode::CowShadow)
                    && sandbox.overlaps(&binding.sandbox)
            })
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "shadow workspace or thread overlaps an existing binding",
            ));
        }
        self.sessions.lock().unwrap().retain(|(id, _)| id != thread);
        bindings.insert(
            thread.into(),
            Arc::new(Binding {
                workspace_root,
                sandbox,
                mode,
                genome,
            }),
        );
        Ok(())
    }

    pub fn clear_workspace(&self, thread: &str) {
        self.workspaces.write().unwrap().remove(thread);
        self.sessions.lock().unwrap().retain(|(id, _)| id != thread);
    }

    pub fn clear_shadow(&self, thread: &str) {
        let mut bindings = self.workspaces.write().unwrap();
        if bindings
            .get(thread)
            .is_some_and(|binding| binding.mode == SandboxMode::CowShadow)
        {
            bindings.remove(thread);
            self.sessions.lock().unwrap().retain(|(id, _)| id != thread);
        }
    }

    fn bound(&self, thread: &str, root: &str, requested: SandboxMode) -> L0Result<Arc<Binding>> {
        let binding = self
            .workspaces
            .read()
            .unwrap()
            .get(thread)
            .cloned()
            .ok_or_else(|| {
                rpc_error(
                    rpc_error_code::SANDBOX_DENIED,
                    "thread has no workspace binding",
                )
            })?;
        if binding.workspace_root != root
            || (requested != SandboxMode::ReadOnly && binding.mode != requested)
        {
            return Err(rpc_error(
                rpc_error_code::SANDBOX_DENIED,
                "intent differs from the thread's sandbox binding",
            ));
        }
        Ok(binding)
    }

    fn check_budget(&self) -> L0Result<()> {
        self.budget
            .check_budget(0.0, 0)
            .map(|_| ())
            .map_err(|e| rpc_error(rpc_error_code::BUDGET_EXCEEDED, e.to_string()))
    }

    #[allow(clippy::too_many_arguments)]
    async fn gate(
        &self,
        thread: &str,
        operation: Operation,
        path: &str,
        mode: SandboxMode,
        tags: &[UntrustedSourceTag],
        policy: ExecPolicyAction,
        network: bool,
        risky: bool,
        identity: impl Serialize,
    ) -> L0Result<()> {
        if policy == ExecPolicyAction::Forbidden {
            return Err(rpc_error(
                rpc_error_code::APPROVAL_DENIED,
                "execution policy forbids this command",
            ));
        }
        let untrusted_source = tags.iter().any(|tag| *tag != UntrustedSourceTag::Local);
        if policy == ExecPolicyAction::Allow && !risky && !network && !untrusted_source {
            return Ok(());
        }
        let fingerprint = sha256(
            &serde_json::to_vec(&identity).map_err(|_| invalid("invalid approval identity"))?,
        );
        let key = (thread.to_owned(), fingerprint);
        if self.sessions.lock().unwrap().contains(&key) {
            return Ok(());
        }
        let kind = if matches!(operation, Operation::Proposal) {
            ApprovalRequestKind::HighPrivilegeProposal
        } else {
            ApprovalRequestKind::ShellCommand
        };
        let request = request(
            thread,
            kind,
            path,
            tags,
            if risky || network || untrusted_source {
                RiskLevel::High
            } else {
                RiskLevel::Medium
            },
            None,
            None,
        );
        if self.mode() == RsiMode::Auto {
            let input = ReviewInput::new(
                operation, path, mode, network, policy, tags, risky, false, true,
            );
            let (verdict, decision) = self
                .guardian
                .review(&request.request_id, thread, &input)
                .await;
            let mut log = self.decisions.lock().unwrap();
            if log.len() == 1000 {
                log.pop_front();
            }
            log.push_back(decision);
            match verdict {
                Verdict::Allow => return Ok(()),
                Verdict::Deny => {
                    return Err(rpc_error(
                        rpc_error_code::APPROVAL_DENIED,
                        "Guardian denied the operation",
                    ))
                }
                Verdict::Human => (),
            }
        }
        match (self.approval)(request).await {
            ApprovalDecision::AllowOnce => Ok(()),
            ApprovalDecision::AllowSession => {
                self.sessions.lock().unwrap().insert(key);
                Ok(())
            }
            ApprovalDecision::Deny => Err(rpc_error(
                rpc_error_code::APPROVAL_DENIED,
                "human approval required",
            )),
        }
    }

    pub async fn exec_write_file(&self, intent: ExecWriteFileIntent) -> L0Result<ExecResult> {
        let started = Instant::now();
        let binding = self.bound(
            &intent.thread_id,
            &intent.workspace_root,
            intent.sandbox_mode,
        )?;
        let target = binding
            .sandbox
            .check_path(&intent.target_path, intent.sandbox_mode)
            .map_err(sandbox_error)?;
        self.gate(
            &intent.thread_id,
            Operation::Write,
            &intent.target_path,
            intent.sandbox_mode,
            &intent.source_tags,
            ExecPolicyAction::Allow,
            false,
            false,
            (
                "write",
                &intent.workspace_root,
                &target,
                sha256(intent.content.as_bytes()),
                &intent.source_tags,
            ),
        )
        .await?;
        self.check_budget()?;
        binding
            .sandbox
            .write_file(
                &intent.target_path,
                intent.sandbox_mode,
                intent.content.as_bytes(),
            )
            .map_err(sandbox_error)?;
        Ok(file_result(started))
    }

    pub async fn exec_delete_file(&self, intent: ExecDeleteFileIntent) -> L0Result<ExecResult> {
        let started = Instant::now();
        let binding = self.bound(
            &intent.thread_id,
            &intent.workspace_root,
            intent.sandbox_mode,
        )?;
        let target = binding
            .sandbox
            .check_path(&intent.target_path, intent.sandbox_mode)
            .map_err(sandbox_error)?;
        self.gate(
            &intent.thread_id,
            Operation::Delete,
            &intent.target_path,
            intent.sandbox_mode,
            &intent.source_tags,
            ExecPolicyAction::Prompt,
            false,
            false,
            (
                "delete",
                &intent.workspace_root,
                &target,
                &intent.source_tags,
            ),
        )
        .await?;
        self.check_budget()?;
        binding
            .sandbox
            .delete_file(&intent.target_path, intent.sandbox_mode)
            .map_err(sandbox_error)?;
        Ok(file_result(started))
    }

    pub async fn exec_shell(&self, intent: ExecShellIntent) -> L0Result<ExecResult> {
        let binding = self.bound(
            &intent.thread_id,
            &intent.workspace_root,
            intent.sandbox_mode,
        )?;
        check_shadow_network(&binding, intent.allow_network)?;
        binding
            .sandbox
            .can_run(intent.allow_network)
            .map_err(sandbox_error)?;
        let command = sandbox_os::command_path(&intent.command).map_err(sandbox_error)?;
        let cwd = binding
            .sandbox
            .cwd(intent.cwd.as_deref())
            .map_err(sandbox_error)?;
        let timeout = timeout(intent.timeout_ms)?;
        if !intent.env.is_empty() {
            return Err(invalid(
                "sandboxed commands cannot add environment variables",
            ));
        }
        validate_args(&intent.args)?;
        let policy = self
            .policy
            .read()
            .unwrap()
            .evaluate(&intent.command, &intent.args);
        let name = intent.command.to_ascii_lowercase();
        let name = name.strip_suffix(".exe").unwrap_or(&name);
        let risky = policy != ExecPolicyAction::Allow
            || matches!(
                name,
                "bash"
                    | "sh"
                    | "zsh"
                    | "cmd"
                    | "powershell"
                    | "pwsh"
                    | "python"
                    | "python3"
                    | "node"
                    | "bun"
                    | "rm"
                    | "chmod"
                    | "chown"
            );
        self.gate(
            &intent.thread_id,
            Operation::Shell,
            &intent.command,
            intent.sandbox_mode,
            &intent.source_tags,
            policy,
            intent.allow_network,
            risky,
            (
                "shell",
                &intent.workspace_root,
                &intent.command,
                &intent.args,
                &cwd,
                intent.sandbox_mode,
                intent.allow_network,
                &intent.source_tags,
            ),
        )
        .await?;
        self.check_budget()?;
        binding
            .sandbox
            .run(ProcessSpec {
                program: Program::Command(command, intent.args),
                cwd,
                mode: intent.sandbox_mode,
                network: intent.allow_network,
                timeout,
                stdin: None,
            })
            .await
            .map_err(sandbox_error)
    }

    pub async fn exec_script(&self, intent: ExecScriptIntent) -> L0Result<ExecResult> {
        let binding = self.bound(
            &intent.thread_id,
            &intent.workspace_root,
            intent.sandbox_mode,
        )?;
        check_shadow_network(&binding, intent.allow_network)?;
        binding
            .sandbox
            .can_run(intent.allow_network)
            .map_err(sandbox_error)?;
        let (id, asset) = asset(&binding, &intent.script_path, TrustKind::Script)?;
        let cwd = binding
            .sandbox
            .cwd(intent.cwd.as_deref())
            .map_err(sandbox_error)?;
        let timeout = timeout(intent.timeout_ms)?;
        validate_args(&intent.args)?;
        self.require_trust(
            TrustKind::Script,
            &intent.thread_id,
            &id,
            &asset,
            &intent.source_tags,
        )
        .await?;
        self.gate(
            &intent.thread_id,
            Operation::Script,
            &intent.script_path,
            intent.sandbox_mode,
            &intent.source_tags,
            ExecPolicyAction::Allow,
            intent.allow_network,
            false,
            (
                "script",
                &intent.workspace_root,
                &id,
                sha256(&asset),
                &intent.args,
                &cwd,
                intent.sandbox_mode,
                intent.allow_network,
                &intent.source_tags,
            ),
        )
        .await?;
        self.check_budget()?;
        binding
            .sandbox
            .run(ProcessSpec {
                program: Program::Bun {
                    executable: self.bun.clone(),
                    asset,
                    args: intent.args,
                },
                cwd,
                mode: intent.sandbox_mode,
                network: intent.allow_network,
                timeout,
                stdin: None,
            })
            .await
            .map_err(sandbox_error)
    }

    pub async fn exec_hook(&self, intent: ExecHookIntent) -> L0Result<ExecResult> {
        let binding = self.bound(
            &intent.thread_id,
            &intent.workspace_root,
            SandboxMode::ReadOnly,
        )?;
        let (id, asset) = asset(&binding, &intent.hook_path, TrustKind::Hook)?;
        let timeout = timeout(intent.timeout_ms)?;
        if intent.payload_json.len() > 1024 * 1024 {
            return Err(invalid("hook payload exceeds 1 MiB"));
        }
        serde_json::from_str::<serde_json::Value>(&intent.payload_json)
            .map_err(|_| invalid("invalid hook payload"))?;
        if !matches!(
            intent.event.as_str(),
            "PreToolUse" | "PostToolUse" | "SessionStart"
        ) {
            return Err(invalid("invalid hook event"));
        }
        binding.sandbox.can_run(false).map_err(sandbox_error)?;
        self.require_trust(TrustKind::Hook, &intent.thread_id, &id, &asset, &[])
            .await?;
        self.check_budget()?;
        // Execute the verified bytes; do not reopen the original hook after approval.
        binding
            .sandbox
            .run(ProcessSpec {
                program: Program::Bun {
                    executable: self.bun.clone(),
                    asset,
                    args: vec![intent.event],
                },
                cwd: PathBuf::new(),
                mode: SandboxMode::ReadOnly,
                network: false,
                timeout,
                stdin: Some(intent.payload_json.into_bytes()),
            })
            .await
            .map_err(sandbox_error)
    }

    pub async fn approve_patch(
        &self,
        thread: &str,
        patch: &GitCommitPatchParams,
        tags: &[UntrustedSourceTag],
    ) -> L0Result<()> {
        let mut requires_human = false;
        let mut paths = Vec::new();
        for op in &patch.operations {
            sandbox_os::validate_relative(&op.path).map_err(sandbox_error)?;
            if op.path.contains('\\') {
                return Err(invalid("genome paths must use '/'"));
            }
            requires_human |= is_high_privilege_harness_path(&op.path.to_ascii_lowercase());
            paths.push(op.path.as_str());
        }
        if paths.is_empty() {
            return Err(invalid("empty genome patch"));
        }
        self.gate(
            thread,
            Operation::Proposal,
            &paths.join(", "),
            SandboxMode::ReadOnly,
            tags,
            ExecPolicyAction::Prompt,
            false,
            requires_human,
            ("patch", patch, tags),
        )
        .await?;
        self.check_budget()
    }

    pub async fn commit_patch(
        &self,
        git: &GitStore,
        thread: &str,
        patch: &GitCommitPatchParams,
        tags: &[UntrustedSourceTag],
    ) -> L0Result<GitCommitPatchResult> {
        self.approve_patch(thread, patch, tags).await?;
        git.commit_patch(patch, true)
            .map_err(|error| rpc_error(rpc_error_code::INTERNAL_ERROR, error.to_string()))
    }

    pub async fn approve_revert(&self, target_sha: &str) -> L0Result<()> {
        self.gate(
            "evolution",
            Operation::Proposal,
            target_sha,
            SandboxMode::ReadOnly,
            &[],
            ExecPolicyAction::Prompt,
            false,
            true,
            ("revert", target_sha),
        )
        .await?;
        self.check_budget()
    }

    async fn require_trust(
        &self,
        kind: TrustKind,
        thread: &str,
        id: &str,
        bytes: &[u8],
        tags: &[UntrustedSourceTag],
    ) -> L0Result<()> {
        if self.trust.is_trusted(kind, id, bytes) {
            return Ok(());
        }
        let current = sha256(bytes);
        let previous = self.trust.get(kind, id).and_then(|record| record.sha256);
        let kind_request = if kind == TrustKind::Hook {
            ApprovalRequestKind::HookTrust
        } else {
            ApprovalRequestKind::HighPrivilegeProposal
        };
        let approval = request(
            thread,
            kind_request,
            id,
            tags,
            RiskLevel::High,
            Some(current.clone()),
            previous,
        );
        if (self.approval)(approval).await == ApprovalDecision::Deny {
            return Err(rpc_error(
                rpc_error_code::HOOK_UNTRUSTED,
                "executable is not trusted at its current SHA-256",
            ));
        }
        self.trust
            .trust(kind, id, bytes, &current)
            .map_err(|err| rpc_error(rpc_error_code::HOOK_UNTRUSTED, err.to_string()))?;
        Ok(())
    }
}

fn check_shadow_network(binding: &Binding, requested: bool) -> L0Result<()> {
    if binding.mode == SandboxMode::CowShadow && requested {
        return Err(rpc_error(
            rpc_error_code::SANDBOX_DENIED,
            "shadow workspaces cannot use the network",
        ));
    }
    Ok(())
}

fn asset(binding: &Binding, path: &str, kind: TrustKind) -> L0Result<(String, Vec<u8>)> {
    let prefix = if kind == TrustKind::Hook {
        "hooks/"
    } else {
        "scripts/"
    };
    if let Some(genome) = &binding.genome {
        let name = path.replace('\\', "/");
        sandbox_os::validate_relative(&name).map_err(sandbox_error)?;
        if !name.starts_with(prefix) || !name.ends_with(".ts") {
            return Err(invalid("invalid genome executable path"));
        }
        let data = genome
            .get(&name)
            .ok_or_else(|| invalid("executable absent from the pinned genome"))?;
        return Ok((name, data.as_bytes().to_vec()));
    }
    let (path, bytes) = binding.sandbox.read_asset(path).map_err(sandbox_error)?;
    let name = path.to_string_lossy().replace('\\', "/");
    if !name.starts_with(prefix) || !name.ends_with(".ts") {
        return Err(invalid("invalid workspace executable path"));
    }
    Ok((
        format!("workspace:{}:{name}", binding.workspace_root),
        bytes,
    ))
}

fn validate_args(args: &[String]) -> L0Result<()> {
    if args.len() > 256
        || args.iter().any(|arg| arg.contains('\0'))
        || args.iter().map(String::len).sum::<usize>() > 24_000
    {
        return Err(invalid("invalid sandbox arguments"));
    }
    Ok(())
}

fn timeout(ms: u64) -> L0Result<Duration> {
    if !(1..=300_000).contains(&ms) {
        return Err(invalid("timeout must be 1–300000 ms"));
    }
    Ok(Duration::from_millis(ms))
}

fn request(
    thread: &str,
    kind: ApprovalRequestKind,
    command_or_path: &str,
    tags: &[UntrustedSourceTag],
    risk_level: RiskLevel,
    sha256: Option<String>,
    previous_sha256: Option<String>,
) -> ApprovalRequest {
    ApprovalRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        thread_id: thread.into(),
        kind,
        summary: format!("Review {command_or_path}"),
        detail: "The operation requires human approval".into(),
        command_or_path: command_or_path.into(),
        risk_level,
        sha256,
        previous_sha256,
        source_tags: tags.to_vec(),
        created_at: Utc::now().to_rfc3339(),
    }
}

fn file_result(started: Instant) -> ExecResult {
    ExecResult {
        ok: true,
        exit_code: 0,
        stdout: String::new(),
        stderr: String::new(),
        duration_ms: started.elapsed().as_millis() as u64,
        sandbox_backend: "capability-filesystem".into(),
        denied_reason: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn workspace_wall_precedes_guardian_and_human_and_budget_precedes_write() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("work");
        std::fs::create_dir(&root).unwrap();
        let root = root.to_str().unwrap().to_owned();
        let trust = Arc::new(TrustStore::open(dir.path().join("trust.json")).unwrap());
        let budget = Arc::new(Budget::open(dir.path().join("budget.json")).unwrap());
        let prompted = Arc::new(AtomicUsize::new(0));
        let handler = Arc::new({
            let prompted = prompted.clone();
            move |_: ApprovalRequest| -> DecisionFuture {
                prompted.fetch_add(1, Ordering::Relaxed);
                Box::pin(async { ApprovalDecision::AllowOnce })
            }
        });
        let exec = Executor::new(trust, budget.clone(), PathBuf::new(), handler);
        exec.set_mode(RsiMode::Auto);
        exec.bind_workspace("thread", root.clone(), SandboxMode::WorkspaceWrite, None)
            .unwrap();
        let intent = |path: &str| ExecWriteFileIntent {
            thread_id: "thread".into(),
            workspace_root: root.clone(),
            target_path: path.into(),
            content: "content".into(),
            sandbox_mode: SandboxMode::WorkspaceWrite,
            source_tags: vec![UntrustedSourceTag::ExternalFile],
        };
        for path in [
            "../outside",
            ".git/config",
            ".ssh/key",
            ".harnex/harness/HEAD",
            "src-tauri/main.rs",
            "trust.json",
        ] {
            assert_eq!(
                exec.exec_write_file(intent(path)).await.unwrap_err().code,
                rpc_error_code::SANDBOX_DENIED
            );
        }
        assert_eq!(prompted.load(Ordering::Relaxed), 0);
        assert!(exec.guardian_decisions().is_empty());
        budget.update_limit(0.0, 5).unwrap();
        assert_eq!(
            exec.exec_write_file(intent("result.txt"))
                .await
                .unwrap_err()
                .code,
            rpc_error_code::BUDGET_EXCEEDED
        );
        assert_eq!(prompted.load(Ordering::Relaxed), 1);
        assert!(!Path::new(&root).join("result.txt").exists());
    }
}
