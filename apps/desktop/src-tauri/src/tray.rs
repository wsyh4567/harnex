use crate::{
    git_store::GenomeBundle,
    persist_json,
    protocol::*,
    runtime::{EventSink, L0Runtime, L0StartOptions},
    updater::NativeInstallerLauncher,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    ops::Deref,
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, State,
};

struct TauriEventSink(tauri::AppHandle);

impl EventSink for TauriEventSink {
    fn emit(&self, payload: Value) {
        let _ = self.0.emit("harnex://event", payload);
    }
}

struct Desktop(L0Runtime);

impl Deref for Desktop {
    type Target = L0Runtime;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
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
    params: Value,
    state: State<'_, Desktop>,
) -> Result<Value, JsonRpcError> {
    state.0.sidecar_rpc(&method, params).await
}

#[tauri::command]
fn get_system_health(state: State<'_, Desktop>) -> Result<SystemHealth, String> {
    state.0.system_health()
}

#[tauri::command]
fn security_list_pending_approvals(state: State<'_, Desktop>) -> Vec<ApprovalRequest> {
    state.0.list_pending_approvals()
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
    state: State<'_, Desktop>,
) -> Result<(), String> {
    state.0.resolve_approval(&params.request_id, params.decision)
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
    Ok(state
        .git
        .read_tree(&commit_sha)
        .map_err(message)?
        .into_iter()
        .map(|(path, content)| {
            json!({
                "path": path,
                "content": content,
                "sizeBytes": content.len(),
                "component": crate::git_store::component(&path)
            })
        })
        .collect())
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

fn normalize_picked_path(raw: &str) -> String {
    if let Some(stripped) = raw.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{stripped}");
    }
    if let Some(stripped) = raw.strip_prefix(r"\\?\") {
        return stripped.to_owned();
    }
    raw.to_owned()
}

#[tauri::command]
async fn pick_workspace_directory(initial_dir: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new().set_title("Select Workspace Folder");
    if let Some(dir) = initial_dir
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let candidate = if let Some(rest) = dir
            .strip_prefix("~/")
            .or_else(|| dir.strip_prefix(r"~\"))
        {
            dirs::home_dir().map(|home| home.join(rest))
        } else if dir == "~" {
            dirs::home_dir()
        } else {
            Some(PathBuf::from(dir))
        };
        if let Some(path) = candidate.filter(|p| p.is_dir()) {
            dialog = dialog.set_directory(path);
        }
    }
    let Some(handle) = dialog.pick_folder().await else {
        return Ok(None);
    };
    let path = handle.path();
    let utf8 = path
        .to_str()
        .ok_or_else(|| "selected folder path is not valid UTF-8".to_owned())?;
    Ok(Some(normalize_picked_path(utf8)))
}

#[tauri::command]
fn git_toggle_organ(
    path: String,
    enabled: bool,
    state: State<'_, Desktop>,
) -> Result<OrganToggleResult, String> {
    state.git.toggle_organ(&path, enabled).map_err(message)
}

#[tauri::command]
fn trust_preview_import(
    archive_path: String,
    state: State<'_, Desktop>,
) -> Result<ImportPreviewResult, String> {
    let bundle = load_bundle(Path::new(&archive_path))?;
    state
        .git
        .preview_import(&archive_path, &bundle)
        .map_err(message)
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

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let seed_dir = app
                .path()
                .resource_dir()
                .ok()
                .map(|dir| dir.join("harness-seed"))
                .filter(|path| path.is_dir());
            let events = Arc::new(TauriEventSink(app.handle().clone()));
            let runtime = tauri::async_runtime::block_on(async {
                L0Runtime::start(
                    L0StartOptions {
                        data_dir: None,
                        seed_dir,
                        sidecar_override: None,
                        start_background_pricing: true,
                    },
                    events,
                )
            })?;
            let updater = Arc::clone(&runtime.updater);
            app.manage(Desktop(runtime));

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
            git_toggle_organ,
            git_scan_export,
            git_confirm_export,
            pick_workspace_directory,
            trust_preview_import,
            trust_execute_import,
            budget_get_status,
            budget_sync_pricing,
            budget_update_settings,
            updater_get_status,
            updater_check,
            updater_download,
            updater_install
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Harnex desktop application");
}
