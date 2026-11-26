use super::app::{
    describe_risk_reason, format_duration_compact, is_command_tool, App, TuiActivity, TuiTurn,
};
use crate::protocol::{ApprovalRequest, RiskLevel};
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
    Frame,
};
use unicode_width::UnicodeWidthStr;

const SPINNER_FRAMES: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

pub fn render(frame: &mut Frame, app: &App) {
    let area = frame.area();
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(6),
            Constraint::Length(3),
            Constraint::Length(1),
        ])
        .split(area);

    render_header(frame, app, chunks[0]);
    render_conversation(frame, app, chunks[1]);
    render_input(frame, app, chunks[2]);
    render_footer(frame, app, chunks[3]);

    if let Some(request) = app.approvals.front() {
        render_approval_modal(frame, request, area);
    }
}

fn render_header(frame: &mut Frame, app: &App, area: Rect) {
    let dot_style = if app.sidecar_alive {
        Style::default().fg(Color::Green)
    } else {
        Style::default().fg(Color::Red)
    };
    let mode_color = match app.mode.as_str() {
        "craft" => Color::Cyan,
        "plan" => Color::Yellow,
        _ => Color::Green,
    };
    let effort_color = match app.reasoning_effort.as_str() {
        "high" => Color::LightMagenta,
        "medium" => Color::Yellow,
        "low" => Color::Green,
        _ => Color::Gray,
    };
    let ws_short = std::path::Path::new(&app.workspace)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(&app.workspace);

    let line = Line::from(vec![
        Span::styled(
            " ◈ Harnex TUI ",
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!("v{} ", env!("CARGO_PKG_VERSION")),
            Style::default().fg(Color::DarkGray),
        ),
        Span::raw("│ "),
        Span::styled(ws_short, Style::default().fg(Color::White)),
        Span::raw(" │ "),
        Span::styled(
            format!("⎇ {}", app.pinned_sha),
            Style::default().fg(Color::Magenta),
        ),
        Span::raw(" │ "),
        Span::styled(
            format!("[{}]", app.mode),
            Style::default()
                .fg(mode_color)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(" "),
        Span::styled(
            format!("effort:{}", app.reasoning_effort),
            Style::default().fg(effort_color),
        ),
        Span::raw(" │ "),
        Span::styled("● ", dot_style),
        Span::styled(
            if app.sidecar_alive {
                format!("L0 ({})", app.sandbox_backend)
            } else {
                "Sidecar booting".into()
            },
            Style::default().fg(Color::Gray),
        ),
        Span::raw(" │ "),
        Span::styled(
            format!("${:.2}/${:.2}", app.budget_spent, app.budget_limit),
            Style::default().fg(Color::Green),
        ),
        Span::raw(" │ "),
        Span::styled(
            app.active_model_display(),
            Style::default().fg(Color::LightBlue),
        ),
    ]);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::DarkGray));
    frame.render_widget(Paragraph::new(line).block(block), area);
}

fn render_conversation(frame: &mut Frame, app: &App, area: Rect) {
    let mut lines: Vec<Line<'static>> = Vec::new();
    let spinner = SPINNER_FRAMES[app.spinner_tick % SPINNER_FRAMES.len()];

    if app.turns.is_empty() {
        lines.push(Line::raw(""));
        lines.push(Line::from(vec![
            Span::styled(
                "  Harnex — Living Agent Command Deck (Terminal Edition)",
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            ),
        ]));
        lines.push(Line::from(vec![Span::styled(
            format!("  Workspace: {}", app.workspace),
            Style::default().fg(Color::Gray),
        )]));
        lines.push(Line::raw(""));
        lines.push(Line::from(vec![Span::styled(
            "  Quick commands: /help  /mode <craft|plan|ask>  /effort <auto|low|medium|high>  /models  /model <id>  /threads  /new  /evolve  /quit",
            Style::default().fg(Color::DarkGray),
        )]));
        lines.push(Line::from(vec![Span::styled(
            "  Shortcuts: Ctrl+T toggle reasoning · Ctrl+O toggle tool details · Ctrl+M cycle mode · PgUp/PgDn scroll",
            Style::default().fg(Color::DarkGray),
        )]));
    } else {
        for turn in &app.turns {
            match turn {
                TuiTurn::User { text } => {
                    lines.push(Line::raw(""));
                    for (idx, part) in text.lines().enumerate() {
                        let prefix = if idx == 0 { "▸ You: " } else { "       " };
                        lines.push(Line::from(vec![
                            Span::styled(
                                prefix.to_owned(),
                                Style::default()
                                    .fg(Color::Cyan)
                                    .add_modifier(Modifier::BOLD),
                            ),
                            Span::styled(part.to_owned(), Style::default().fg(Color::White)),
                        ]));
                    }
                }
                TuiTurn::Steer { text } => {
                    lines.push(Line::from(vec![
                        Span::styled(
                            "⚡ Steer: ",
                            Style::default()
                                .fg(Color::Magenta)
                                .add_modifier(Modifier::BOLD),
                        ),
                        Span::styled(text.clone(), Style::default().fg(Color::LightMagenta)),
                    ]));
                }
                TuiTurn::System { text, is_error } => {
                    let style = if *is_error {
                        Style::default().fg(Color::Red)
                    } else {
                        Style::default().fg(Color::Yellow)
                    };
                    for part in text.lines() {
                        lines.push(Line::from(vec![Span::styled(
                            format!("  ℹ {part}"),
                            style,
                        )]));
                    }
                }
                TuiTurn::Security(decision) => {
                    let verdict = decision.decision.to_ascii_uppercase();
                    let verdict_color = match decision.decision.as_str() {
                        "deny" => Color::Red,
                        "escalate" => Color::Yellow,
                        _ => Color::Green,
                    };
                    let risk_color = risk_level_color(decision.risk_level);
                    let mut header = vec![
                        Span::styled(
                            format!("  🛡 Guardian [{verdict} · {:?}]", decision.risk_level),
                            Style::default()
                                .fg(verdict_color)
                                .add_modifier(Modifier::BOLD),
                        ),
                    ];
                    if let Some(code) = decision.risk_reason_code {
                        let (tag, explanation) = describe_risk_reason(code);
                        header.push(Span::raw(" "));
                        header.push(Span::styled(
                            tag.to_owned(),
                            Style::default()
                                .fg(risk_color)
                                .add_modifier(Modifier::BOLD),
                        ));
                        header.push(Span::styled(
                            format!(" {explanation}"),
                            Style::default().fg(Color::Gray),
                        ));
                    }
                    lines.push(Line::from(header));

                    let target = decision.command_or_path.trim();
                    let reason = decision.reason.trim();
                    let mut detail_spans = vec![Span::styled(
                        "    ",
                        Style::default().fg(Color::DarkGray),
                    )];
                    if !target.is_empty() {
                        detail_spans.push(Span::styled(
                            truncate_chars(target, 72),
                            Style::default().fg(Color::White),
                        ));
                    }
                    if !target.is_empty() && !reason.is_empty() {
                        detail_spans.push(Span::styled(" · ", Style::default().fg(Color::DarkGray)));
                    }
                    if !reason.is_empty() {
                        detail_spans.push(Span::styled(
                            reason.to_owned(),
                            Style::default().fg(Color::DarkGray),
                        ));
                    }
                    if !target.is_empty() || !reason.is_empty() {
                        lines.push(Line::from(detail_spans));
                    }
                }
                TuiTurn::Assistant {
                    activities,
                    content,
                    started_at,
                    elapsed_ms,
                    running,
                    activities_expanded,
                    ..
                } => {
                    lines.push(Line::raw(""));
                    let shown_ms = if *running {
                        started_at.map(|s| s.elapsed().as_millis() as u64)
                    } else {
                        *elapsed_ms
                    };
                    if let Some(ms) = shown_ms.filter(|&m| m >= 1000) {
                        lines.push(Line::from(vec![Span::styled(
                            format!("  已工作 {} ─────────────────────────────", format_duration_compact(ms)),
                            Style::default().fg(Color::DarkGray),
                        )]));
                    }

                    if !activities.is_empty() {
                        let (cmd_count, tool_count) = count_activities(activities);
                        let summary = format_activity_summary(*running, cmd_count, tool_count);
                        let chevron = if *activities_expanded { "▾" } else { "▸" };
                        lines.push(Line::from(vec![
                            Span::styled(
                                format!("  ⚙ {summary} "),
                                Style::default().fg(Color::Gray),
                            ),
                            Span::styled(
                                format!("{chevron} [Ctrl+O tools · Ctrl+T think]"),
                                Style::default().fg(Color::DarkGray),
                            ),
                        ]));

                        if *activities_expanded {
                            for act in activities {
                                push_activity_lines(&mut lines, act, spinner);
                            }
                        }
                    }

                    if !content.trim().is_empty() {
                        lines.push(Line::raw(""));
                        for part in content.lines() {
                            lines.push(Line::from(vec![Span::styled(
                                format!("  {part}"),
                                Style::default().fg(Color::White),
                            )]));
                        }
                    }

                    if *running {
                        let label = if app.is_paused {
                            "  ⏸ 已暂停 (使用 /steer <指令> 或 /resume 继续)".to_owned()
                        } else {
                            format!("  {spinner} 处理中…")
                        };
                        lines.push(Line::from(vec![Span::styled(
                            label,
                            Style::default().fg(Color::Cyan),
                        )]));
                    }
                }
            }
        }
    }

    let inner_height = area.height.saturating_sub(2) as usize;
    let inner_width = area.width.saturating_sub(2).max(1) as usize;
    let total_visual_lines: usize = lines
        .iter()
        .map(|l| {
            let w = l.width();
            w.max(1).div_ceil(inner_width)
        })
        .sum();
    let max_scroll = total_visual_lines.saturating_sub(inner_height) as u16;
    let effective_scroll = max_scroll.saturating_sub(app.scroll_from_bottom.min(max_scroll));

    let title = match &app.active_thread_title {
        Some(t) => format!(" Thread: {t} "),
        None => " Conversation ".into(),
    };
    let block = Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::DarkGray));
    let paragraph = Paragraph::new(lines)
        .block(block)
        .wrap(Wrap { trim: false })
        .scroll((effective_scroll, 0));
    frame.render_widget(paragraph, area);
}

fn push_activity_lines(lines: &mut Vec<Line<'static>>, act: &TuiActivity, spinner: &str) {
    match act {
        TuiActivity::Reasoning { text, expanded, .. } => {
            let chevron = if *expanded { "▾" } else { "▸" };
            lines.push(Line::from(vec![
                Span::styled("  │ ", Style::default().fg(Color::DarkGray)),
                Span::styled(
                    format!("🧠 推理 {chevron}"),
                    Style::default().fg(Color::DarkGray),
                ),
            ]));
            if *expanded {
                let reason_lines: Vec<&str> = text.lines().collect();
                let start = reason_lines.len().saturating_sub(14);
                if start > 0 {
                    lines.push(Line::from(vec![
                        Span::styled("  │   ", Style::default().fg(Color::DarkGray)),
                        Span::styled(
                            format!("... ({start} earlier lines hidden) ..."),
                            Style::default().fg(Color::DarkGray),
                        ),
                    ]));
                }
                for part in &reason_lines[start..] {
                    lines.push(Line::from(vec![
                        Span::styled("  │   ", Style::default().fg(Color::DarkGray)),
                        Span::styled((*part).to_owned(), Style::default().fg(Color::Gray)),
                    ]));
                }
            }
        }
        TuiActivity::Tool {
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
            ..
        } => {
            let icon = if is_command_tool(name) { ">_" } else { "⚙" };
            let label = if is_command_tool(name) {
                truncate_chars(target, 72)
            } else if target.is_empty() {
                name.clone()
            } else {
                format!("{name}  {}", truncate_chars(target, 64))
            };
            let mut spans = vec![
                Span::styled("  │ ", Style::default().fg(Color::DarkGray)),
                Span::styled(format!("{icon} "), Style::default().fg(Color::Cyan)),
                Span::styled(label, Style::default().fg(Color::White)),
                Span::raw("  "),
            ];
            if status == "running" || status == "pending" {
                spans.push(Span::styled(
                    format!("{spinner} running"),
                    Style::default().fg(Color::Cyan),
                ));
            } else if let Some(code) = exit_code {
                let code_style = if *code == 0 {
                    Style::default().fg(Color::DarkGray)
                } else {
                    Style::default().fg(Color::Red)
                };
                spans.push(Span::styled(format!("退出码 {code}"), code_style));
            } else if status == "failed" || status == "denied" {
                spans.push(Span::styled(
                    status.clone(),
                    Style::default().fg(Color::Red),
                ));
            }
            if let Some(ms) = duration_ms.filter(|&m| m > 0) {
                let dur = if ms < 1000 {
                    format!(" {ms}ms")
                } else {
                    format!(" {}", format_duration_compact(ms))
                };
                spans.push(Span::styled(dur, Style::default().fg(Color::DarkGray)));
            }
            spans.push(Span::styled(
                if *expanded { " ▾" } else { " ▸" },
                Style::default().fg(Color::DarkGray),
            ));
            lines.push(Line::from(spans));

            if *expanded {
                for arg_line in args_pretty.lines().take(10) {
                    lines.push(Line::from(vec![
                        Span::styled("  │     ", Style::default().fg(Color::DarkGray)),
                        Span::styled(arg_line.to_owned(), Style::default().fg(Color::DarkGray)),
                    ]));
                }
                if !output.trim().is_empty() {
                    for out_line in output.lines().take(16) {
                        lines.push(Line::from(vec![
                            Span::styled("  │     ", Style::default().fg(Color::DarkGray)),
                            Span::styled(out_line.to_owned(), Style::default().fg(Color::Gray)),
                        ]));
                    }
                    if *truncated {
                        lines.push(Line::from(vec![
                            Span::styled("  │     ", Style::default().fg(Color::DarkGray)),
                            Span::styled(
                                "[truncated by L1 context guard]",
                                Style::default().fg(Color::Yellow),
                            ),
                        ]));
                    }
                }
                if let Some(err) = error {
                    lines.push(Line::from(vec![
                        Span::styled("  │     ", Style::default().fg(Color::DarkGray)),
                        Span::styled(format!("error: {err}"), Style::default().fg(Color::Red)),
                    ]));
                }
            }
        }
    }
}

fn render_input(frame: &mut Frame, app: &App, area: Rect) {
    let title = if app.is_running {
        " Running (/pause, /steer, /abort, or Ctrl+C) "
    } else {
        " Prompt (Enter send · /help commands) "
    };
    let border_color = if app.approvals.is_empty() {
        Color::Cyan
    } else {
        Color::DarkGray
    };
    let block = Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(border_color));
    let prompt_text = format!("> {}", app.input);
    frame.render_widget(Paragraph::new(prompt_text).block(block), area);

    if app.approvals.is_empty() {
        let prefix: String = app.input.chars().take(app.cursor_char).collect();
        let cursor_x = area
            .x
            .saturating_add(3)
            .saturating_add(UnicodeWidthStr::width(prefix.as_str()) as u16)
            .min(area.x.saturating_add(area.width.saturating_sub(2)));
        let cursor_y = area.y.saturating_add(1);
        frame.set_cursor_position((cursor_x, cursor_y));
    }
}

fn render_footer(frame: &mut Frame, app: &App, area: Rect) {
    let line = Line::from(vec![
        Span::styled(" ", Style::default()),
        Span::styled(
            app.status_hint.clone(),
            Style::default().fg(Color::Gray),
        ),
        Span::styled(
            "   │ Ctrl+M mode · Ctrl+T think · Ctrl+O tools · PgUp/PgDn scroll · Ctrl+C abort/quit",
            Style::default().fg(Color::DarkGray),
        ),
    ]);
    frame.render_widget(Paragraph::new(line), area);
}

fn risk_level_color(level: RiskLevel) -> Color {
    match level {
        RiskLevel::Critical => Color::Red,
        RiskLevel::High => Color::LightRed,
        RiskLevel::Medium => Color::Yellow,
        RiskLevel::Low => Color::Green,
    }
}

fn render_approval_modal(frame: &mut Frame, request: &ApprovalRequest, area: Rect) {
    let modal_w = area.width.min(82);
    let modal_h = area.height.min(15);
    let x = area.x + area.width.saturating_sub(modal_w) / 2;
    let y = area.y + area.height.saturating_sub(modal_h) / 2;
    let popup = Rect::new(x, y, modal_w, modal_h);

    let risk_color = risk_level_color(request.risk_level);
    let border_color = if request.risk_level == RiskLevel::Critical {
        Color::Red
    } else {
        Color::Yellow
    };

    frame.render_widget(Clear, popup);
    let mut lines = vec![Line::from(vec![
        Span::styled("Kind: ", Style::default().fg(Color::DarkGray)),
        Span::styled(
            format!("{:?}", request.kind),
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled("  (Risk: ", Style::default().fg(Color::DarkGray)),
        Span::styled(
            format!("{:?}", request.risk_level),
            Style::default()
                .fg(risk_color)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(")", Style::default().fg(Color::DarkGray)),
    ])];
    if let Some(code) = request.risk_reason_code {
        let (tag, explanation) = describe_risk_reason(code);
        lines.push(Line::from(vec![
            Span::styled("Reason: ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                tag.to_owned(),
                Style::default()
                    .fg(risk_color)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw(" "),
            Span::styled(explanation.to_owned(), Style::default().fg(Color::White)),
        ]));
    }
    lines.extend([
        Line::from(vec![
            Span::styled("Target: ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                request.command_or_path.clone(),
                Style::default().fg(Color::White),
            ),
        ]),
        Line::from(vec![
            Span::styled("Summary: ", Style::default().fg(Color::DarkGray)),
            Span::styled(request.summary.clone(), Style::default().fg(Color::Gray)),
        ]),
        Line::from(vec![
            Span::styled("Detail: ", Style::default().fg(Color::DarkGray)),
            Span::styled(request.detail.clone(), Style::default().fg(Color::DarkGray)),
        ]),
        Line::raw(""),
        Line::from(vec![
            Span::styled(
                " [A] Allow Once ",
                Style::default()
                    .fg(Color::Black)
                    .bg(Color::Green)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw("   "),
            Span::styled(
                " [S] Allow Session ",
                Style::default()
                    .fg(Color::Black)
                    .bg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw("   "),
            Span::styled(
                " [D] Deny ",
                Style::default()
                    .fg(Color::White)
                    .bg(Color::Red)
                    .add_modifier(Modifier::BOLD),
            ),
        ]),
    ]);

    let block = Block::default()
        .title(" ⚠ L0 Security Approval Required ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(border_color));
    let widget = Paragraph::new(lines)
        .block(block)
        .wrap(Wrap { trim: false });
    frame.render_widget(widget, popup);
}

fn count_activities(activities: &[TuiActivity]) -> (usize, usize) {
    let mut cmds = 0;
    let mut tools = 0;
    for act in activities {
        if let TuiActivity::Tool { name, .. } = act {
            if is_command_tool(name) {
                cmds += 1;
            } else {
                tools += 1;
            }
        }
    }
    (cmds, tools)
}

fn format_activity_summary(running: bool, cmds: usize, tools: usize) -> String {
    match (running, cmds > 0, tools > 0) {
        (true, true, true) => format!("正在运行 {cmds} 条命令 · 正在使用 {tools} 个工具"),
        (true, true, false) => format!("正在运行 {cmds} 条命令"),
        (true, false, true) => format!("正在使用 {tools} 个工具"),
        (true, false, false) => "正在推理".into(),
        (false, true, true) => format!("已运行 {cmds} 条命令 · 使用 {tools} 个工具"),
        (false, true, false) => format!("已运行 {cmds} 条命令"),
        (false, false, true) => format!("使用了 {tools} 个工具"),
        (false, false, false) => "推理过程".into(),
    }
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let head: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tui::app::TuiOptions;
    use ratatui::{backend::TestBackend, Terminal};
    use serde_json::json;
    use std::path::PathBuf;

    #[test]
    fn renders_activity_timeline_and_reasoning_into_ratatui_frame() {
        let opts = TuiOptions {
            workspace: PathBuf::from("/tmp/demo-project"),
            mode: "craft".into(),
            model: Some("gpt-5".into()),
            provider: None,
            sidecar: None,
            data_dir: None,
        };
        let mut app = App::new(&opts);
        app.sidecar_alive = true;
        app.sandbox_backend = "seatbelt".into();
        app.active_thread_id = Some("t1".into());
        app.turns.push(TuiTurn::User {
            text: "Check tests".into(),
        });
        app.apply_event(&json!({
            "type": "runner.started",
            "threadId": "t1",
            "runId": "r1",
            "pinnedCommitSha": "1234567abcdef"
        }));
        app.apply_event(&json!({
            "type": "runner.token",
            "threadId": "t1",
            "runId": "r1",
            "delta": "Inspecting workspace first",
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
            "output": "ok",
            "exitCode": 0,
            "truncated": false
        }));

        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| render(f, &app)).unwrap();

        let rendered: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect();
        assert!(rendered.contains("Harnex TUI"));
        assert!(rendered.contains("effort:auto"));
        assert!(rendered.contains("bun test"));
        assert!(rendered.contains("Inspecting workspace first"));
    }

    #[test]
    fn renders_effort_new_tools_guardian_log_and_approval_risk_reason() {
        use crate::protocol::{ApprovalRequestKind, GuardianDecision, RiskReasonCode};

        let opts = TuiOptions {
            workspace: PathBuf::from("/tmp/demo-project"),
            mode: "craft".into(),
            model: Some("gpt-5".into()),
            provider: None,
            sidecar: None,
            data_dir: None,
        };
        let mut app = App::new(&opts);
        app.sidecar_alive = true;
        app.sandbox_backend = "seatbelt".into();
        app.active_thread_id = Some("t1".into());
        app.set_reasoning_effort("high").unwrap();
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
                "id": "tc-web",
                "name": "web_fetch",
                "args": {"url": "https://docs.rs/ratatui/latest"},
                "status": "completed"
            }
        }));
        app.apply_event(&json!({
            "type": "runner.tool_call",
            "threadId": "t1",
            "runId": "r1",
            "toolCall": {
                "id": "tc-sub",
                "name": "delegate_subagent",
                "args": {"profile": "sub_agents/researcher.md", "task": "Check API changes"},
                "status": "completed"
            }
        }));
        app.record_guardian_decision(GuardianDecision {
            request_id: "gd-1".into(),
            thread_id: "t1".into(),
            decision: "escalate".into(),
            risk_level: RiskLevel::High,
            risk_reason_code: Some(RiskReasonCode::NetworkAccess),
            reason: "Outbound call needs confirmation".into(),
            command_or_path: "curl https://example.com".into(),
            model_id: "l0-rules".into(),
            sanitized_input_only: true,
            timestamp: "2026-01-01T00:00:00Z".into(),
        });

        let backend = TestBackend::new(110, 32);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| render(f, &app)).unwrap();

        let rendered: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect();
        assert!(rendered.contains("effort:high"));
        assert!(rendered.contains("docs.rs/ratatui/latest"));
        assert!(rendered.contains("@researcher"));
        assert!(rendered.contains("[network_access]"));

        // Now enqueue an approval request with ShellSyntax and verify modal rendering
        app.approvals.push_back(ApprovalRequest {
            request_id: "req-shell".into(),
            thread_id: "t1".into(),
            kind: ApprovalRequestKind::ShellCommand,
            summary: "Run shell pipeline".into(),
            detail: "Contains pipe operator".into(),
            command_or_path: "ls | grep rs".into(),
            risk_level: RiskLevel::Critical,
            risk_reason_code: Some(RiskReasonCode::ShellSyntax),
            sha256: None,
            previous_sha256: None,
            source_tags: vec![],
            created_at: "2026-01-01T00:00:01Z".into(),
        });
        terminal.draw(|f| render(f, &app)).unwrap();
        let modal_rendered: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect();
        assert!(modal_rendered.contains("[shell_syntax]"));
        assert!(modal_rendered.contains("metacharacters"));
    }
}
