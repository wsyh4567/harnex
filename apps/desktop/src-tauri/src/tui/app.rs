use crate::protocol::{ApprovalRequest, GuardianDecision, RiskReasonCode};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    path::PathBuf,
    time::Instant,
};

#[derive(Clone, Debug)]
pub struct TuiOptions {
    pub workspace: PathBuf,
    pub mode: String,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub sidecar: Option<PathBuf>,
    pub data_dir: Option<PathBuf>,
}

#[derive(Clone, Debug)]
pub struct ThreadSummary {
    pub id: String,
    pub title: String,
    pub workspace_path: String,
    pub mode: String,
    pub status: String,
    pub pinned_sha: String,
}

#[derive(Clone, Debug)]
pub struct CatalogModel {
    pub provider_id: String,
    pub provider_name: String,
    pub model_id: String,
    pub display_name: String,
}

#[derive(Clone, Debug)]
pub enum TuiActivity {
    Reasoning {
        id: String,
        text: String,
        expanded: bool,
    },
    Tool {
        id: String,
        name: String,
        target: String,
        args_pretty: String,
        status: String,
        exit_code: Option<i32>,
        duration_ms: Option<u64>,
        output: String,
        error: Option<String>,
        truncated: bool,
        expanded: bool,
    },
}

#[derive(Clone, Debug)]
pub enum TuiTurn {
    User {
        text: String,
    },
    Steer {
        text: String,
    },
    System {
        text: String,
        is_error: bool,
    },
    Security(GuardianDecision),
    Assistant {
        id: String,
        activities: Vec<TuiActivity>,
        content: String,
        started_at: Option<Instant>,
        elapsed_ms: Option<u64>,
        running: bool,
        activities_expanded: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SlashCommand {
    Help,
    NewThread,
    ListThreads,
    UseThread(String),
    SetMode(String),
    Effort(Option<String>),
    ListModels,
    SetModel { provider: Option<String>, model: String },
    Budget,
    Pause,
    Resume,
    Steer(String),
    Abort,
    Evolve(Option<String>),
    Clear,
    Quit,
    Unknown(String),
}

pub fn parse_slash_command(raw: &str) -> Option<SlashCommand> {
    let trimmed = raw.trim();
    if !trimmed.starts_with('/') {
        return None;
    }
    let mut parts = trimmed.splitn(2, char::is_whitespace);
    let cmd = parts.next().unwrap_or("").to_ascii_lowercase();
    let arg = parts.next().map(str::trim).unwrap_or("");
    Some(match cmd.as_str() {
        "/help" | "/h" | "/?" => SlashCommand::Help,
        "/new" => SlashCommand::NewThread,
        "/threads" => SlashCommand::ListThreads,
        "/use" if !arg.is_empty() => SlashCommand::UseThread(arg.to_owned()),
        "/mode" if matches!(arg, "ask" | "plan" | "craft") => SlashCommand::SetMode(arg.to_owned()),
        "/effort" => SlashCommand::Effort((!arg.is_empty()).then(|| arg.to_ascii_lowercase())),
        "/models" => SlashCommand::ListModels,
        "/model" if !arg.is_empty() => {
            if let Some((provider, model)) = arg.split_once("::") {
                SlashCommand::SetModel {
                    provider: Some(provider.trim().to_owned()),
                    model: model.trim().to_owned(),
                }
            } else {
                SlashCommand::SetModel {
                    provider: None,
                    model: arg.to_owned(),
                }
            }
        }
        "/budget" => SlashCommand::Budget,
        "/pause" => SlashCommand::Pause,
        "/resume" => SlashCommand::Resume,
        "/steer" if !arg.is_empty() => SlashCommand::Steer(arg.to_owned()),
        "/abort" => SlashCommand::Abort,
        "/evolve" => SlashCommand::Evolve((!arg.is_empty()).then(|| arg.to_owned())),
        "/clear" => SlashCommand::Clear,
        "/quit" | "/exit" | "/q" => SlashCommand::Quit,
        _ => SlashCommand::Unknown(trimmed.to_owned()),
    })
}

pub fn is_valid_reasoning_effort(value: &str) -> bool {
    matches!(value, "auto" | "low" | "medium" | "high")
}

pub fn describe_risk_reason(code: RiskReasonCode) -> (&'static str, &'static str) {
    match code {
        RiskReasonCode::SandboxEscape => (
            "[sandbox_escape]",
            "Action attempts to escape the L0 workspace sandbox",
        ),
        RiskReasonCode::ForbiddenPolicy => (
            "[forbidden_policy]",
            "Blocked by immutable L0 execution policy",
        ),
        RiskReasonCode::ShellSyntax => (
            "[shell_syntax]",
            "Command uses shell metacharacters, pipes, or redirection",
        ),
        RiskReasonCode::InterpreterExecution => (
            "[interpreter_execution]",
            "Invokes a script runtime or inline interpreter",
        ),
        RiskReasonCode::FileDeletion => (
            "[file_deletion]",
            "Deletes or removes workspace files",
        ),
        RiskReasonCode::NetworkAccess => (
            "[network_access]",
            "Requests outbound network access",
        ),
        RiskReasonCode::ProtectedPath => (
            "[protected_path]",
            "Targets a protected system, credential, or immutable L0 path",
        ),
        RiskReasonCode::UntrustedSource => (
            "[untrusted_source]",
            "Triggered under untrusted web, external-file, or MCP taint",
        ),
        RiskReasonCode::HookUntrusted => (
            "[hook_untrusted]",
            "Unverified hook requires explicit human trust",
        ),
        RiskReasonCode::HighPrivilegeProposal => (
            "[high_privilege_proposal]",
            "Modifies high-privilege harness scripts, hooks, or guardrails",
        ),
        RiskReasonCode::GuardianEscalated => (
            "[guardian_escalated]",
            "Guardian reviewer escalated this action for human review",
        ),
        RiskReasonCode::PolicyPrompt => (
            "[policy_prompt]",
            "Execution policy requires human confirmation",
        ),
    }
}

pub fn format_risk_reason(code: Option<RiskReasonCode>) -> Option<String> {
    code.map(|c| {
        let (tag, desc) = describe_risk_reason(c);
        format!("{tag} {desc}")
    })
}

pub fn format_guardian_decision(decision: &GuardianDecision) -> String {
    let verdict = decision.decision.to_ascii_uppercase();
    let mut parts = vec![format!("Guardian [{verdict} · {:?}]", decision.risk_level)];
    if let Some(reason_text) = format_risk_reason(decision.risk_reason_code) {
        parts.push(reason_text);
    }
    let mut detail_parts = Vec::new();
    let target = decision.command_or_path.trim();
    if !target.is_empty() {
        detail_parts.push(target.to_owned());
    }
    let reason = decision.reason.trim();
    if !reason.is_empty() {
        detail_parts.push(reason.to_owned());
    }
    if detail_parts.is_empty() {
        parts.join(" ")
    } else {
        format!("{} — {}", parts.join(" "), detail_parts.join(" · "))
    }
}

pub fn is_command_tool(name: &str) -> bool {
    matches!(name, "shell" | "run_script" | "bash" | "exec")
}

pub fn format_duration_compact(ms: u64) -> String {
    let secs = ms / 1000;
    if secs < 60 {
        format!("{secs}s")
    } else {
        format!("{}m {}s", secs / 60, secs % 60)
    }
}

pub fn summarize_tool_target(name: &str, args: &Value) -> String {
    let str_field = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or("");
    let join_args = || {
        args.get("args")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default()
    };
    match name {
        "shell" => {
            let cmd = str_field("command");
            let extra = join_args();
            if extra.is_empty() {
                cmd.to_owned()
            } else {
                format!("{cmd} {extra}")
            }
        }
        "run_script" => {
            let script = str_field("scriptPath");
            let extra = join_args();
            if extra.is_empty() {
                script.to_owned()
            } else {
                format!("{script} {extra}")
            }
        }
        "read_file" => {
            let path = str_field("path");
            let offset = args.get("offset").and_then(Value::as_u64);
            let limit = args.get("limit").and_then(Value::as_u64);
            match (offset, limit) {
                (Some(o), Some(l)) => format!("{path} (L{o}-{})", o.saturating_add(l).saturating_sub(1)),
                (Some(o), None) => format!("{path} (L{o}+)"),
                (None, Some(l)) => format!("{path} (L1-{l})"),
                (None, None) => path.to_owned(),
            }
        }
        "edit_file" => {
            let path = str_field("path");
            let count = args
                .get("edits")
                .and_then(Value::as_array)
                .map_or(1, Vec::len);
            format!("{path} ({count})")
        }
        "write_file" | "delete_file" | "list_files" => str_field("path").to_owned(),
        "find_files" => {
            let pat = str_field("pattern");
            let path = str_field("path");
            if !pat.is_empty() && !path.is_empty() && path != "." {
                format!("{pat} · {path}")
            } else if !pat.is_empty() {
                pat.to_owned()
            } else if !path.is_empty() {
                path.to_owned()
            } else {
                ".".to_owned()
            }
        }
        "grep_files" => {
            let query = str_field("query");
            let path = str_field("path");
            if !path.is_empty() && path != "." {
                format!("\"{query}\" in {path}")
            } else {
                format!("\"{query}\"")
            }
        }
        "set_goals" => {
            let count = args
                .get("goals")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            format!("{count} goals")
        }
        "web_fetch" => summarize_url_host_path(str_field("url")),
        "delegate_subagent" => {
            let profile = normalize_subagent_profile(str_field("profile"));
            let task = summarize_compact_text(str_field("task"), 60);
            match (!profile.is_empty(), !task.is_empty()) {
                (true, true) => format!("@{profile} · {task}"),
                (true, false) => format!("@{profile}"),
                (false, true) => task,
                (false, false) => String::new(),
            }
        }
        _ => {
            let compact = serde_json::to_string(args).unwrap_or_default();
            if compact == "{}" {
                String::new()
            } else {
                compact
            }
        }
    }
}

pub struct App {
    pub workspace: String,
    pub mode: String,
    pub reasoning_effort: String,
    pub active_thread_id: Option<String>,
    pub active_thread_title: Option<String>,
    pub pinned_sha: String,
    pub sidecar_alive: bool,
    pub sandbox_backend: String,
    pub budget_spent: f64,
    pub budget_limit: f64,
    pub model_override: Option<String>,
    pub provider_override: Option<String>,
    pub default_model_label: String,
    pub catalog: Vec<CatalogModel>,
    pub threads: Vec<ThreadSummary>,
    pub turns: Vec<TuiTurn>,
    pub approvals: VecDeque<ApprovalRequest>,
    pub guardian_decisions: VecDeque<GuardianDecision>,
    pub input: String,
    pub cursor_char: usize,
    pub input_history: Vec<String>,
    pub history_cursor: Option<usize>,
    pub draft_before_history: String,
    pub scroll_from_bottom: u16,
    pub reasoning_expanded: bool,
    pub tools_expanded: bool,
    pub is_running: bool,
    pub is_paused: bool,
    pub spinner_tick: usize,
    pub status_hint: String,
    pub should_quit: bool,
}

impl App {
    pub fn new(options: &TuiOptions) -> Self {
        Self {
            workspace: options.workspace.to_string_lossy().into_owned(),
            mode: options.mode.clone(),
            reasoning_effort: "auto".into(),
            active_thread_id: None,
            active_thread_title: None,
            pinned_sha: "-------".into(),
            sidecar_alive: false,
            sandbox_backend: "detecting".into(),
            budget_spent: 0.0,
            budget_limit: 5.0,
            model_override: options.model.clone(),
            provider_override: options.provider.clone(),
            default_model_label: "solver".into(),
            catalog: Vec::new(),
            threads: Vec::new(),
            turns: Vec::new(),
            approvals: VecDeque::new(),
            guardian_decisions: VecDeque::new(),
            input: String::new(),
            cursor_char: 0,
            input_history: Vec::new(),
            history_cursor: None,
            draft_before_history: String::new(),
            scroll_from_bottom: 0,
            reasoning_expanded: true,
            tools_expanded: false,
            is_running: false,
            is_paused: false,
            spinner_tick: 0,
            status_hint: "Booting L0 Sandbox & Sidecar...".into(),
            should_quit: false,
        }
    }

    pub fn active_model_display(&self) -> String {
        match (&self.provider_override, &self.model_override) {
            (Some(p), Some(m)) => format!("{p}::{m}"),
            (None, Some(m)) => m.clone(),
            _ => self.default_model_label.clone(),
        }
    }

    pub fn push_system(&mut self, text: impl Into<String>, is_error: bool) {
        self.turns.push(TuiTurn::System {
            text: text.into(),
            is_error,
        });
        self.scroll_from_bottom = 0;
    }

    pub fn cycle_mode(&mut self) {
        self.mode = match self.mode.as_str() {
            "craft" => "plan".into(),
            "plan" => "ask".into(),
            _ => "craft".into(),
        };
        self.status_hint = format!("Mode switched to [{}]", self.mode);
    }

    pub fn set_reasoning_effort(&mut self, raw: &str) -> Result<String, String> {
        let normalized = raw.trim().to_ascii_lowercase();
        if !is_valid_reasoning_effort(&normalized) {
            return Err(format!(
                "Invalid reasoning effort '{}'. Usage: /effort <auto|low|medium|high>",
                raw.trim()
            ));
        }
        self.reasoning_effort = normalized.clone();
        self.status_hint = format!("Reasoning effort set to [{}]", self.reasoning_effort);
        Ok(normalized)
    }

    pub fn build_runner_start_params(&self, thread_id: &str, prompt: &str) -> Value {
        let mut params = json!({
            "threadId": thread_id,
            "prompt": prompt,
            "mode": self.mode,
            "reasoningEffort": self.reasoning_effort,
        });
        if let Some(model) = &self.model_override {
            params["modelOverride"] = json!(model);
        }
        if let Some(provider) = &self.provider_override {
            params["providerIdOverride"] = json!(provider);
        }
        params
    }

    pub fn record_guardian_decision(&mut self, decision: GuardianDecision) -> bool {
        let already_seen = self.guardian_decisions.iter().any(|existing| {
            existing.request_id == decision.request_id && existing.timestamp == decision.timestamp
        });
        if already_seen {
            return false;
        }
        if self.guardian_decisions.len() >= 100 {
            self.guardian_decisions.pop_front();
        }
        self.guardian_decisions.push_back(decision.clone());

        let matches_thread = self
            .active_thread_id
            .as_deref()
            .map_or(true, |active| active == decision.thread_id);
        if matches_thread {
            let reason_tag = decision
                .risk_reason_code
                .map(|c| format!(" {}", describe_risk_reason(c).0))
                .unwrap_or_default();
            self.status_hint = format!(
                "Guardian [{}]{}: {}",
                decision.decision.to_ascii_uppercase(),
                reason_tag,
                decision.reason
            );
            self.turns.push(TuiTurn::Security(decision));
            self.scroll_from_bottom = 0;
        }
        true
    }

    pub fn sync_guardian_decisions(&mut self, decisions: &[GuardianDecision]) {
        for decision in decisions {
            self.record_guardian_decision(decision.clone());
        }
    }

    pub fn toggle_reasoning(&mut self) {
        self.reasoning_expanded = !self.reasoning_expanded;
        for turn in &mut self.turns {
            if let TuiTurn::Assistant {
                activities,
                activities_expanded,
                ..
            } = turn
            {
                if self.reasoning_expanded && activities.iter().any(|a| matches!(a, TuiActivity::Reasoning { .. })) {
                    *activities_expanded = true;
                }
                for act in activities {
                    if let TuiActivity::Reasoning { expanded, .. } = act {
                        *expanded = self.reasoning_expanded;
                    }
                }
            }
        }
        self.status_hint = if self.reasoning_expanded {
            "Reasoning traces expanded (Ctrl+T)".into()
        } else {
            "Reasoning traces collapsed (Ctrl+T)".into()
        };
    }

    pub fn toggle_tools(&mut self) {
        self.tools_expanded = !self.tools_expanded;
        for turn in &mut self.turns {
            if let TuiTurn::Assistant {
                activities,
                activities_expanded,
                running,
                ..
            } = turn
            {
                *activities_expanded = self.tools_expanded || *activities_expanded;
                for act in activities {
                    if let TuiActivity::Tool { expanded, .. } = act {
                        *expanded = self.tools_expanded;
                    }
                }
                if !self.tools_expanded && !*running {
                    *activities_expanded = false;
                }
            }
        }
        self.status_hint = if self.tools_expanded {
            "Tool execution details expanded (Ctrl+O)".into()
        } else {
            "Tool execution details collapsed (Ctrl+O)".into()
        };
    }

    pub fn insert_char(&mut self, c: char) {
        let byte_idx = char_to_byte_idx(&self.input, self.cursor_char);
        self.input.insert(byte_idx, c);
        self.cursor_char += 1;
    }

    pub fn backspace(&mut self) {
        if self.cursor_char == 0 {
            return;
        }
        let end = char_to_byte_idx(&self.input, self.cursor_char);
        let start = char_to_byte_idx(&self.input, self.cursor_char - 1);
        self.input.replace_range(start..end, "");
        self.cursor_char -= 1;
    }

    pub fn delete_char(&mut self) {
        let len = self.input.chars().count();
        if self.cursor_char >= len {
            return;
        }
        let start = char_to_byte_idx(&self.input, self.cursor_char);
        let end = char_to_byte_idx(&self.input, self.cursor_char + 1);
        self.input.replace_range(start..end, "");
    }

    pub fn move_cursor_left(&mut self) {
        self.cursor_char = self.cursor_char.saturating_sub(1);
    }

    pub fn move_cursor_right(&mut self) {
        let len = self.input.chars().count();
        if self.cursor_char < len {
            self.cursor_char += 1;
        }
    }

    pub fn clear_input(&mut self) {
        self.input.clear();
        self.cursor_char = 0;
        self.history_cursor = None;
    }

    pub fn delete_prev_word(&mut self) {
        if self.cursor_char == 0 {
            return;
        }
        let chars: Vec<char> = self.input.chars().collect();
        let mut start = self.cursor_char;
        while start > 0 && chars[start - 1].is_whitespace() {
            start -= 1;
        }
        while start > 0 && !chars[start - 1].is_whitespace() {
            start -= 1;
        }
        let start_byte = char_to_byte_idx(&self.input, start);
        let end_byte = char_to_byte_idx(&self.input, self.cursor_char);
        self.input.replace_range(start_byte..end_byte, "");
        self.cursor_char = start;
    }

    pub fn history_prev(&mut self) {
        if self.input_history.is_empty() {
            return;
        }
        let next_idx = match self.history_cursor {
            None => {
                self.draft_before_history = self.input.clone();
                self.input_history.len() - 1
            }
            Some(0) => 0,
            Some(idx) => idx - 1,
        };
        self.history_cursor = Some(next_idx);
        self.input = self.input_history[next_idx].clone();
        self.cursor_char = self.input.chars().count();
    }

    pub fn history_next(&mut self) {
        let Some(idx) = self.history_cursor else {
            return;
        };
        if idx + 1 >= self.input_history.len() {
            self.history_cursor = None;
            self.input = std::mem::take(&mut self.draft_before_history);
        } else {
            let next_idx = idx + 1;
            self.history_cursor = Some(next_idx);
            self.input = self.input_history[next_idx].clone();
        }
        self.cursor_char = self.input.chars().count();
    }

    pub fn take_input(&mut self) -> String {
        self.cursor_char = 0;
        self.history_cursor = None;
        self.draft_before_history.clear();
        let taken = std::mem::take(&mut self.input);
        let trimmed = taken.trim();
        if !trimmed.is_empty() && self.input_history.last().map(String::as_str) != Some(trimmed) {
            self.input_history.push(trimmed.to_owned());
            if self.input_history.len() > 100 {
                self.input_history.remove(0);
            }
        }
        taken
    }

    pub fn load_messages(&mut self, messages: &[Value]) {
        self.turns.clear();
        for msg in messages {
            let role = msg.get("role").and_then(Value::as_str).unwrap_or("");
            if role == "tool" || role == "system" {
                continue;
            }
            let content = msg
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            if role == "user" {
                self.turns.push(TuiTurn::User { text: content });
                continue;
            }
            if role == "steer" {
                self.turns.push(TuiTurn::Steer { text: content });
                continue;
            }
            // Merge consecutive assistant steps into one unified turn
            let id = msg
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("msg")
                .to_owned();
            let reasoning = msg
                .get("reasoning")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
            let tool_calls = msg
                .get("toolCalls")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();

            let append_to_existing = matches!(self.turns.last(), Some(TuiTurn::Assistant { .. }));
            if !append_to_existing {
                self.turns.push(TuiTurn::Assistant {
                    id: id.clone(),
                    activities: Vec::new(),
                    content: String::new(),
                    started_at: None,
                    elapsed_ms: None,
                    running: false,
                    activities_expanded: self.tools_expanded,
                });
            }
            if let Some(TuiTurn::Assistant {
                activities,
                content: turn_content,
                ..
            }) = self.turns.last_mut()
            {
                if let Some(text) = reasoning {
                    activities.push(TuiActivity::Reasoning {
                        id: format!("{id}-reason"),
                        text,
                        expanded: false,
                    });
                }
                for tc in tool_calls {
                    activities.push(activity_from_tool_json(&tc, self.tools_expanded));
                }
                let trimmed = content.trim();
                if !trimmed.is_empty() {
                    if !turn_content.is_empty() {
                        turn_content.push_str("\n\n");
                    }
                    turn_content.push_str(trimmed);
                }
            }
        }
        let active_tid = self.active_thread_id.as_deref();
        for decision in &self.guardian_decisions {
            if active_tid.map_or(true, |tid| tid == decision.thread_id) {
                self.turns.push(TuiTurn::Security(decision.clone()));
            }
        }
        self.scroll_from_bottom = 0;
    }

    pub fn apply_event(&mut self, event: &Value) {
        let Some(kind) = event.get("type").and_then(Value::as_str) else {
            return;
        };
        let event_thread = event.get("threadId").and_then(Value::as_str);
        if matches!(
            kind,
            "runner.started"
                | "runner.token"
                | "runner.tool_call"
                | "runner.tool_result"
                | "runner.paused"
                | "runner.steered"
                | "runner.completed"
                | "runner.error"
        ) {
            if let (Some(active), Some(ev_t)) = (self.active_thread_id.as_deref(), event_thread) {
                if active != ev_t {
                    return;
                }
            }
        }

        match kind {
            "runner.started" => {
                let run_id = event
                    .get("runId")
                    .and_then(Value::as_str)
                    .unwrap_or("run")
                    .to_owned();
                if let Some(sha) = event.get("pinnedCommitSha").and_then(Value::as_str) {
                    self.pinned_sha = sha.chars().take(7).collect();
                }
                self.is_running = true;
                self.is_paused = false;
                self.status_hint = "Running inside L0 OS Sandbox...".into();
                self.turns.push(TuiTurn::Assistant {
                    id: run_id,
                    activities: Vec::new(),
                    content: String::new(),
                    started_at: Some(Instant::now()),
                    elapsed_ms: None,
                    running: true,
                    activities_expanded: true,
                });
                self.scroll_from_bottom = 0;
            }
            "runner.token" => {
                let delta = event.get("delta").and_then(Value::as_str).unwrap_or("");
                if delta.is_empty() {
                    return;
                }
                let channel = event
                    .get("channel")
                    .and_then(Value::as_str)
                    .unwrap_or("content");
                let turn = self.ensure_running_assistant_turn();
                if let TuiTurn::Assistant {
                    activities,
                    content,
                    ..
                } = turn
                {
                    if channel == "reasoning" {
                        if let Some(TuiActivity::Reasoning { text, .. }) = activities.last_mut() {
                            text.push_str(delta);
                        } else {
                            let idx = activities.len() + 1;
                            activities.push(TuiActivity::Reasoning {
                                id: format!("reason-{idx}"),
                                text: delta.to_owned(),
                                expanded: true,
                            });
                        }
                    } else {
                        content.push_str(delta);
                    }
                }
            }
            "runner.tool_call" => {
                let Some(tc) = event.get("toolCall") else {
                    return;
                };
                let new_act = activity_from_tool_json(tc, self.tools_expanded);
                let new_id = match &new_act {
                    TuiActivity::Tool { id, .. } => id.clone(),
                    _ => return,
                };
                let turn = self.ensure_running_assistant_turn();
                if let TuiTurn::Assistant { activities, .. } = turn {
                    if let Some(existing) = activities.iter_mut().find(|a| {
                        matches!(a, TuiActivity::Tool { id, .. } if id == &new_id)
                    }) {
                        *existing = new_act;
                    } else {
                        activities.push(new_act);
                    }
                }
            }
            "runner.tool_result" => {
                let tool_id = event.get("toolCallId").and_then(Value::as_str).unwrap_or("");
                let output = event.get("output").and_then(Value::as_str).unwrap_or("");
                let error = event
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let exit_code = event.get("exitCode").and_then(Value::as_i64).map(|n| n as i32);
                let duration_ms = event.get("durationMs").and_then(Value::as_u64);
                let truncated = event
                    .get("truncated")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if let Some(TuiTurn::Assistant { activities, .. }) =
                    self.last_active_assistant_turn_mut()
                {
                    for act in activities.iter_mut() {
                        if let TuiActivity::Tool {
                            id,
                            status,
                            output: out,
                            error: err,
                            exit_code: code,
                            duration_ms: dur,
                            truncated: trunc,
                            expanded,
                            ..
                        } = act
                        {
                            if id == tool_id {
                                *status = if error.is_some() {
                                    "failed".into()
                                } else {
                                    "completed".into()
                                };
                                *out = output.to_owned();
                                *err = error.clone();
                                if exit_code.is_some() {
                                    *code = exit_code;
                                }
                                if duration_ms.is_some() {
                                    *dur = duration_ms;
                                }
                                *trunc = truncated;
                                if error.is_some() {
                                    *expanded = true;
                                }
                                break;
                            }
                        }
                    }
                }
            }
            "runner.paused" => {
                self.is_paused = true;
                self.status_hint = "Paused — use /steer <instruction> or /resume".into();
            }
            "runner.steered" => {
                if let Some(instr) = event.get("instruction").and_then(Value::as_str) {
                    self.turns.push(TuiTurn::Steer {
                        text: instr.to_owned(),
                    });
                }
                self.status_hint = "Steer queued for Harness² evolution".into();
            }
            "runner.completed" => {
                self.is_running = false;
                self.is_paused = false;
                let final_out = event
                    .get("finalOutput")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if let Some(TuiTurn::Assistant {
                    content,
                    started_at,
                    elapsed_ms,
                    running,
                    activities,
                    activities_expanded,
                    ..
                }) = self.last_active_assistant_turn_mut()
                {
                    *running = false;
                    if let Some(start) = started_at.take() {
                        *elapsed_ms = Some(start.elapsed().as_millis() as u64);
                    }
                    if content.trim().is_empty() && !final_out.is_empty() {
                        *content = final_out.to_owned();
                    }
                    // Auto-collapse reasoning & completed tool details once done, matching Desktop UX
                    if !self.tools_expanded {
                        *activities_expanded = false;
                    }
                    for act in activities.iter_mut() {
                        if let TuiActivity::Reasoning { expanded, .. } = act {
                            *expanded = false;
                        }
                    }
                }
                self.status_hint = "Completed · Press Ctrl+O for tools, Ctrl+T for reasoning".into();
            }
            "runner.error" => {
                self.is_running = false;
                self.is_paused = false;
                let msg = event
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Runner failed");
                if let Some(TuiTurn::Assistant {
                    running,
                    started_at,
                    elapsed_ms,
                    ..
                }) = self.last_active_assistant_turn_mut()
                {
                    *running = false;
                    if let Some(start) = started_at.take() {
                        *elapsed_ms = Some(start.elapsed().as_millis() as u64);
                    }
                }
                self.push_system(format!("Error: {msg}"), true);
                self.status_hint = format!("Run failed: {msg}");
            }
            "security.approval_required" | "trust.hook_confirm" => {
                if let Some(raw) = event.get("request") {
                    if let Ok(req) = serde_json::from_value::<ApprovalRequest>(raw.clone()) {
                        let reason_tag = req
                            .risk_reason_code
                            .map(|c| format!(" {}", describe_risk_reason(c).0))
                            .unwrap_or_default();
                        self.approvals.push_back(req);
                        self.status_hint = format!(
                            "L0 approval required{reason_tag} — press [A] Allow Once, [S] Session, [D] Deny"
                        );
                    }
                }
            }
            "security.approval_resolved" => {
                if let Some(id) = event.get("requestId").and_then(Value::as_str) {
                    self.approvals.retain(|req| req.request_id != id);
                }
            }
            "guardian.decision" => {
                if let Some(raw) = event.get("decision") {
                    if let Ok(decision) = serde_json::from_value::<GuardianDecision>(raw.clone()) {
                        self.record_guardian_decision(decision);
                    }
                }
            }
            _ => {}
        }
    }

    fn last_active_assistant_turn_mut(&mut self) -> Option<&mut TuiTurn> {
        let idx = self.turns.iter().rposition(|turn| {
            matches!(turn, TuiTurn::Assistant { running: true, .. })
        });
        if let Some(i) = idx {
            return self.turns.get_mut(i);
        }
        self.turns
            .iter_mut()
            .rev()
            .find(|turn| matches!(turn, TuiTurn::Assistant { .. }))
    }

    fn ensure_running_assistant_turn(&mut self) -> &mut TuiTurn {
        let existing_idx = self.turns.iter().enumerate().rev().find_map(|(i, turn)| {
            match turn {
                TuiTurn::Assistant { running: true, .. } => Some(Some(i)),
                TuiTurn::Security(_) | TuiTurn::System { .. } => None,
                _ => Some(None),
            }
        });
        if let Some(Some(idx)) = existing_idx {
            return &mut self.turns[idx];
        }
        self.turns.push(TuiTurn::Assistant {
            id: "live".into(),
            activities: Vec::new(),
            content: String::new(),
            started_at: Some(Instant::now()),
            elapsed_ms: None,
            running: true,
            activities_expanded: true,
        });
        self.turns.last_mut().unwrap()
    }
}

fn summarize_url_host_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let without_scheme = trimmed
        .split_once("://")
        .map_or(trimmed, |(_, rest)| rest);
    let without_frag = without_scheme
        .split_once('#')
        .map_or(without_scheme, |(head, _)| head);
    let without_query = without_frag
        .split_once('?')
        .map_or(without_frag, |(head, _)| head);
    let (authority, path) = match without_query.find('/') {
        Some(idx) => (&without_query[..idx], &without_query[idx..]),
        None => (without_query, ""),
    };
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, h)| h)
        .trim();
    if host.is_empty() {
        return trimmed.to_owned();
    }
    let clean_path = path.trim_end_matches('/');
    if clean_path.is_empty() {
        host.to_owned()
    } else {
        format!("{host}{clean_path}")
    }
}

fn normalize_subagent_profile(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let base = trimmed
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(trimmed);
    base.strip_suffix(".md")
        .or_else(|| base.strip_suffix(".MD"))
        .unwrap_or(base)
        .trim()
        .to_owned()
}

fn summarize_compact_text(raw: &str, max_chars: usize) -> String {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = collapsed.chars();
    let head: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

fn char_to_byte_idx(s: &str, char_idx: usize) -> usize {
    s.char_indices()
        .nth(char_idx)
        .map_or(s.len(), |(byte_idx, _)| byte_idx)
}

fn activity_from_tool_json(tc: &Value, default_expanded: bool) -> TuiActivity {
    let id = tc.get("id").and_then(Value::as_str).unwrap_or("tool").to_owned();
    let name = tc.get("name").and_then(Value::as_str).unwrap_or("tool").to_owned();
    let args = tc.get("args").cloned().unwrap_or_else(|| serde_json::json!({}));
    let target = summarize_tool_target(&name, &args);
    let args_pretty = serde_json::to_string_pretty(&args).unwrap_or_else(|_| "{}".into());
    let status = tc
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("running")
        .to_owned();
    let exit_code = tc.get("exitCode").and_then(Value::as_i64).map(|n| n as i32);
    let duration_ms = tc.get("durationMs").and_then(Value::as_u64);
    let output = tc
        .get("output")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let error = tc.get("error").and_then(Value::as_str).map(str::to_owned);
    let truncated = tc.get("truncated").and_then(Value::as_bool).unwrap_or(false);
    let expanded = default_expanded || status == "failed" || status == "awaiting_approval";
    TuiActivity::Tool {
        id,
        name,
        target,
        args_pretty,
        status,
        exit_code,
        duration_ms,
        output,
        error,
        truncated,
        expanded,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_opts() -> TuiOptions {
        TuiOptions {
            workspace: PathBuf::from("/tmp/work"),
            mode: "craft".into(),
            model: None,
            provider: None,
            sidecar: None,
            data_dir: None,
        }
    }

    #[test]
    fn slash_command_parser_handles_core_commands() {
        assert_eq!(parse_slash_command("/help"), Some(SlashCommand::Help));
        assert_eq!(parse_slash_command("/mode plan"), Some(SlashCommand::SetMode("plan".into())));
        assert_eq!(
            parse_slash_command("/model magpie::gpt-5"),
            Some(SlashCommand::SetModel {
                provider: Some("magpie".into()),
                model: "gpt-5".into(),
            })
        );
        assert_eq!(
            parse_slash_command("/steer use csv instead"),
            Some(SlashCommand::Steer("use csv instead".into()))
        );
        assert_eq!(parse_slash_command("hello world"), None);
    }

    #[test]
    fn interleaved_streaming_events_build_ordered_activities_and_exit_code() {
        let mut app = App::new(&sample_opts());
        app.active_thread_id = Some("t1".into());
        app.apply_event(&json!({
            "type": "runner.started",
            "threadId": "t1",
            "runId": "r1",
            "pinnedCommitSha": "abcdef123456"
        }));
        app.apply_event(&json!({
            "type": "runner.token",
            "threadId": "t1",
            "runId": "r1",
            "delta": "Thinking first...",
            "channel": "reasoning"
        }));
        app.apply_event(&json!({
            "type": "runner.tool_call",
            "threadId": "t1",
            "runId": "r1",
            "toolCall": {
                "id": "tc1",
                "name": "shell",
                "args": {"command": "bun", "args": ["test"]},
                "status": "running",
                "startedAt": "2026-01-01T00:00:00Z"
            }
        }));
        app.apply_event(&json!({
            "type": "runner.tool_result",
            "threadId": "t1",
            "runId": "r1",
            "toolCallId": "tc1",
            "output": "137 pass",
            "exitCode": 0,
            "durationMs": 320,
            "truncated": false
        }));
        app.apply_event(&json!({
            "type": "runner.token",
            "threadId": "t1",
            "runId": "r1",
            "delta": "All green.",
            "channel": "content"
        }));
        app.apply_event(&json!({
            "type": "runner.completed",
            "threadId": "t1",
            "runId": "r1",
            "finalOutput": "All green."
        }));

        assert!(!app.is_running);
        assert_eq!(app.pinned_sha, "abcdef1");
        let Some(TuiTurn::Assistant {
            activities,
            content,
            activities_expanded,
            ..
        }) = app.turns.last()
        else {
            panic!("expected assistant turn");
        };
        assert_eq!(content, "All green.");
        assert!(!activities_expanded);
        assert_eq!(activities.len(), 2);
        assert!(matches!(&activities[0], TuiActivity::Reasoning { text, .. } if text == "Thinking first..."));
        assert!(matches!(
            &activities[1],
            TuiActivity::Tool { name, target, exit_code: Some(0), output, .. }
            if name == "shell" && target == "bun test" && output == "137 pass"
        ));
    }

    #[test]
    fn unicode_cjk_input_editing_never_splits_multibyte_chars() {
        let mut app = App::new(&sample_opts());
        for c in "分析汽油98#".chars() {
            app.insert_char(c);
        }
        app.move_cursor_left();
        app.backspace();
        app.insert_char('5');
        assert_eq!(app.input, "分析汽油95#");
    }

    #[test]
    fn input_history_and_word_clear_shortcuts_work_cleanly() {
        let mut app = App::new(&sample_opts());
        app.input = "first prompt".into();
        app.cursor_char = app.input.chars().count();
        assert_eq!(app.take_input(), "first prompt");

        app.input = "second prompt".into();
        app.cursor_char = app.input.chars().count();
        assert_eq!(app.take_input(), "second prompt");

        app.input = "draft".into();
        app.cursor_char = app.input.chars().count();
        app.history_prev();
        assert_eq!(app.input, "second prompt");
        app.history_prev();
        assert_eq!(app.input, "first prompt");
        app.history_next();
        assert_eq!(app.input, "second prompt");
        app.history_next();
        assert_eq!(app.input, "draft");

        app.input = "hello world  ".into();
        app.cursor_char = app.input.chars().count();
        app.delete_prev_word();
        assert_eq!(app.input, "hello ");
        app.clear_input();
        assert!(app.input.is_empty());
        assert_eq!(app.cursor_char, 0);
    }

    #[test]
    fn effort_slash_command_validates_updates_and_populates_runner_start_params() {
        assert_eq!(parse_slash_command("/effort"), Some(SlashCommand::Effort(None)));
        assert_eq!(
            parse_slash_command("/effort HIGH"),
            Some(SlashCommand::Effort(Some("high".into())))
        );
        assert_eq!(
            parse_slash_command("/effort turbo"),
            Some(SlashCommand::Effort(Some("turbo".into())))
        );

        let mut app = App::new(&sample_opts());
        assert_eq!(app.reasoning_effort, "auto");
        assert_eq!(
            app.build_runner_start_params("t1", "hi")["reasoningEffort"],
            json!("auto")
        );

        assert_eq!(app.set_reasoning_effort("medium"), Ok("medium".into()));
        assert_eq!(app.reasoning_effort, "medium");
        assert!(app.status_hint.contains("medium"));
        assert_eq!(
            app.build_runner_start_params("t1", "hi")["reasoningEffort"],
            json!("medium")
        );

        let err = app.set_reasoning_effort("ultra").unwrap_err();
        assert!(err.contains("/effort <auto|low|medium|high>"));
        assert_eq!(app.reasoning_effort, "medium");
    }

    #[test]
    fn summarize_tool_target_formats_web_fetch_and_delegate_subagent() {
        assert_eq!(
            summarize_tool_target(
                "web_fetch",
                &json!({"url": "https://docs.rs/ratatui/latest/ratatui/?q=1#top"})
            ),
            "docs.rs/ratatui/latest/ratatui"
        );
        assert_eq!(
            summarize_tool_target("web_fetch", &json!({"url": "https://example.com/"})),
            "example.com"
        );
        assert_eq!(
            summarize_tool_target(
                "web_fetch",
                &json!({"url": "https://user:secret@api.example.com:8443/v1/status"})
            ),
            "api.example.com:8443/v1/status"
        );
        assert_eq!(
            summarize_tool_target(
                "delegate_subagent",
                &json!({
                    "profile": "sub_agents/researcher.md",
                    "task": "Inspect Cargo.toml\n  and list optional features"
                })
            ),
            "@researcher · Inspect Cargo.toml and list optional features"
        );
        assert_eq!(
            summarize_tool_target(
                "delegate_subagent",
                &json!({"profile": "auditor", "task": ""})
            ),
            "@auditor"
        );
    }

    #[test]
    fn risk_reason_codes_and_guardian_decisions_format_and_preserve_active_turn() {
        let all_codes = [
            (RiskReasonCode::SandboxEscape, "[sandbox_escape]"),
            (RiskReasonCode::ForbiddenPolicy, "[forbidden_policy]"),
            (RiskReasonCode::ShellSyntax, "[shell_syntax]"),
            (RiskReasonCode::InterpreterExecution, "[interpreter_execution]"),
            (RiskReasonCode::FileDeletion, "[file_deletion]"),
            (RiskReasonCode::NetworkAccess, "[network_access]"),
            (RiskReasonCode::ProtectedPath, "[protected_path]"),
            (RiskReasonCode::UntrustedSource, "[untrusted_source]"),
            (RiskReasonCode::HookUntrusted, "[hook_untrusted]"),
            (RiskReasonCode::HighPrivilegeProposal, "[high_privilege_proposal]"),
            (RiskReasonCode::GuardianEscalated, "[guardian_escalated]"),
            (RiskReasonCode::PolicyPrompt, "[policy_prompt]"),
        ];
        for (code, expected_tag) in all_codes {
            let (tag, desc) = describe_risk_reason(code);
            assert_eq!(tag, expected_tag);
            assert!(!desc.is_empty());
            assert!(format_risk_reason(Some(code))
                .unwrap()
                .starts_with(expected_tag));
        }
        assert!(format_risk_reason(None).is_none());

        let mut app = App::new(&sample_opts());
        app.active_thread_id = Some("t1".into());
        app.apply_event(&json!({
            "type": "runner.started",
            "threadId": "t1",
            "runId": "r1"
        }));
        app.apply_event(&json!({
            "type": "runner.tool_call",
            "threadId": "t1",
            "runId": "r1",
            "toolCall": {
                "id": "tc1",
                "name": "shell",
                "args": {"command": "curl", "args": ["https://example.com"]},
                "status": "running"
            }
        }));
        app.apply_event(&json!({
            "type": "guardian.decision",
            "decision": {
                "requestId": "req-1",
                "threadId": "t1",
                "decision": "escalate",
                "riskLevel": "high",
                "riskReasonCode": "network_access",
                "reason": "Human review required",
                "commandOrPath": "curl https://example.com",
                "modelId": "l0-rules",
                "sanitizedInputOnly": true,
                "timestamp": "2026-01-01T00:00:01Z"
            }
        }));
        // Duplicate event is ignored
        app.apply_event(&json!({
            "type": "guardian.decision",
            "decision": {
                "requestId": "req-1",
                "threadId": "t1",
                "decision": "escalate",
                "riskLevel": "high",
                "riskReasonCode": "network_access",
                "reason": "Human review required",
                "commandOrPath": "curl https://example.com",
                "modelId": "l0-rules",
                "sanitizedInputOnly": true,
                "timestamp": "2026-01-01T00:00:01Z"
            }
        }));
        assert_eq!(app.guardian_decisions.len(), 1);
        let formatted = format_guardian_decision(&app.guardian_decisions[0]);
        assert!(formatted.contains("[ESCALATE · High]"));
        assert!(formatted.contains("[network_access]"));

        // Tool result and completion still resolve the active assistant turn cleanly
        app.apply_event(&json!({
            "type": "runner.tool_result",
            "threadId": "t1",
            "runId": "r1",
            "toolCallId": "tc1",
            "output": "200 OK",
            "exitCode": 0,
            "truncated": false
        }));
        app.apply_event(&json!({
            "type": "runner.completed",
            "threadId": "t1",
            "runId": "r1",
            "finalOutput": "Done."
        }));
        assert!(!app.is_running);
        assert!(app.turns.iter().any(|t| matches!(
            t,
            TuiTurn::Assistant { content, running: false, .. } if content == "Done."
        )));
    }
}
