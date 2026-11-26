pub mod app;
pub mod ui;

use crate::{
    protocol::ApprovalDecision,
    runtime::{EventSink, L0Runtime, L0StartOptions},
};
use app::{parse_slash_command, App, CatalogModel, SlashCommand, ThreadSummary, TuiOptions, TuiTurn};
use crossterm::{
    event::{
        self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEventKind, KeyModifiers,
        MouseEventKind,
    },
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{backend::CrosstermBackend, Terminal};
use serde_json::{json, Value};
use std::{
    io,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::mpsc;

struct ChannelEventSink(mpsc::UnboundedSender<Value>);

impl EventSink for ChannelEventSink {
    fn emit(&self, payload: Value) {
        let _ = self.0.send(payload);
    }
}

enum BgMessage {
    Hydrated {
        threads: Vec<ThreadSummary>,
        catalog: Vec<CatalogModel>,
        default_model: Option<String>,
        budget_spent: f64,
        budget_limit: f64,
    },
    ThreadReady {
        id: String,
        title: String,
        workspace_path: Option<String>,
        pinned_sha: String,
        messages: Vec<Value>,
        pending_prompt: Option<String>,
    },
    MessagesLoaded(Vec<Value>),
    BudgetUpdated {
        spent: f64,
        limit: f64,
    },
    Notice {
        text: String,
        is_error: bool,
    },
}

struct TerminalGuard;

impl TerminalGuard {
    fn enter() -> io::Result<Terminal<CrosstermBackend<io::Stdout>>> {
        enable_raw_mode()?;
        let mut stdout = io::stdout();
        execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
        let backend = CrosstermBackend::new(stdout);
        Terminal::new(backend)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(io::stdout(), LeaveAlternateScreen, DisableMouseCapture);
    }
}

pub async fn run(options: TuiOptions) -> io::Result<()> {
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<Value>();
    let runtime = Arc::new(L0Runtime::start(
        L0StartOptions {
            data_dir: options.data_dir.clone(),
            seed_dir: None,
            sidecar_override: options.sidecar.clone(),
            start_background_pricing: true,
        },
        Arc::new(ChannelEventSink(event_tx)),
    )?);

    let mut app = App::new(&options);
    if let Ok(health) = runtime.system_health() {
        app.sidecar_alive = health.sidecar_alive;
        app.sandbox_backend = health.sandbox_backend;
        app.pinned_sha = health.active_commit_sha.chars().take(7).collect();
    }
    let initial_budget = runtime.core.budget.status();
    app.budget_spent = initial_budget.spent_today_usd;
    app.budget_limit = initial_budget.daily_limit_usd;

    let orig_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = disable_raw_mode();
        let _ = execute!(io::stdout(), LeaveAlternateScreen, DisableMouseCapture);
        orig_hook(info);
    }));

    let mut terminal = TerminalGuard::enter()?;
    let _guard = TerminalGuard;

    let (term_tx, mut term_rx) = mpsc::unbounded_channel::<Event>();
    let stop_reader = Arc::new(AtomicBool::new(false));
    let reader_flag = Arc::clone(&stop_reader);
    let reader_handle = std::thread::spawn(move || {
        while !reader_flag.load(Ordering::Relaxed) {
            if event::poll(Duration::from_millis(30)).unwrap_or(false) {
                if let Ok(ev) = event::read() {
                    if term_tx.send(ev).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let (bg_tx, mut bg_rx) = mpsc::unbounded_channel::<BgMessage>();
    spawn_hydration(Arc::clone(&runtime), bg_tx.clone());

    let mut tick = tokio::time::interval(Duration::from_millis(100));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        terminal.draw(|frame| ui::render(frame, &app))?;
        if app.should_quit {
            break;
        }

        tokio::select! {
            _ = tick.tick() => {
                app.spinner_tick = app.spinner_tick.wrapping_add(1);
                if let Ok(health) = runtime.system_health() {
                    let was_alive = app.sidecar_alive;
                    app.sidecar_alive = health.sidecar_alive;
                    app.sandbox_backend = health.sandbox_backend;
                    if !was_alive && health.sidecar_alive {
                        app.status_hint = "Ready · Type a prompt or /help".into();
                    }
                }
            }
            Some(ev) = event_rx.recv() => {
                let is_completed = ev.get("type").and_then(Value::as_str) == Some("runner.completed");
                app.apply_event(&ev);
                if is_completed {
                    let budget = runtime.core.budget.status();
                    app.budget_spent = budget.spent_today_usd;
                    app.budget_limit = budget.daily_limit_usd;
                    if let Some(tid) = app.active_thread_id.clone() {
                        let rt = Arc::clone(&runtime);
                        let tx = bg_tx.clone();
                        tokio::spawn(async move {
                            if let Ok(val) = rt.sidecar_rpc("thread.messages", json!({"threadId": tid})).await {
                                if let Some(arr) = val.as_array() {
                                    let _ = tx.send(BgMessage::MessagesLoaded(arr.clone()));
                                }
                            }
                        });
                    }
                }
            }
            Some(bg) = bg_rx.recv() => {
                handle_bg_message(&mut app, &runtime, &bg_tx, bg);
            }
            Some(term_ev) = term_rx.recv() => {
                handle_term_event(&mut app, &runtime, &bg_tx, term_ev);
            }
        }
    }

    stop_reader.store(true, Ordering::Relaxed);
    let _ = reader_handle.join();
    Ok(())
}

fn spawn_hydration(runtime: Arc<L0Runtime>, tx: mpsc::UnboundedSender<BgMessage>) {
    tokio::spawn(async move {
        let mut health_rx = runtime.sidecar.subscribe();
        let _ = tokio::time::timeout(
            Duration::from_secs(12),
            health_rx.wait_for(|h| h.alive),
        )
        .await;

        let config = runtime.sidecar_rpc("config.get", json!({})).await.ok();
        let default_model = config.as_ref().and_then(|cfg| {
            cfg.get("slots")
                .and_then(|s| s.get("solver"))
                .and_then(|b| b.get("modelId"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        });

        let catalog = runtime
            .sidecar_rpc("provider.catalog", json!({}))
            .await
            .ok()
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|item| {
                Some(CatalogModel {
                    provider_id: item.get("providerId")?.as_str()?.to_owned(),
                    provider_name: item
                        .get("providerName")
                        .and_then(Value::as_str)
                        .unwrap_or("Provider")
                        .to_owned(),
                    model_id: item.get("modelId")?.as_str()?.to_owned(),
                    display_name: item
                        .get("displayName")
                        .and_then(Value::as_str)
                        .or_else(|| item.get("modelId").and_then(Value::as_str))?
                        .to_owned(),
                })
            })
            .collect();

        let threads = runtime
            .sidecar_rpc("thread.list", json!({}))
            .await
            .ok()
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|item| {
                Some(ThreadSummary {
                    id: item.get("id")?.as_str()?.to_owned(),
                    title: item
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("Untitled")
                        .to_owned(),
                    workspace_path: item
                        .get("workspacePath")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                    mode: item
                        .get("mode")
                        .and_then(Value::as_str)
                        .unwrap_or("craft")
                        .to_owned(),
                    status: item
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("idle")
                        .to_owned(),
                    pinned_sha: item
                        .get("pinnedCommitSha")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .chars()
                        .take(7)
                        .collect(),
                })
            })
            .collect();

        let budget = runtime.core.budget.status();
        let _ = tx.send(BgMessage::Hydrated {
            threads,
            catalog,
            default_model,
            budget_spent: budget.spent_today_usd,
            budget_limit: budget.daily_limit_usd,
        });
    });
}

fn handle_bg_message(
    app: &mut App,
    runtime: &Arc<L0Runtime>,
    bg_tx: &mpsc::UnboundedSender<BgMessage>,
    msg: BgMessage,
) {
    match msg {
        BgMessage::Hydrated {
            threads,
            catalog,
            default_model,
            budget_spent,
            budget_limit,
        } => {
            app.threads = threads;
            app.catalog = catalog;
            if let Some(m) = default_model {
                app.default_model_label = m;
            }
            app.budget_spent = budget_spent;
            app.budget_limit = budget_limit;
            app.status_hint = "Ready · Type a prompt or /help".into();
        }
        BgMessage::ThreadReady {
            id,
            title,
            workspace_path,
            pinned_sha,
            messages,
            pending_prompt,
        } => {
            app.active_thread_id = Some(id.clone());
            app.active_thread_title = Some(title);
            if let Some(ws) = workspace_path.filter(|s| !s.is_empty()) {
                app.workspace = ws;
            }
            if !pinned_sha.is_empty() {
                app.pinned_sha = pinned_sha.chars().take(7).collect();
            }
            if !messages.is_empty() {
                app.load_messages(&messages);
            }
            if let Some(prompt) = pending_prompt {
                dispatch_run(app, runtime, bg_tx, id, prompt);
            }
        }
        BgMessage::MessagesLoaded(messages) => {
            if !app.is_running {
                app.load_messages(&messages);
            }
        }
        BgMessage::BudgetUpdated { spent, limit } => {
            app.budget_spent = spent;
            app.budget_limit = limit;
        }
        BgMessage::Notice { text, is_error } => {
            app.push_system(text, is_error);
        }
    }
}

fn handle_term_event(
    app: &mut App,
    runtime: &Arc<L0Runtime>,
    bg_tx: &mpsc::UnboundedSender<BgMessage>,
    ev: Event,
) {
    match ev {
        Event::Mouse(mouse) => match mouse.kind {
            MouseEventKind::ScrollUp => {
                app.scroll_from_bottom = app.scroll_from_bottom.saturating_add(3);
            }
            MouseEventKind::ScrollDown => {
                app.scroll_from_bottom = app.scroll_from_bottom.saturating_sub(3);
            }
            _ => {}
        },
        Event::Key(key) if key.kind == KeyEventKind::Press => {
            if let Some(request) = app.approvals.front().cloned() {
                let decision = match key.code {
                    KeyCode::Char('a') | KeyCode::Char('A') => Some(ApprovalDecision::AllowOnce),
                    KeyCode::Char('s') | KeyCode::Char('S') => Some(ApprovalDecision::AllowSession),
                    KeyCode::Char('d') | KeyCode::Char('D') | KeyCode::Esc => {
                        Some(ApprovalDecision::Deny)
                    }
                    _ => None,
                };
                if let Some(decision) = decision {
                    app.approvals.pop_front();
                    if let Err(err) = runtime.resolve_approval(&request.request_id, decision) {
                        app.push_system(format!("Approval resolution failed: {err}"), true);
                    } else {
                        app.status_hint = format!("Resolved approval: {decision:?}");
                    }
                }
                return;
            }

            if key.modifiers.contains(KeyModifiers::CONTROL) {
                match key.code {
                    KeyCode::Char('c') => {
                        if app.is_running {
                            abort_active(app, runtime, bg_tx);
                        } else {
                            app.should_quit = true;
                        }
                    }
                    KeyCode::Char('q') => app.should_quit = true,
                    KeyCode::Char('m') => app.cycle_mode(),
                    KeyCode::Char('t') => app.toggle_reasoning(),
                    KeyCode::Char('o') => app.toggle_tools(),
                    KeyCode::Char('l') => {
                        app.turns.clear();
                        app.scroll_from_bottom = 0;
                    }
                    KeyCode::Char('u') => app.clear_input(),
                    KeyCode::Char('w') => app.delete_prev_word(),
                    _ => {}
                }
                return;
            }

            match key.code {
                KeyCode::Esc => {
                    if app.is_running {
                        abort_active(app, runtime, bg_tx);
                    }
                }
                KeyCode::PageUp => {
                    app.scroll_from_bottom = app.scroll_from_bottom.saturating_add(8);
                }
                KeyCode::PageDown => {
                    app.scroll_from_bottom = app.scroll_from_bottom.saturating_sub(8);
                }
                KeyCode::Up => app.history_prev(),
                KeyCode::Down => app.history_next(),
                KeyCode::Left => app.move_cursor_left(),
                KeyCode::Right => app.move_cursor_right(),
                KeyCode::Home => app.cursor_char = 0,
                KeyCode::End => app.cursor_char = app.input.chars().count(),
                KeyCode::Backspace => app.backspace(),
                KeyCode::Delete => app.delete_char(),
                KeyCode::Enter => {
                    let submitted = app.take_input();
                    let trimmed = submitted.trim();
                    if trimmed.is_empty() {
                        return;
                    }
                    if let Some(cmd) = parse_slash_command(trimmed) {
                        handle_slash(app, runtime, bg_tx, cmd);
                    } else {
                        submit_prompt(app, runtime, bg_tx, trimmed.to_owned());
                    }
                }
                KeyCode::Char(c) => app.insert_char(c),
                _ => {}
            }
        }
        _ => {}
    }
}

fn handle_slash(
    app: &mut App,
    runtime: &Arc<L0Runtime>,
    bg_tx: &mpsc::UnboundedSender<BgMessage>,
    cmd: SlashCommand,
) {
    match cmd {
        SlashCommand::Help => {
            app.push_system(
                "Commands:\n\
                 /mode <craft|plan|ask>     Switch execution mode (or Ctrl+M)\n\
                 /models                    List available models from configured providers\n\
                 /model <provider::model>   Override active model for this TUI session\n\
                 /threads                   List recent threads\n\
                 /use <index|id>            Switch to an existing thread\n\
                 /new                       Start a fresh thread in current workspace\n\
                 /pause | /resume | /abort  Control an active run\n\
                 /steer <instruction>       Inject human steer while paused\n\
                 /budget                    Show daily budget usage\n\
                 /evolve [goal]             Trigger Harness² evolution in background\n\
                 /clear | /quit             Clear viewport or exit Harnex TUI",
                false,
            );
        }
        SlashCommand::NewThread => {
            app.active_thread_id = None;
            app.active_thread_title = None;
            app.turns.clear();
            app.status_hint = "Ready for a new thread".into();
        }
        SlashCommand::ListThreads => {
            if app.threads.is_empty() {
                app.push_system("No persisted threads yet.", false);
            } else {
                let listing = app
                    .threads
                    .iter()
                    .take(15)
                    .enumerate()
                    .map(|(i, t)| format!("[{}] {} ({}, {}, {}) — {}", i + 1, t.title, t.mode, t.status, t.workspace_path, t.id))
                    .collect::<Vec<_>>()
                    .join("\n");
                app.push_system(format!("Recent threads (use /use <n>):\n{listing}"), false);
            }
        }
        SlashCommand::UseThread(selector) => {
            let chosen = selector
                .parse::<usize>()
                .ok()
                .and_then(|idx| idx.checked_sub(1))
                .and_then(|i| app.threads.get(i))
                .or_else(|| app.threads.iter().find(|t| t.id == selector))
                .cloned();
            let Some(thread) = chosen else {
                app.push_system(format!("Thread not found: {selector}"), true);
                return;
            };
            let rt = Arc::clone(runtime);
            let tx = bg_tx.clone();
            tokio::spawn(async move {
                match rt
                    .sidecar_rpc("thread.messages", json!({"threadId": thread.id}))
                    .await
                {
                    Ok(val) => {
                        let msgs = val.as_array().cloned().unwrap_or_default();
                        let _ = tx.send(BgMessage::ThreadReady {
                            id: thread.id,
                            title: thread.title,
                            workspace_path: Some(thread.workspace_path),
                            pinned_sha: thread.pinned_sha,
                            messages: msgs,
                            pending_prompt: None,
                        });
                    }
                    Err(e) => {
                        let _ = tx.send(BgMessage::Notice {
                            text: format!("Failed to load thread: {}", e.message),
                            is_error: true,
                        });
                    }
                }
            });
        }
        SlashCommand::SetMode(mode) => {
            app.mode = mode.clone();
            app.status_hint = format!("Mode set to [{mode}]");
        }
        SlashCommand::ListModels => {
            if app.catalog.is_empty() {
                app.push_system(
                    "No models discovered yet. Configure a provider in Harnex Desktop or ~/.harnex.",
                    false,
                );
            } else {
                let lines = app
                    .catalog
                    .iter()
                    .take(20)
                    .map(|m| format!("• {}::{}  [{} · {}]", m.provider_id, m.model_id, m.provider_name, m.display_name))
                    .collect::<Vec<_>>()
                    .join("\n");
                app.push_system(
                    format!("Available models (use /model <provider::model>):\n{lines}"),
                    false,
                );
            }
        }
        SlashCommand::SetModel { provider, model } => {
            app.provider_override = provider;
            app.model_override = Some(model);
            app.status_hint = format!("Active model: {}", app.active_model_display());
        }
        SlashCommand::Budget => {
            let st = runtime.core.budget.status();
            app.budget_spent = st.spent_today_usd;
            app.budget_limit = st.daily_limit_usd;
            app.push_system(
                format!(
                    "Daily budget: ${:.4} / ${:.2} ({} tokens today)",
                    st.spent_today_usd, st.daily_limit_usd, st.tokens_today
                ),
                false,
            );
        }
        SlashCommand::Pause => {
            if let Some(tid) = app.active_thread_id.clone() {
                spawn_simple_rpc(runtime, bg_tx, "runner.pause", json!({"threadId": tid}));
            }
        }
        SlashCommand::Resume => {
            if let Some(tid) = app.active_thread_id.clone() {
                app.is_paused = false;
                spawn_simple_rpc(runtime, bg_tx, "runner.resume", json!({"threadId": tid}));
            }
        }
        SlashCommand::Steer(instruction) => {
            if let Some(tid) = app.active_thread_id.clone() {
                spawn_simple_rpc(
                    runtime,
                    bg_tx,
                    "runner.steer",
                    json!({"threadId": tid, "instruction": instruction, "triggerEvolutionOnFinish": true}),
                );
            } else {
                app.push_system("No active thread to steer.", true);
            }
        }
        SlashCommand::Abort => abort_active(app, runtime, bg_tx),
        SlashCommand::Evolve(goal) => {
            let rt = Arc::clone(runtime);
            let tx = bg_tx.clone();
            let mut params = json!({"domain": "general", "mode": "parallel", "k": 2});
            if let Some(g) = goal {
                params["goal"] = json!(g);
            }
            app.push_system("Triggering Harness² evolution in background...", false);
            tokio::spawn(async move {
                match rt.sidecar_rpc("evolution.trigger", params).await {
                    Ok(proposal) => {
                        let id = proposal
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("proposal");
                        let _ = tx.send(BgMessage::Notice {
                            text: format!("Evolution proposal ready: {id} (review & adopt in Harnex Desktop)"),
                            is_error: false,
                        });
                    }
                    Err(e) => {
                        let _ = tx.send(BgMessage::Notice {
                            text: format!("Evolution trigger failed: {}", e.message),
                            is_error: true,
                        });
                    }
                }
            });
        }
        SlashCommand::Clear => {
            app.turns.clear();
            app.scroll_from_bottom = 0;
        }
        SlashCommand::Quit => app.should_quit = true,
        SlashCommand::Unknown(raw) => {
            app.push_system(format!("Unknown command: {raw}. Try /help."), true);
        }
    }
}

fn submit_prompt(
    app: &mut App,
    runtime: &Arc<L0Runtime>,
    bg_tx: &mpsc::UnboundedSender<BgMessage>,
    prompt: String,
) {
    if app.is_running {
        app.push_system(
            "A run is already active. Use /pause + /steer <instruction>, or /abort.",
            true,
        );
        return;
    }
    app.turns.push(TuiTurn::User {
        text: prompt.clone(),
    });
    app.scroll_from_bottom = 0;

    if let Some(tid) = app.active_thread_id.clone() {
        dispatch_run(app, runtime, bg_tx, tid, prompt);
        return;
    }

    let rt = Arc::clone(runtime);
    let tx = bg_tx.clone();
    let workspace = app.workspace.clone();
    let mode = app.mode.clone();
    let title: String = prompt.chars().take(60).collect();
    app.status_hint = "Creating L0-bound thread...".into();
    tokio::spawn(async move {
        match rt
            .sidecar_rpc(
                "thread.create",
                json!({
                    "workspacePath": workspace,
                    "title": title,
                    "mode": mode,
                }),
            )
            .await
        {
            Ok(thread) => {
                let id = thread
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let title = thread
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("Task")
                    .to_owned();
                let pinned = thread
                    .get("pinnedCommitSha")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let workspace_path = thread
                    .get("workspacePath")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let _ = tx.send(BgMessage::ThreadReady {
                    id,
                    title,
                    workspace_path,
                    pinned_sha: pinned,
                    messages: Vec::new(),
                    pending_prompt: Some(prompt),
                });
            }
            Err(e) => {
                let _ = tx.send(BgMessage::Notice {
                    text: format!("Failed to create thread: {}", e.message),
                    is_error: true,
                });
            }
        }
    });
}

fn dispatch_run(
    app: &mut App,
    runtime: &Arc<L0Runtime>,
    bg_tx: &mpsc::UnboundedSender<BgMessage>,
    thread_id: String,
    prompt: String,
) {
    let mut params = json!({
        "threadId": thread_id,
        "prompt": prompt,
        "mode": app.mode,
    });
    if let Some(model) = &app.model_override {
        params["modelOverride"] = json!(model);
    }
    if let Some(provider) = &app.provider_override {
        params["providerIdOverride"] = json!(provider);
    }
    let rt = Arc::clone(runtime);
    let tx = bg_tx.clone();
    app.status_hint = "Starting task in L0 Sandbox...".into();
    tokio::spawn(async move {
        if let Err(e) = rt.sidecar_rpc("runner.start", params).await {
            let _ = tx.send(BgMessage::Notice {
                text: format!("Failed to start run: {}", e.message),
                is_error: true,
            });
        }
    });
}

fn abort_active(
    app: &mut App,
    runtime: &Arc<L0Runtime>,
    bg_tx: &mpsc::UnboundedSender<BgMessage>,
) {
    if let Some(tid) = app.active_thread_id.clone() {
        app.status_hint = "Aborting run...".into();
        spawn_simple_rpc(runtime, bg_tx, "runner.abort", json!({"threadId": tid}));
    }
}

fn spawn_simple_rpc(
    runtime: &Arc<L0Runtime>,
    bg_tx: &mpsc::UnboundedSender<BgMessage>,
    method: &'static str,
    params: Value,
) {
    let rt = Arc::clone(runtime);
    let tx = bg_tx.clone();
    tokio::spawn(async move {
        if let Err(e) = rt.sidecar_rpc(method, params).await {
            let _ = tx.send(BgMessage::Notice {
                text: format!("{method} failed: {}", e.message),
                is_error: true,
            });
        } else {
            let budget = rt.core.budget.status();
            let _ = tx.send(BgMessage::BudgetUpdated {
                spent: budget.spent_today_usd,
                limit: budget.daily_limit_usd,
            });
        }
    });
}
