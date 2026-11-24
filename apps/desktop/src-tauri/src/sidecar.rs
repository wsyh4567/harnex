use crate::protocol::{rpc_error_code, JsonRpcError, JsonRpcId, JsonRpcRequest, JsonRpcResponse};
use serde_json::Value;
use std::{
    collections::HashMap, ffi::OsString, future::Future, io, path::PathBuf, pin::Pin,
    process::Stdio, sync::Arc, time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{mpsc, oneshot, watch, Semaphore},
    time::{self, Instant},
};

const FRAME_LIMIT: u64 = 8 * 1024 * 1024;
const HEARTBEAT: &str = "system.heartbeat";
const PROBE_INTERVAL: Duration = Duration::from_millis(250);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_millis(1250);
const RESTART_DELAY: Duration = Duration::from_millis(150);

type Reply = oneshot::Sender<Result<Value, JsonRpcError>>;
type HandlerFuture = Pin<Box<dyn Future<Output = Result<Value, JsonRpcError>> + Send>>;
pub type RpcHandler = Arc<dyn Fn(JsonRpcRequest) -> HandlerFuture + Send + Sync>;

#[derive(Clone, Copy, Debug, Default)]
pub struct SidecarHealth {
    pub alive: bool,
    pub restart_count: u64,
}

#[derive(Clone)]
pub struct Sidecar {
    tx: mpsc::Sender<Call>,
    health: watch::Receiver<SidecarHealth>,
}

struct Call {
    method: String,
    params: Value,
    reply: Reply,
}

pub fn rpc_error(code: i32, message: impl Into<String>) -> JsonRpcError {
    JsonRpcError {
        code,
        message: message.into(),
        data: None,
    }
}

fn unavailable() -> JsonRpcError {
    rpc_error(rpc_error_code::SIDECAR_UNAVAILABLE, "sidecar unavailable")
}

fn timeout_for_method(method: &str) -> Duration {
    Duration::from_secs(match method {
        "evolution.trigger"
        | "evolution.revise_with_comments"
        | "evolution.start_migration"
        | "replay.compare" => 900,
        "sidechat.ask"
        | "provider.fetch_models"
        | "provider.ping"
        | "provider.import_magpie"
        | "evolution.architect_chat"
        | "budget.sync_pricing" => 90,
        _ => 30,
    })
}

impl Sidecar {
    pub fn start(executable: PathBuf, args: Vec<OsString>, handler: Option<RpcHandler>) -> Self {
        let (tx, rx) = mpsc::channel(64);
        let (updates, health) = watch::channel(SidecarHealth::default());
        tokio::spawn(supervise(executable, args, rx, updates, handler));
        Self { tx, health }
    }

    pub fn health(&self) -> SidecarHealth {
        *self.health.borrow()
    }
    pub fn subscribe(&self) -> watch::Receiver<SidecarHealth> {
        self.health.clone()
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, JsonRpcError> {
        self.call_with_timeout(method, params, timeout_for_method(method))
            .await
    }

    pub async fn call_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, JsonRpcError> {
        let (reply, receive) = oneshot::channel();
        self.tx
            .try_send(Call {
                method: method.into(),
                params,
                reply,
            })
            .map_err(|_| unavailable())?;
        time::timeout(timeout, receive)
            .await
            .map_err(|_| {
                if self.health().alive {
                    rpc_error(
                        rpc_error_code::SIDECAR_RPC_TIMEOUT,
                        format!("sidecar RPC timed out waiting for {method}"),
                    )
                } else {
                    unavailable()
                }
            })?
            .map_err(|_| unavailable())?
    }
}

async fn supervise(
    executable: PathBuf,
    args: Vec<OsString>,
    mut calls: mpsc::Receiver<Call>,
    health: watch::Sender<SidecarHealth>,
    handler: Option<RpcHandler>,
) {
    let mut count = 0u64;
    let inflight = Arc::new(Semaphore::new(32));
    while !calls.is_closed() {
        let mut command = Command::new(&executable);
        command
            .args(&args)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        if let Ok(system) = crate::sandbox_os::windows::system_directory() {
            if let Some(root) = system.parent() {
                command.env("SystemRoot", root);
            }
        }
        if let Ok(mut child) = command.spawn() {
            let mut stdin = child.stdin.take().unwrap();
            let mut stdout = BufReader::new(child.stdout.take().unwrap());
            let mut pending: HashMap<i64, Reply> = HashMap::new();
            let (answers, mut incoming) = mpsc::channel(32);
            let mut handlers = tokio::task::JoinSet::new();
            let mut line = Vec::new();
            let mut next_id = 0i64;
            let mut probe = time::interval(PROBE_INTERVAL);
            probe.set_missed_tick_behavior(time::MissedTickBehavior::Delay);
            let mut last_pong = Instant::now();
            loop {
                tokio::select! {
                    _ = child.wait() => break,
                    _ = handlers.join_next(), if !handlers.is_empty() => {},
                    _ = probe.tick() => {
                        if last_pong.elapsed() >= HEARTBEAT_TIMEOUT { break; }
                        let request = JsonRpcRequest { jsonrpc: "2.0".into(), id: JsonRpcId::Number(-1), method: HEARTBEAT.into(), params: None };
                        if write_frame(&mut stdin, &request).await.is_err() { break; }
                    }
                    received = calls.recv() => {
                        let Some(call) = received else { break; };
                        if call.reply.is_closed() { continue; }
                        pending.retain(|_, reply| !reply.is_closed());
                        if pending.len() >= 64 { let _ = call.reply.send(Err(unavailable())); continue; }
                        next_id = next_id.wrapping_add(1).max(0);
                        let request = JsonRpcRequest { jsonrpc: "2.0".into(), id: JsonRpcId::Number(next_id), method: call.method, params: Some(call.params) };
                        pending.insert(next_id, call.reply);
                        if write_frame(&mut stdin, &request).await.is_err() { break; }
                    }
                    Some(response) = incoming.recv() => {
                        if write_frame(&mut stdin, &response).await.is_err() { break; }
                    }
                    read = read_frame(&mut stdout, &mut line) => {
                        let Ok(Some(message)) = read else { break; };
                        if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") { break; }
                        if message.get("method").is_some() {
                            if message.get("id").is_none() { continue; }
                            let Ok(request) = serde_json::from_value::<JsonRpcRequest>(message) else { break; };
                            if let Ok(permit) = inflight.clone().try_acquire_owned() {
                                let handler = handler.clone();
                                let answers = answers.clone();
                                handlers.spawn(async move {
                                    let _permit = permit;
                                    let id = request.id.clone();
                                    let result = if request.method == HEARTBEAT { Ok(serde_json::json!({"ok": true})) }
                                        else if let Some(handler) = handler { handler(request).await }
                                        else { Err(rpc_error(rpc_error_code::METHOD_NOT_FOUND, "method unavailable")) };
                                    let response = match result {
                                        Ok(value) => JsonRpcResponse { jsonrpc: "2.0".into(), id: Some(id), result: Some(value), error: None },
                                        Err(error) => JsonRpcResponse { jsonrpc: "2.0".into(), id: Some(id), result: None, error: Some(error) },
                                    };
                                    let _ = answers.send(response).await;
                                });
                            } else {
                                let response = JsonRpcResponse { jsonrpc: "2.0".into(), id: Some(request.id), result: None, error: Some(unavailable()) };
                                if write_frame(&mut stdin, &response).await.is_err() { break; }
                            }
                        } else {
                            let Some(id) = message.get("id").and_then(Value::as_i64) else { continue; };
                            if id == -1 && (message.get("result").is_some() || message.get("error").is_some()) {
                                last_pong = Instant::now();
                                health.send_if_modified(|state| {
                                    let changed = !state.alive || state.restart_count != count;
                                    *state = SidecarHealth { alive: true, restart_count: count };
                                    changed
                                });
                            } else if let Some(reply) = pending.remove(&id) {
                                let result = if let Some(value) = message.get("result") { Ok(value.clone()) }
                                    else { Err(message.get("error").cloned().and_then(|value| serde_json::from_value(value).ok()).unwrap_or_else(unavailable)) };
                                let _ = reply.send(result);
                            }
                        }
                    }
                }
            }
            handlers.abort_all();
            let _ = child.start_kill();
            let _ = time::timeout(Duration::from_millis(200), child.wait()).await;
            for (_, reply) in pending {
                let _ = reply.send(Err(unavailable()));
            }
        }
        health.send_replace(SidecarHealth {
            alive: false,
            restart_count: count,
        });
        let retry = time::sleep(RESTART_DELAY);
        tokio::pin!(retry);
        loop {
            tokio::select! {
                _ = &mut retry => break,
                call = calls.recv() => match call {
                    Some(call) => { let _ = call.reply.send(Err(unavailable())); }
                    None => return,
                }
            }
        }
        count = count.saturating_add(1);
    }
}

async fn read_frame<T: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut T,
    line: &mut Vec<u8>,
) -> io::Result<Option<Value>> {
    loop {
        let filled = reader.fill_buf().await?;
        if filled.is_empty() {
            return Ok(None);
        }
        let newline = filled.iter().position(|&byte| byte == b'\n');
        let used = newline.map_or(filled.len(), |index| index + 1);
        if (line.len() + used) as u64 > FRAME_LIMIT {
            return Err(io::Error::other("JSON-RPC frame exceeds limit"));
        }
        line.extend_from_slice(&filled[..used]);
        reader.consume(used);
        if newline.is_some() {
            let value = serde_json::from_slice(line);
            line.clear();
            return value.map(Some).map_err(io::Error::other);
        }
    }
}

async fn write_frame(
    writer: &mut (impl AsyncWriteExt + Unpin),
    value: &impl serde::Serialize,
) -> io::Result<()> {
    let mut line = serde_json::to_vec(value)?;
    line.push(b'\n');
    if line.len() as u64 > FRAME_LIMIT {
        return Err(io::Error::other("JSON-RPC frame exceeds limit"));
    }
    time::timeout(Duration::from_millis(300), writer.write_all(&line))
        .await
        .map_err(io::Error::other)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rpc_timeout_matches_the_method_tier() {
        for (method, seconds) in [
            ("evolution.trigger", 900),
            ("evolution.revise_with_comments", 900),
            ("evolution.start_migration", 900),
            ("replay.compare", 900),
            ("sidechat.ask", 90),
            ("provider.fetch_models", 90),
            ("provider.ping", 90),
            ("provider.import_magpie", 90),
            ("evolution.architect_chat", 90),
            ("budget.sync_pricing", 90),
            ("evolution.list_proposals", 30),
            (HEARTBEAT, 30),
        ] {
            assert_eq!(
                timeout_for_method(method),
                Duration::from_secs(seconds),
                "{method}"
            );
        }
    }
}
