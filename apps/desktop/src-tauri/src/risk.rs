//! Pure, deterministic, language-independent L0 risk classification over trusted
//! execution parameters only (never model-provided hints or free-text rationales).

use crate::{
    guardian::Operation,
    protocol::{
        is_high_privilege_harness_path, is_immutable_l0_path, ExecPolicyAction, RiskLevel,
        RiskReasonCode, UntrustedSourceTag,
    },
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskAssessment {
    pub risk_level: RiskLevel,
    pub reason_code: RiskReasonCode,
}

impl RiskAssessment {
    pub const fn new(risk_level: RiskLevel, reason_code: RiskReasonCode) -> Self {
        Self {
            risk_level,
            reason_code,
        }
    }

    /// Monotonically combine two assessments by always keeping the highest severity.
    /// When severities are equal, `self` (the earlier/higher-priority signal) wins.
    pub fn escalate(self, candidate: Self) -> Self {
        if candidate.risk_level > self.risk_level {
            candidate
        } else {
            self
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct OperationContext<'a> {
    pub operation: Operation,
    pub command_or_path: &'a str,
    pub args: &'a [String],
    pub policy: ExecPolicyAction,
    pub allow_network: bool,
    pub env_non_empty: bool,
    pub inside_sandbox: bool,
    pub source_tags: &'a [UntrustedSourceTag],
    pub needs_human_trust: bool,
    pub high_privilege: bool,
}

fn normalized_command_name(command: &str) -> String {
    let base = command
        .trim()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(command)
        .to_ascii_lowercase();
    base.strip_suffix(".exe")
        .or_else(|| base.strip_suffix(".cmd"))
        .or_else(|| base.strip_suffix(".bat"))
        .or_else(|| base.strip_suffix(".com"))
        .unwrap_or(&base)
        .to_owned()
}

fn has_unclosed_quote(text: &str) -> bool {
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    for ch in text.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' && !in_single {
            escaped = true;
            continue;
        }
        match ch {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            _ => (),
        }
    }
    in_single || in_double
}

fn has_shell_syntax(text: &str) -> bool {
    text.chars()
        .any(|c| matches!(c, '$' | '`' | ';' | '|' | '&' | '>' | '<' | '\n' | '\r'))
        || has_unclosed_quote(text)
}

fn path_token_is_protected(token: &str, check_system_roots: bool) -> bool {
    let trimmed = token.trim().trim_matches(['"', '\'']);
    if trimmed.is_empty() {
        return false;
    }
    let norm = trimmed.replace('\\', "/");
    let lower = norm.to_ascii_lowercase();

    // Parent traversal or sensitive dot-directories anywhere in path segments.
    if lower
        .split('/')
        .any(|seg| matches!(seg, ".." | ".git" | ".ssh" | ".gnupg"))
    {
        return true;
    }

    // Immutable L0 paths (relative or nested).
    if is_immutable_l0_path(&lower) {
        return true;
    }

    if check_system_roots {
        if lower == "/etc"
            || lower.starts_with("/etc/")
            || lower == "/usr"
            || lower.starts_with("/usr/")
            || lower == "/system"
            || lower.starts_with("/system/")
            || lower == "c:/windows"
            || lower.starts_with("c:/windows/")
        {
            return true;
        }
    }

    false
}

fn is_protected_arg(arg: &str) -> bool {
    if path_token_is_protected(arg, true) {
        return true;
    }
    if let Some((_, value)) = arg.split_once('=') {
        if path_token_is_protected(value, true) {
            return true;
        }
    }
    false
}

fn is_protected_path(path: &str) -> bool {
    path_token_is_protected(path, true)
}

fn is_interpreter(name: &str) -> bool {
    matches!(
        name,
        "sh" | "bash"
            | "zsh"
            | "cmd"
            | "powershell"
            | "pwsh"
            | "python"
            | "python3"
            | "node"
            | "bun"
            | "perl"
            | "ruby"
            | "eval"
            | "exec"
            | "xargs"
    )
}

fn interpreter_inline_exec(name: &str, args: &[String]) -> bool {
    if matches!(name, "eval" | "exec") {
        return true;
    }
    args.iter().any(|arg| {
        let lower = arg.to_ascii_lowercase();
        match name {
            "sh" | "bash" | "zsh" => lower == "-c" || lower == "-lc",
            "cmd" => lower == "/c" || lower == "/k",
            "powershell" | "pwsh" => matches!(
                lower.as_str(),
                "-c" | "-command" | "-enc" | "-encodedcommand" | "-e"
            ),
            "python" | "python3" => lower == "-c",
            "node" | "bun" | "perl" | "ruby" => matches!(lower.as_str(), "-e" | "--eval" | "-c"),
            _ => false,
        }
    })
}

fn classify_deletion(name: &str, args: &[String]) -> Option<RiskLevel> {
    let lower_args: Vec<String> = args.iter().map(|a| a.to_ascii_lowercase()).collect();
    match name {
        "rm" => {
            let destructive = lower_args.iter().any(|arg| {
                arg == "--recursive"
                    || arg == "--force"
                    || (arg.starts_with('-')
                        && !arg.starts_with("--")
                        && arg.chars().skip(1).any(|c| matches!(c, 'r' | 'f')))
            });
            Some(if destructive {
                RiskLevel::Critical
            } else {
                RiskLevel::High
            })
        }
        "rmdir" | "del" | "erase" | "remove-item" => {
            let destructive = lower_args.iter().any(|arg| {
                matches!(
                    arg.as_str(),
                    "/s" | "/q" | "/f" | "-recurse" | "-force" | "-r" | "-f" | "-rf"
                )
            });
            Some(if destructive {
                RiskLevel::Critical
            } else {
                RiskLevel::High
            })
        }
        "git" => {
            // Find the first non-flag subcommand token (skipping e.g. `-C <dir>`).
            let mut iter = lower_args.iter();
            let mut subcommand: Option<&str> = None;
            while let Some(arg) = iter.next() {
                if arg == "-c" || arg == "--git-dir" || arg == "--work-tree" {
                    let _ = iter.next();
                    continue;
                }
                if arg.starts_with('-') {
                    continue;
                }
                subcommand = Some(arg.as_str());
                break;
            }
            match subcommand {
                Some("clean") => {
                    let force = lower_args.iter().any(|a| {
                        a == "--force"
                            || (a.starts_with('-')
                                && !a.starts_with("--")
                                && a.chars().skip(1).any(|c| c == 'f'))
                    });
                    Some(if force {
                        RiskLevel::Critical
                    } else {
                        RiskLevel::High
                    })
                }
                Some("reset") if lower_args.iter().any(|a| a == "--hard") => {
                    Some(RiskLevel::Critical)
                }
                Some("push")
                    if lower_args.iter().any(|a| {
                        a == "--force" || a == "-f" || a == "--force-with-lease"
                    }) =>
                {
                    Some(RiskLevel::Critical)
                }
                _ => None,
            }
        }
        _ => None,
    }
}

fn is_network_tool(name: &str) -> bool {
    matches!(
        name,
        "curl"
            | "wget"
            | "ssh"
            | "scp"
            | "sftp"
            | "rsync"
            | "nc"
            | "ncat"
            | "invoke-webrequest"
            | "invoke-restmethod"
    )
}

/// Pure static inspection of a shell command and its arguments.
/// Always monotonically retains the maximum risk severity across all detected signals.
pub fn classify_shell_command(
    command: &str,
    args: &[String],
    allow_network: bool,
    env_non_empty: bool,
) -> RiskAssessment {
    let mut assessment = RiskAssessment::new(RiskLevel::Low, RiskReasonCode::PolicyPrompt);
    let name = normalized_command_name(command);

    // 1. Shell metacharacters, command substitution, pipes, redirects, or unclosed quotes.
    if has_shell_syntax(command) || args.iter().any(|arg| has_shell_syntax(arg)) {
        assessment = assessment.escalate(RiskAssessment::new(
            RiskLevel::Critical,
            RiskReasonCode::ShellSyntax,
        ));
    }

    // 2. Protected system/security paths in arguments or traversal/secret paths in command.
    if path_token_is_protected(command, false) || args.iter().any(|arg| is_protected_arg(arg)) {
        assessment = assessment.escalate(RiskAssessment::new(
            RiskLevel::Critical,
            RiskReasonCode::ProtectedPath,
        ));
    }

    // 3. Interpreters and inline code execution.
    if is_interpreter(&name) {
        let level = if interpreter_inline_exec(&name, args) {
            RiskLevel::Critical
        } else {
            RiskLevel::High
        };
        assessment =
            assessment.escalate(RiskAssessment::new(level, RiskReasonCode::InterpreterExecution));
    }

    // 4. Destructive / file deletion commands.
    if let Some(level) = classify_deletion(&name, args) {
        assessment = assessment.escalate(RiskAssessment::new(level, RiskReasonCode::FileDeletion));
    }

    // 5. Network tools or explicit network permission.
    if allow_network || is_network_tool(&name) {
        assessment = assessment.escalate(RiskAssessment::new(
            RiskLevel::High,
            RiskReasonCode::NetworkAccess,
        ));
    }

    // 6. Permission/ownership mutation tools or custom environment overrides.
    if matches!(name.as_str(), "chmod" | "chown") || env_non_empty {
        assessment = assessment.escalate(RiskAssessment::new(
            RiskLevel::High,
            RiskReasonCode::PolicyPrompt,
        ));
    }

    assessment
}

/// Pure static inspection of any L0 operation over trusted parameters.
/// Guarantees risk monotonicity: higher-severity signals can never be downgraded.
pub fn classify_operation(ctx: &OperationContext<'_>) -> RiskAssessment {
    let mut assessment = RiskAssessment::new(RiskLevel::Low, RiskReasonCode::PolicyPrompt);

    // Highest-priority L0 security boundaries.
    if !ctx.inside_sandbox {
        assessment = assessment.escalate(RiskAssessment::new(
            RiskLevel::Critical,
            RiskReasonCode::SandboxEscape,
        ));
    }

    if ctx.policy == ExecPolicyAction::Forbidden {
        assessment = assessment.escalate(RiskAssessment::new(
            RiskLevel::Critical,
            RiskReasonCode::ForbiddenPolicy,
        ));
    }

    // Operation-specific inspection.
    match ctx.operation {
        Operation::Shell => {
            let shell = classify_shell_command(
                ctx.command_or_path,
                ctx.args,
                ctx.allow_network,
                ctx.env_non_empty,
            );
            assessment = assessment.escalate(shell);
        }
        Operation::Delete => {
            if is_protected_path(ctx.command_or_path) {
                assessment = assessment.escalate(RiskAssessment::new(
                    RiskLevel::Critical,
                    RiskReasonCode::ProtectedPath,
                ));
            }
            assessment = assessment.escalate(RiskAssessment::new(
                RiskLevel::High,
                RiskReasonCode::FileDeletion,
            ));
        }
        Operation::Write => {
            if is_protected_path(ctx.command_or_path) {
                assessment = assessment.escalate(RiskAssessment::new(
                    RiskLevel::Critical,
                    RiskReasonCode::ProtectedPath,
                ));
            }
        }
        Operation::Hook => {
            if is_protected_path(ctx.command_or_path) {
                assessment = assessment.escalate(RiskAssessment::new(
                    RiskLevel::Critical,
                    RiskReasonCode::ProtectedPath,
                ));
            }
            if ctx.needs_human_trust {
                assessment = assessment.escalate(RiskAssessment::new(
                    RiskLevel::High,
                    RiskReasonCode::HookUntrusted,
                ));
            }
        }
        Operation::Script => {
            if is_protected_path(ctx.command_or_path) {
                assessment = assessment.escalate(RiskAssessment::new(
                    RiskLevel::Critical,
                    RiskReasonCode::ProtectedPath,
                ));
            }
            if ctx.needs_human_trust {
                assessment = assessment.escalate(RiskAssessment::new(
                    RiskLevel::High,
                    RiskReasonCode::HighPrivilegeProposal,
                ));
            }
        }
        Operation::Proposal => {
            for segment in ctx.command_or_path.split(',') {
                let candidate = segment.trim();
                if candidate.is_empty() {
                    continue;
                }
                if is_protected_path(candidate) {
                    assessment = assessment.escalate(RiskAssessment::new(
                        RiskLevel::Critical,
                        RiskReasonCode::ProtectedPath,
                    ));
                }
                if is_high_privilege_harness_path(&candidate.to_ascii_lowercase()) {
                    assessment = assessment.escalate(RiskAssessment::new(
                        RiskLevel::High,
                        RiskReasonCode::HighPrivilegeProposal,
                    ));
                }
            }
        }
    }

    // Cross-cutting trusted signals (never downgrade an already-higher risk).
    if ctx.needs_human_trust {
        let reason = if matches!(ctx.operation, Operation::Hook) {
            RiskReasonCode::HookUntrusted
        } else {
            RiskReasonCode::HighPrivilegeProposal
        };
        assessment = assessment.escalate(RiskAssessment::new(RiskLevel::High, reason));
    }

    if ctx.high_privilege {
        assessment = assessment.escalate(RiskAssessment::new(
            RiskLevel::High,
            RiskReasonCode::HighPrivilegeProposal,
        ));
    }

    if ctx.allow_network {
        assessment = assessment.escalate(RiskAssessment::new(
            RiskLevel::High,
            RiskReasonCode::NetworkAccess,
        ));
    }

    if ctx
        .source_tags
        .iter()
        .any(|tag| *tag != UntrustedSourceTag::Local)
    {
        assessment = assessment.escalate(RiskAssessment::new(
            RiskLevel::High,
            RiskReasonCode::UntrustedSource,
        ));
    }

    if ctx.policy == ExecPolicyAction::Prompt {
        assessment = assessment.escalate(RiskAssessment::new(
            RiskLevel::Medium,
            RiskReasonCode::PolicyPrompt,
        ));
    }

    assessment
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    fn base_ctx<'a>(operation: Operation, target: &'a str) -> OperationContext<'a> {
        OperationContext {
            operation,
            command_or_path: target,
            args: &[],
            policy: ExecPolicyAction::Allow,
            allow_network: false,
            env_non_empty: false,
            inside_sandbox: true,
            source_tags: &[],
            needs_human_trust: false,
            high_privilege: false,
        }
    }

    #[test]
    fn classifies_shell_syntax_metacharacters_and_unclosed_quotes_as_critical() {
        for (cmd, args) in [
            ("echo", s(&["$(whoami)"])),
            ("echo", s(&["`id`"])),
            ("echo", s(&["hi; ls"])),
            ("cat", s(&["a.txt | wc"])),
            ("echo", s(&["ok && rm"])),
            ("echo", s(&["hi > out.txt"])),
            ("cat", s(&["< in.txt"])),
            ("echo", s(&["line1\nline2"])),
            ("echo", s(&["line1\rline2"])),
            ("echo", s(&["\"unclosed"])),
            ("echo", s(&["'unclosed"])),
        ] {
            let res = classify_shell_command(cmd, &args, false, false);
            assert_eq!(res.risk_level, RiskLevel::Critical, "cmd={cmd} args={args:?}");
            assert_eq!(res.reason_code, RiskReasonCode::ShellSyntax);
        }
    }

    #[test]
    fn classifies_unix_and_windows_interpreters() {
        for (cmd, args, expected_level) in [
            ("sh", s(&["script.sh"]), RiskLevel::High),
            ("/usr/bin/bash", s(&["-c", "echo hi"]), RiskLevel::Critical),
            ("zsh", s(&["run.zsh"]), RiskLevel::High),
            (r"C:\Windows\System32\cmd.exe", s(&["/c", "dir"]), RiskLevel::Critical),
            ("CMD.EXE", s(&["/k", "echo"]), RiskLevel::Critical),
            ("powershell.exe", s(&["-Command", "Get-ChildItem"]), RiskLevel::Critical),
            ("pwsh", s(&["script.ps1"]), RiskLevel::High),
            ("python", s(&["app.py"]), RiskLevel::High),
            ("python3", s(&["-c", "print(1)"]), RiskLevel::Critical),
            ("node", s(&["index.js"]), RiskLevel::High),
            ("bun", s(&["-e", "1+1"]), RiskLevel::Critical),
            ("perl", s(&["script.pl"]), RiskLevel::High),
            ("ruby", s(&["script.rb"]), RiskLevel::High),
            ("eval", s(&["ls"]), RiskLevel::Critical),
            ("exec", s(&["ls"]), RiskLevel::Critical),
            ("xargs", s(&["echo"]), RiskLevel::High),
        ] {
            let res = classify_shell_command(cmd, &args, false, false);
            assert_eq!(res.risk_level, expected_level, "cmd={cmd} args={args:?}");
            assert_eq!(res.reason_code, RiskReasonCode::InterpreterExecution);
        }
    }

    #[test]
    fn classifies_unix_windows_and_git_deletion_commands() {
        for (cmd, args, expected_level) in [
            ("rm", s(&["temp.txt"]), RiskLevel::High),
            ("/bin/rm", s(&["-rf", "build"]), RiskLevel::Critical),
            ("rmdir", s(&["empty"]), RiskLevel::High),
            ("del", s(&["/q", "temp.txt"]), RiskLevel::Critical),
            ("erase", s(&["temp.txt"]), RiskLevel::High),
            ("Remove-Item", s(&["-Recurse", "build"]), RiskLevel::Critical),
            ("git", s(&["clean", "-fd"]), RiskLevel::Critical),
            ("git", s(&["clean", "-n"]), RiskLevel::High),
            ("git", s(&["reset", "--hard", "HEAD~1"]), RiskLevel::Critical),
            ("git", s(&["push", "--force", "origin", "main"]), RiskLevel::Critical),
        ] {
            let res = classify_shell_command(cmd, &args, false, false);
            assert_eq!(res.risk_level, expected_level, "cmd={cmd} args={args:?}");
            assert_eq!(res.reason_code, RiskReasonCode::FileDeletion);
        }
    }

    #[test]
    fn classifies_network_tools_and_allow_network_flag() {
        for cmd in [
            "curl",
            "wget",
            "ssh",
            "scp",
            "sftp",
            "rsync",
            "nc",
            "ncat",
            "Invoke-WebRequest",
        ] {
            let res = classify_shell_command(cmd, &[], false, false);
            assert_eq!(res.risk_level, RiskLevel::High, "cmd={cmd}");
            assert_eq!(res.reason_code, RiskReasonCode::NetworkAccess);
        }
        let flagged = classify_shell_command("ls", &[], true, false);
        assert_eq!(flagged.risk_level, RiskLevel::High);
        assert_eq!(flagged.reason_code, RiskReasonCode::NetworkAccess);
    }

    #[test]
    fn classifies_protected_paths_across_unix_and_windows() {
        for path in [
            ".git/config",
            "~/.ssh/id_rsa",
            "~/.gnupg/secring.gpg",
            "/etc/passwd",
            "/usr/local/bin/tool",
            "/System/Library/CoreServices",
            r"C:\Windows\System32\drivers\etc\hosts",
            "C:/Windows/win.ini",
            "../outside.txt",
            "--config=/etc/shadow",
        ] {
            let res = classify_shell_command("cat", &s(&[path]), false, false);
            assert_eq!(res.risk_level, RiskLevel::Critical, "path={path}");
            assert_eq!(res.reason_code, RiskReasonCode::ProtectedPath);
        }
    }

    #[test]
    fn enforces_monotonic_maximum_severity_and_never_downgrades() {
        // Critical ProtectedPath + High NetworkAccess + Medium PolicyPrompt + Low base must stay Critical.
        let args = s(&["/etc/passwd"]);
        let mut ctx = base_ctx(Operation::Shell, "curl");
        ctx.args = &args;
        ctx.allow_network = true;
        ctx.policy = ExecPolicyAction::Prompt;
        ctx.source_tags = &[UntrustedSourceTag::Web];
        let res = classify_operation(&ctx);
        assert_eq!(res.risk_level, RiskLevel::Critical);
        assert_eq!(res.reason_code, RiskReasonCode::ProtectedPath);

        // Escalate helper never downgrades Critical -> Low/Medium/High.
        let crit = RiskAssessment::new(RiskLevel::Critical, RiskReasonCode::ShellSyntax);
        assert_eq!(
            crit.escalate(RiskAssessment::new(RiskLevel::Low, RiskReasonCode::PolicyPrompt)),
            crit
        );
        assert_eq!(
            crit.escalate(RiskAssessment::new(RiskLevel::High, RiskReasonCode::NetworkAccess)),
            crit
        );
    }

    #[test]
    fn covers_every_operation_and_reason_code_variant() {
        // SandboxEscape
        let mut ctx = base_ctx(Operation::Write, "out.txt");
        ctx.inside_sandbox = false;
        assert_eq!(
            classify_operation(&ctx),
            RiskAssessment::new(RiskLevel::Critical, RiskReasonCode::SandboxEscape)
        );

        // ForbiddenPolicy
        let mut ctx = base_ctx(Operation::Shell, "sudo");
        ctx.policy = ExecPolicyAction::Forbidden;
        assert_eq!(
            classify_operation(&ctx),
            RiskAssessment::new(RiskLevel::Critical, RiskReasonCode::ForbiddenPolicy)
        );

        // UntrustedSource on Write
        let mut ctx = base_ctx(Operation::Write, "notes.md");
        ctx.source_tags = &[UntrustedSourceTag::ExternalFile];
        assert_eq!(
            classify_operation(&ctx),
            RiskAssessment::new(RiskLevel::High, RiskReasonCode::UntrustedSource)
        );

        // FileDeletion on Operation::Delete
        let mut ctx = base_ctx(Operation::Delete, "draft.txt");
        ctx.policy = ExecPolicyAction::Prompt;
        assert_eq!(
            classify_operation(&ctx),
            RiskAssessment::new(RiskLevel::High, RiskReasonCode::FileDeletion)
        );

        // HookUntrusted on Operation::Hook
        let mut ctx = base_ctx(Operation::Hook, "hooks/trim.ts");
        ctx.needs_human_trust = true;
        assert_eq!(
            classify_operation(&ctx),
            RiskAssessment::new(RiskLevel::High, RiskReasonCode::HookUntrusted)
        );

        // HighPrivilegeProposal on Operation::Proposal & Operation::Script
        let mut ctx = base_ctx(Operation::Proposal, "systemprompt.md");
        ctx.policy = ExecPolicyAction::Prompt;
        assert_eq!(
            classify_operation(&ctx),
            RiskAssessment::new(RiskLevel::High, RiskReasonCode::HighPrivilegeProposal)
        );
        let mut script_ctx = base_ctx(Operation::Script, "scripts/helper.ts");
        script_ctx.needs_human_trust = true;
        assert_eq!(
            classify_operation(&script_ctx),
            RiskAssessment::new(RiskLevel::High, RiskReasonCode::HighPrivilegeProposal)
        );

        // PolicyPrompt on benign Prompt shell command
        let mut ctx = base_ctx(Operation::Shell, "echo");
        ctx.policy = ExecPolicyAction::Prompt;
        assert_eq!(
            classify_operation(&ctx),
            RiskAssessment::new(RiskLevel::Medium, RiskReasonCode::PolicyPrompt)
        );

        // Benign local write stays Low
        let ctx = base_ctx(Operation::Write, "result.txt");
        assert_eq!(
            classify_operation(&ctx),
            RiskAssessment::new(RiskLevel::Low, RiskReasonCode::PolicyPrompt)
        );
    }

    #[test]
    fn risk_reason_codes_serialize_as_expected_snake_case_json() {
        let cases = [
            (RiskReasonCode::SandboxEscape, "\"sandbox_escape\""),
            (RiskReasonCode::ForbiddenPolicy, "\"forbidden_policy\""),
            (RiskReasonCode::ShellSyntax, "\"shell_syntax\""),
            (RiskReasonCode::InterpreterExecution, "\"interpreter_execution\""),
            (RiskReasonCode::FileDeletion, "\"file_deletion\""),
            (RiskReasonCode::NetworkAccess, "\"network_access\""),
            (RiskReasonCode::ProtectedPath, "\"protected_path\""),
            (RiskReasonCode::UntrustedSource, "\"untrusted_source\""),
            (RiskReasonCode::HookUntrusted, "\"hook_untrusted\""),
            (RiskReasonCode::HighPrivilegeProposal, "\"high_privilege_proposal\""),
            (RiskReasonCode::GuardianEscalated, "\"guardian_escalated\""),
            (RiskReasonCode::PolicyPrompt, "\"policy_prompt\""),
        ];
        for (variant, expected) in cases {
            let encoded = serde_json::to_string(&variant).unwrap();
            assert_eq!(encoded, expected);
            let decoded: RiskReasonCode = serde_json::from_str(&encoded).unwrap();
            assert_eq!(decoded, variant);
        }
    }
}
