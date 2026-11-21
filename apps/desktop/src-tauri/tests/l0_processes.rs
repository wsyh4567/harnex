mod common;

use harnex_l0::{
    budget::Budget,
    executor::{ApprovalHandler, Executor},
    protocol::*,
    sandbox_os::Backend,
    security::TrustStore,
    sidecar::Sidecar,
};
use serde_json::{json, Value};
use std::{
    env, fs,
    io::{self, BufRead, Write},
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

fn fake_sidecar() {
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        match request["method"].as_str() {
            Some("crash") => std::process::exit(17),
            Some("hang") => std::thread::sleep(Duration::from_secs(15)),
            Some("evolution.trigger" | "echo.slow") => {
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(1500));
                    echo(&request);
                });
            }
            _ => echo(&request),
        }
    }
}

fn echo(request: &Value) {
    println!(
        "{}",
        json!({"jsonrpc": "2.0", "id": request["id"], "result": request["params"]})
    );
    io::stdout().flush().unwrap();
}

async fn enforce_process_file_boundary(executable: &Path) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("work");
    fs::create_dir_all(root.join("scripts")).unwrap();
    fs::write(
        root.join("scripts/probe.ts"),
        r#"
        import { writeFile } from "node:fs/promises";
        for (const path of Bun.argv.slice(2)) {
            try { await writeFile(path, "fixture marker"); }
            catch { continue; }
            throw new Error("Protected fixture was writable");
        }
        await writeFile("allowed.txt", "sandbox output");
    "#,
    )
    .unwrap();
    let mut protected = Vec::new();
    for path in [
        dir.path().join("outside.txt"),
        root.join(".git/config"),
        root.join(".harnex/harness/ref"),
        root.join(".ssh/key"),
        root.join("trust.json"),
        root.join("src-tauri/main.rs"),
    ] {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "original").unwrap();
        protected.push(path);
    }
    let trust = Arc::new(TrustStore::open(dir.path().join("trust.json")).unwrap());
    let budget = Arc::new(Budget::open(dir.path().join("budget.json")).unwrap());
    let approve: ApprovalHandler = Arc::new(|_| Box::pin(async { ApprovalDecision::AllowOnce }));
    let executor = Executor::new(trust, budget, executable.to_owned(), approve);
    let root_arg = root.to_string_lossy().into_owned();
    executor
        .bind_workspace(
            "thread",
            root_arg.clone(),
            SandboxMode::WorkspaceWrite,
            None,
        )
        .unwrap();
    let result = executor
        .exec_script(ExecScriptIntent {
            thread_id: "thread".into(),
            workspace_root: root_arg,
            script_path: "scripts/probe.ts".into(),
            args: protected
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect(),
            cwd: None,
            sandbox_mode: SandboxMode::WorkspaceWrite,
            allow_network: false,
            timeout_ms: 3000,
            source_tags: vec![],
        })
        .await
        .unwrap();
    assert!(result.ok, "{result:?}");
    assert_eq!(
        fs::read_to_string(root.join("allowed.txt")).unwrap(),
        "sandbox output"
    );
    for path in protected {
        assert_eq!(fs::read_to_string(path).unwrap(), "original");
    }
    println!("os_process_can_only_synchronize_allowed_workspace_output: ok");
}

async fn sidecar_restarts(method: &str) {
    let sidecar = Sidecar::start(
        env::current_exe().unwrap(),
        vec!["--stdio-child".into()],
        None,
    );
    let mut health = sidecar.subscribe();
    tokio::time::timeout(Duration::from_secs(5), health.wait_for(|h| h.alive))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        sidecar.call("echo", json!({"before": true})).await.unwrap(),
        json!({"before": true})
    );
    let start = Instant::now();
    tokio::time::timeout(Duration::from_secs(2), async {
        assert!(sidecar.call(method, Value::Null).await.is_err());
        let up = health
            .wait_for(|h| h.alive && h.restart_count > 0)
            .await
            .unwrap();
        assert_eq!(up.restart_count, 1);
    })
    .await
    .expect("sidecar must recover within two seconds");
    assert_eq!(
        sidecar.call("echo", json!("after")).await.unwrap(),
        json!("after")
    );
    println!(
        "sidecar_{method}_recovers: ok ({} ms)",
        start.elapsed().as_millis()
    );
}

async fn sidecar_keeps_heartbeats_alive_during_slow_rpcs() {
    let sidecar = Sidecar::start(
        env::current_exe().unwrap(),
        vec!["--stdio-child".into()],
        None,
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        sidecar
            .subscribe()
            .wait_for(|health| health.alive)
            .await
            .unwrap();
        let (evolution, timed_out) = tokio::join!(
            sidecar.call("evolution.trigger", json!("completed")),
            sidecar.call_with_timeout("echo.slow", Value::Null, Duration::from_millis(50)),
        );
        assert_eq!(evolution.unwrap(), json!("completed"));
        let error = timed_out.unwrap_err();
        assert_eq!(error.code, rpc_error_code::SIDECAR_RPC_TIMEOUT);
        assert_eq!(error.message, "sidecar RPC timed out waiting for echo.slow");
        assert_eq!(
            sidecar.call("echo", json!("after")).await.unwrap(),
            json!("after")
        );
        assert!(sidecar.health().alive);
        assert_eq!(sidecar.health().restart_count, 0);
    })
    .await
    .unwrap();
    println!("sidecar_keeps_heartbeats_alive_during_slow_rpcs: ok");
}

async fn enforce_hook_digest(executable: &Path) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("work");
    fs::create_dir_all(root.join("hooks")).unwrap();
    let path = root.join("hooks/trim.ts");
    let source = r#"console.log("hook-v1:" + Bun.argv[2] + ":" + await Bun.stdin.text())"#;
    fs::write(&path, source).unwrap();
    let root = root.to_string_lossy().into_owned();
    let trust = Arc::new(TrustStore::open(dir.path().join("trust.json")).unwrap());
    let budget = Arc::new(Budget::open(dir.path().join("budget.json")).unwrap());
    let calls = Arc::new(AtomicUsize::new(0));
    let approval: ApprovalHandler = Arc::new({
        let calls = calls.clone();
        move |request| {
            let count = calls.fetch_add(1, Ordering::Relaxed);
            assert_eq!(request.kind, ApprovalRequestKind::HookTrust);
            assert!(request.sha256.is_some());
            Box::pin(async move {
                if count == 0 {
                    ApprovalDecision::AllowOnce
                } else {
                    ApprovalDecision::Deny
                }
            })
        }
    });
    let executor = Executor::new(trust, budget, executable.to_owned(), approval);
    executor.set_mode(RsiMode::Auto);
    executor
        .bind_workspace("thread", root.clone(), SandboxMode::WorkspaceWrite, None)
        .unwrap();
    let intent = || ExecHookIntent {
        thread_id: "thread".into(),
        workspace_root: root.clone(),
        hook_path: "hooks/trim.ts".into(),
        event: "SessionStart".into(),
        payload_json: "{}".into(),
        timeout_ms: 3000,
    };

    if matches!(Backend::detect(), Backend::Unavailable) {
        assert_eq!(
            executor.exec_hook(intent()).await.unwrap_err().code,
            rpc_error_code::SANDBOX_DENIED
        );
        assert_eq!(calls.load(Ordering::Relaxed), 0);
        println!("os_backend_unavailable_fails_closed: ok");
        return;
    }
    let first = executor.exec_hook(intent()).await.unwrap();
    assert!(first.ok, "{first:?}");
    assert_eq!(first.stdout.trim(), "hook-v1:SessionStart:{}");
    assert_eq!(
        executor.exec_hook(intent()).await.unwrap().stdout.trim(),
        "hook-v1:SessionStart:{}"
    );
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    fs::write(path, source.replace("hook-v1", "hook-v2")).unwrap();
    assert_eq!(
        executor.exec_hook(intent()).await.unwrap_err().code,
        rpc_error_code::HOOK_UNTRUSTED
    );
    assert_eq!(calls.load(Ordering::Relaxed), 2);
    println!("trusted_hook_runs_without_prompt_until_one_byte_changes: ok");
}

#[tokio::main]
async fn main() {
    match env::args().nth(1).as_deref() {
        Some("--stdio-child") => fake_sidecar(),
        _ => {
            sidecar_restarts("crash").await;
            sidecar_restarts("hang").await;
            sidecar_keeps_heartbeats_alive_during_slow_rpcs().await;
            // Exercise AppContainer with the same loader dependencies as the embedded runtime.
            let binaries = tempfile::tempdir().unwrap();
            if let Some(executable) = common::compiled_bun(binaries.path()) {
                enforce_hook_digest(&executable).await;
                enforce_process_file_boundary(&executable).await;
            } else if matches!(Backend::detect(), Backend::Unavailable) {
                enforce_hook_digest(Path::new("")).await;
            }
        }
    }
}
