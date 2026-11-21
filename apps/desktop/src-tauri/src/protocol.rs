//! Frozen L0 protocol types aligned 1:1 with `packages/protocol` (Gate 0).
//! Parallel agents MUST NOT break field names or JSON camelCase serialization.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const PROTOCOL_VERSION: &str = "1.0.0";

pub const HIGH_PRIVILEGE_HARNESS_PREFIXES: &[&str] = &[
    "scripts/",
    "hooks/",
    "mcp/servers.json",
    "systemprompt.md",
    "guardrails.md",
];

pub const IMMUTABLE_L0_PATH_PATTERNS: &[&str] = &[
    ".git",
    ".git/",
    "src-tauri/",
    "packages/protocol/",
    "packages/interfaces/",
    ".ssh/",
    "trust.json",
];

pub fn is_high_privilege_harness_path(rel_path: &str) -> bool {
    let norm = rel_path.replace('\\', "/");
    let trimmed = norm.trim_start_matches("./");
    HIGH_PRIVILEGE_HARNESS_PREFIXES.iter().any(|prefix| {
        if prefix.ends_with('/') {
            trimmed.starts_with(prefix)
        } else {
            trimmed == *prefix
        }
    })
}

pub fn is_immutable_l0_path(rel_path: &str) -> bool {
    let norm = rel_path.replace('\\', "/");
    let trimmed = norm.trim_start_matches("./");
    IMMUTABLE_L0_PATH_PATTERNS.iter().any(|pat| {
        trimmed == *pat || trimmed.starts_with(pat) || trimmed.contains(&format!("/{pat}"))
    })
}

// --- JSON-RPC 2.0 ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum JsonRpcId {
    String(String),
    Number(i64),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: JsonRpcId,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: Option<JsonRpcId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcNotification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

pub mod rpc_error_code {
    pub const PARSE_ERROR: i32 = -32700;
    pub const INVALID_REQUEST: i32 = -32600;
    pub const METHOD_NOT_FOUND: i32 = -32601;
    pub const INVALID_PARAMS: i32 = -32602;
    pub const INTERNAL_ERROR: i32 = -32603;
    pub const SANDBOX_DENIED: i32 = -32001;
    pub const APPROVAL_REQUIRED: i32 = -32002;
    pub const APPROVAL_DENIED: i32 = -32003;
    pub const HOOK_UNTRUSTED: i32 = -32004;
    pub const BUDGET_EXCEEDED: i32 = -32005;
    pub const IMMUTABLE_PATH_VIOLATION: i32 = -32006;
    pub const GIT_MERGE_CONFLICT: i32 = -32007;
    pub const SIDECAR_UNAVAILABLE: i32 = -32008;
    pub const SIDECAR_RPC_TIMEOUT: i32 = -32009;
}

// --- Core Enums ---

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxMode {
    WorkspaceWrite,
    ReadOnly,
    CowShadow,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RsiMode {
    Manual,
    Auto,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UntrustedSourceTag {
    Local,
    Web,
    ExternalFile,
    UntrustedMcp,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TrustStatus {
    Trusted,
    Untrusted,
    Disabled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TrustKind {
    Hook,
    Mcp,
    Script,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TrustOrigin {
    UserInstalled,
    RsiEvolved,
    ImportedGenome,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecPolicyAction {
    Allow,
    Prompt,
    Forbidden,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    AllowOnce,
    AllowSession,
    Deny,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalRequestKind {
    SandboxEscape,
    ShellCommand,
    HookTrust,
    McpTrust,
    HighPrivilegeProposal,
}

// --- L0 Side-Effect Intents & Results ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecWriteFileIntent {
    pub thread_id: String,
    pub workspace_root: String,
    pub target_path: String,
    pub content: String,
    pub sandbox_mode: SandboxMode,
    #[serde(default)]
    pub source_tags: Vec<UntrustedSourceTag>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecDeleteFileIntent {
    pub thread_id: String,
    pub workspace_root: String,
    pub target_path: String,
    pub sandbox_mode: SandboxMode,
    #[serde(default)]
    pub source_tags: Vec<UntrustedSourceTag>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecShellIntent {
    pub thread_id: String,
    pub workspace_root: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub sandbox_mode: SandboxMode,
    #[serde(default)]
    pub allow_network: bool,
    pub timeout_ms: u64,
    #[serde(default)]
    pub source_tags: Vec<UntrustedSourceTag>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecScriptIntent {
    pub thread_id: String,
    pub workspace_root: String,
    pub script_path: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub sandbox_mode: SandboxMode,
    #[serde(default)]
    pub allow_network: bool,
    pub timeout_ms: u64,
    #[serde(default)]
    pub source_tags: Vec<UntrustedSourceTag>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecHookIntent {
    pub thread_id: String,
    pub workspace_root: String,
    pub hook_path: String,
    pub event: String,
    pub payload_json: String,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub ok: bool,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    pub sandbox_backend: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub denied_reason: Option<String>,
}

// --- Security, Trust Store & Guardian ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecPolicyRule {
    pub id: String,
    pub prefix: String,
    pub action: ExecPolicyAction,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustRecord {
    pub id: String,
    pub kind: TrustKind,
    pub identifier: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    pub status: TrustStatus,
    pub origin: TrustOrigin,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalHookItem {
    pub path: String,
    pub name: String,
    pub event: String,
    pub content: String,
    pub sha256: String,
    pub status: TrustStatus,
    pub origin: TrustOrigin,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub request_id: String,
    pub thread_id: String,
    pub kind: ApprovalRequestKind,
    pub summary: String,
    pub detail: String,
    pub command_or_path: String,
    pub risk_level: RiskLevel,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_sha256: Option<String>,
    #[serde(default)]
    pub source_tags: Vec<UntrustedSourceTag>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardianDecision {
    pub request_id: String,
    pub thread_id: String,
    pub decision: String,
    pub risk_level: RiskLevel,
    pub reason: String,
    pub command_or_path: String,
    pub model_id: String,
    pub sanitized_input_only: bool,
    pub timestamp: String,
}

// --- Git Store & Export/Import ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenomeCommit {
    pub sha: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_sha: Option<String>,
    pub version_tag: String,
    pub message: String,
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pass_rate: Option<f64>,
    #[serde(default)]
    pub changed_components: Vec<String>,
    #[serde(default)]
    pub is_rollback: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessPatchOp {
    pub path: String,
    pub op: String, // "upsert" | "delete"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitPatchParams {
    pub base_commit_sha: String,
    pub message: String,
    pub domain: String,
    pub operations: Vec<HarnessPatchOp>,
    pub author_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitPatchResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_commit_sha: Option<String>,
    #[serde(default)]
    pub conflict: bool,
    #[serde(default)]
    pub conflicting_files: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretScanFinding {
    pub file: String,
    pub line: usize,
    pub rule: String,
    pub masked_snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportScanResult {
    pub included_files: Vec<String>,
    pub excluded_files: Vec<String>,
    pub findings: Vec<SecretScanFinding>,
    pub safe_to_export: bool,
}

// --- Budget & Health ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default)]
    pub cached_input_tokens: u64,
    #[serde(default)]
    pub reasoning_tokens: u64,
    #[serde(default)]
    pub cost_usd: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPricing {
    pub model_id: String,
    #[serde(rename = "inputPer1MUsd", alias = "inputPer1mUsd")]
    pub input_per_1m_usd: f64,
    #[serde(rename = "outputPer1MUsd", alias = "outputPer1mUsd")]
    pub output_per_1m_usd: f64,
    #[serde(
        rename = "cachedInputPer1MUsd",
        alias = "cachedInputPer1mUsd",
        skip_serializing_if = "Option::is_none"
    )]
    pub cached_input_per_1m_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStatus {
    pub daily_limit_usd: f64,
    pub spent_today_usd: f64,
    pub tokens_today: u64,
    #[serde(default)]
    pub unpriced_tokens_today: u64,
    #[serde(default)]
    pub unpriced_models_today: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_source: Option<String>,
    pub tripped: bool,
    pub pricing_table: Vec<ModelPricing>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingSyncParams {
    pub remote_url: Option<String>,
    pub hash_url: Option<String>,
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PricingSyncSource {
    Remote,
    Cache,
    Embedded,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingSyncResult {
    pub synced: bool,
    pub source: PricingSyncSource,
    pub model_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<chrono::DateTime<chrono::Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemHealth {
    pub sidecar_alive: bool,
    pub sidecar_restart_count: u64,
    pub platform: String,
    pub sandbox_backend: String,
    pub os_sandbox_level: String,
    pub bun_embedded_ok: bool,
    pub active_commit_sha: String,
    pub rsi_mode: RsiMode,
}

// --- Auto-Updater ---

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UpdatePhase {
    Idle,
    Checking,
    Available,
    Downloading,
    Ready,
    Installing,
    UpToDate,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum UpdateCompatLevel {
    #[default]
    Safe,
    AutoMigrate,
    Breaking,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub harness_schema_version: Option<u32>,
    #[serde(default)]
    pub compat_level: UpdateCompatLevel,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub migration_notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub phase: UpdatePhase,
    pub info: UpdateInfo,
    #[serde(default)]
    pub downloaded_bytes: u64,
    #[serde(default)]
    pub total_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloaded_path: Option<String>,
    #[serde(default)]
    pub verified_sha256: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn model_pricing_serializes_to_the_typescript_contract() {
        let mut price = ModelPricing {
            model_id: "test".into(),
            input_per_1m_usd: 1.0,
            output_per_1m_usd: 2.0,
            cached_input_per_1m_usd: Some(0.1),
        };
        assert_eq!(
            serde_json::to_value(&price).unwrap(),
            json!({
                "modelId": "test", "inputPer1MUsd": 1.0, "outputPer1MUsd": 2.0,
                "cachedInputPer1MUsd": 0.1,
            })
        );
        price.cached_input_per_1m_usd = None;
        assert_eq!(
            serde_json::to_value(&price).unwrap(),
            json!({
                "modelId": "test", "inputPer1MUsd": 1.0, "outputPer1MUsd": 2.0,
            })
        );
    }

    #[test]
    fn model_pricing_loads_legacy_field_names() {
        let price: ModelPricing = serde_json::from_value(json!({
            "modelId": "test", "inputPer1mUsd": 1.0, "outputPer1mUsd": 2.0,
            "cachedInputPer1mUsd": 0.1,
        }))
        .unwrap();
        assert_eq!(price.input_per_1m_usd, 1.0);
        assert_eq!(price.output_per_1m_usd, 2.0);
        assert_eq!(price.cached_input_per_1m_usd, Some(0.1));
    }

    #[test]
    fn budget_status_round_trips_model_pricing() {
        let wire = json!({
            "dailyLimitUsd": 5.0, "spentTodayUsd": 0.5, "tokensToday": 100,
            "unpricedTokensToday": 0, "unpricedModelsToday": [], "costSource": "estimated",
            "tripped": false, "pricingTable": [{
                "modelId": "test", "inputPer1MUsd": 1.0, "outputPer1MUsd": 2.0,
                "cachedInputPer1MUsd": 0.1,
            }],
        });
        let status: BudgetStatus = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(status).unwrap(), wire);
    }

    #[test]
    fn path_classification_matches_protocol() {
        assert!(is_high_privilege_harness_path("scripts/parse.ts"));
        assert!(is_high_privilege_harness_path("hooks/trim.ts"));
        assert!(is_high_privilege_harness_path("mcp/servers.json"));
        assert!(is_high_privilege_harness_path("systemprompt.md"));
        assert!(is_high_privilege_harness_path("guardrails.md"));
        assert!(!is_high_privilege_harness_path("memory/LongTermMEMORY.md"));

        assert!(is_immutable_l0_path(".git/HEAD"));
        assert!(is_immutable_l0_path("src-tauri/src/main.rs"));
        assert!(is_immutable_l0_path("packages/protocol/src/index.ts"));
        assert!(!is_immutable_l0_path("scripts/safe.ts"));
    }

    #[test]
    fn json_camel_case_roundtrip() {
        let intent = ExecWriteFileIntent {
            thread_id: "t1".into(),
            workspace_root: "/work".into(),
            target_path: "out.csv".into(),
            content: "a,b\n1,2\n".into(),
            sandbox_mode: SandboxMode::WorkspaceWrite,
            source_tags: vec![UntrustedSourceTag::Local],
        };
        let raw = serde_json::to_string(&intent).unwrap();
        assert!(raw.contains("\"threadId\":\"t1\""));
        assert!(raw.contains("\"sandboxMode\":\"workspace-write\""));
        let decoded: ExecWriteFileIntent = serde_json::from_str(&raw).unwrap();
        assert_eq!(decoded.thread_id, "t1");
    }
}
