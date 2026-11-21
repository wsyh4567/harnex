use crate::{
    git_store::{GenomeBundle, GitStore},
    protocol::*,
    sandbox_os::validate_relative,
    security::TrustStore,
};
use serde_json::{json, Map, Value};
use std::{io, sync::Mutex};

const CONFIG: &str = "hooks/config.json";
const EVENTS: [&str; 3] = ["PreToolUse", "PostToolUse", "SessionStart"];
static HOOK_EDIT: Mutex<()> = Mutex::new(());

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn hook_name(path: &str) -> io::Result<&str> {
    validate_relative(path)?;
    path.strip_prefix("hooks/")
        .and_then(|path| path.strip_suffix(".ts"))
        .filter(|name| {
            !name.is_empty()
                && !name.contains("..")
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        })
        .ok_or_else(|| invalid("expected a TypeScript file directly under hooks/"))
}

fn configuration(tree: &GenomeBundle) -> io::Result<Map<String, Value>> {
    tree.get(CONFIG).map_or_else(
        || Ok(Map::new()),
        |content| serde_json::from_str(content).map_err(io::Error::other),
    )
}

fn event_name(text: &str) -> Option<&str> {
    let word = text
        .trim_start_matches(|ch: char| ch.is_whitespace() || matches!(ch, ':' | '\'' | '"'))
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .next()?;
    EVENTS.contains(&word).then_some(word)
}

fn event_hint(content: &str) -> &str {
    content
        .lines()
        .find_map(|line| {
            let line = line
                .trim_start()
                .trim_start_matches(['/', '*'])
                .trim_start();
            line.strip_prefix("@event")
                .or_else(|| line.strip_prefix("event:"))
                .or_else(|| line.strip_prefix("\"event\":"))
                .or_else(|| line.strip_prefix("'event':"))
                .and_then(event_name)
        })
        .unwrap_or("PostToolUse")
}

fn item(
    path: &str,
    name: &str,
    content: &str,
    config: Option<&Value>,
    record: TrustRecord,
) -> io::Result<GlobalHookItem> {
    let enabled = config
        .and_then(|value| value.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(!name.starts_with("example_"));
    let status = if enabled {
        record.status
    } else {
        TrustStatus::Disabled
    };
    let event = config
        .and_then(|value| value.pointer("/events/0"))
        .and_then(Value::as_str)
        .filter(|event| EVENTS.contains(event))
        .unwrap_or_else(|| event_hint(content));
    let mut data = serde_json::to_value(record)?;
    data["path"] = json!(path);
    data["name"] = json!(name);
    data["event"] = json!(event);
    data["content"] = json!(content);
    data["status"] = json!(status);
    serde_json::from_value(data).map_err(io::Error::other)
}

pub fn list_global_hooks(git: &GitStore, trust: &TrustStore) -> io::Result<Vec<GlobalHookItem>> {
    let _edit = HOOK_EDIT.lock().unwrap();
    let head = git
        .log(1)
        .map_err(io::Error::other)?
        .pop()
        .ok_or_else(|| invalid("no genome snapshot"))?;
    let tree = git.read_tree(&head.sha).map_err(io::Error::other)?;
    let config = configuration(&tree)?;
    tree.iter()
        .filter_map(|(path, content)| {
            let name = hook_name(path).ok()?;
            let record = trust.file_record(path, content.as_bytes(), &head.timestamp);
            Some(item(path, name, content, config.get(path), record))
        })
        .collect()
}

pub fn upsert_global_hook(
    git: &GitStore,
    trust: &TrustStore,
    path: &str,
    event: &str,
    content: &str,
    trust_immediately: bool,
) -> io::Result<GlobalHookItem> {
    let name = hook_name(path)?;
    if !EVENTS.contains(&event) {
        return Err(invalid("unknown hook event"));
    }
    let _edit = HOOK_EDIT.lock().unwrap();
    let base = git.head_sha().map_err(io::Error::other)?;
    let tree = git.read_tree(&base).map_err(io::Error::other)?;
    let mut config = configuration(&tree)?;
    config.insert(path.into(), json!({"enabled": true, "events": [event]}));
    let operations = vec![
        upsert(path, content.into()),
        upsert(CONFIG, serde_json::to_string_pretty(&config)?),
    ];
    let pending = if trust_immediately {
        None
    } else {
        Some(trust.save_user_hook(path, content.as_bytes(), TrustStatus::Untrusted)?)
    };
    commit(git, base, "Save global hook", operations)?;
    let record = match pending {
        Some(record) => record,
        None => trust.save_user_hook(path, content.as_bytes(), TrustStatus::Trusted)?,
    };
    item(path, name, content, config.get(path), record)
}

pub fn delete_global_hook(git: &GitStore, trust: &TrustStore, path: &str) -> io::Result<()> {
    hook_name(path)?;
    let _edit = HOOK_EDIT.lock().unwrap();
    let base = git.head_sha().map_err(io::Error::other)?;
    let tree = git.read_tree(&base).map_err(io::Error::other)?;
    let mut config = configuration(&tree)?;
    let mut operations = Vec::new();
    if tree.contains_key(path) {
        operations.push(HarnessPatchOp {
            path: path.into(),
            op: "delete".into(),
            content: None,
        });
    }
    if config.remove(path).is_some() {
        operations.push(upsert(CONFIG, serde_json::to_string_pretty(&config)?));
    }
    trust.remove(TrustKind::Hook, path)?;
    if !operations.is_empty() {
        commit(git, base, "Delete global hook", operations)?;
    }
    Ok(())
}

fn upsert(path: &str, content: String) -> HarnessPatchOp {
    HarnessPatchOp {
        path: path.into(),
        op: "upsert".into(),
        content: Some(content),
    }
}

fn commit(
    git: &GitStore,
    base_commit_sha: String,
    message: &str,
    operations: Vec<HarnessPatchOp>,
) -> io::Result<()> {
    let result = git
        .commit_patch(
            &GitCommitPatchParams {
                base_commit_sha,
                message: message.into(),
                domain: "hooks".into(),
                operations,
                author_name: "Harnex".into(),
            },
            true,
        )
        .map_err(io::Error::other)?;
    if !result.ok || result.conflict {
        return Err(io::Error::other(
            "hook changed concurrently; reload and retry",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_hook_lifecycle_updates_snapshot_and_trust() {
        let home = tempfile::tempdir().unwrap();
        let git = GitStore::open(home.path().join("harness")).unwrap();
        let trust_path = home.path().join("trust.json");
        let trust = TrustStore::open(&trust_path).unwrap();
        assert!(list_global_hooks(&git, &trust).unwrap().is_empty());
        let path = "hooks/trim.ts";
        let original = "// event: PostToolUse\nexport {};";
        let created =
            upsert_global_hook(&git, &trust, path, "SessionStart", original, true).unwrap();
        assert_eq!(created.event, "SessionStart");
        assert_eq!(created.content, original);
        assert_eq!(created.status, TrustStatus::Trusted);
        assert!(trust.is_trusted(TrustKind::Hook, path, original.as_bytes()));
        let first = git.head_sha().unwrap();

        let edited =
            upsert_global_hook(&git, &trust, path, "PreToolUse", "export { };", false).unwrap();
        assert_eq!(edited.status, TrustStatus::Untrusted);
        assert!(!trust.is_trusted(TrustKind::Hook, path, original.as_bytes()));
        assert_eq!(git.read_tree(&first).unwrap()[path], original);
        let list = list_global_hooks(&git, &TrustStore::open(&trust_path).unwrap()).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].event, "PreToolUse");
        assert_ne!(
            serde_json::to_value(&created).unwrap(),
            serde_json::to_value(&list[0]).unwrap()
        );
        assert_eq!(list[0].content, edited.content);

        let trusted =
            upsert_global_hook(&git, &trust, path, "PostToolUse", &edited.content, true).unwrap();
        assert_eq!(trusted.origin, TrustOrigin::UserInstalled);
        assert!(trust.is_trusted(TrustKind::Hook, path, edited.content.as_bytes()));
        delete_global_hook(&git, &trust, path).unwrap();
        assert!(list_global_hooks(&git, &trust).unwrap().is_empty());
        assert!(TrustStore::open(trust_path)
            .unwrap()
            .get(TrustKind::Hook, path)
            .is_none());
        assert_eq!(
            git.read_tree(&git.head_sha().unwrap()).unwrap()[CONFIG],
            "{}"
        );
    }

    #[test]
    fn list_checks_current_content_and_rejects_invalid_hook_paths() {
        let home = tempfile::tempdir().unwrap();
        let git = GitStore::open(home.path().join("harness")).unwrap();
        let trust = TrustStore::open(home.path().join("trust.json")).unwrap();
        let path = "hooks/fixture.ts";
        let base = git.head_sha().unwrap();
        for bad in [
            "hooks/../evil.ts",
            "scripts/a.ts",
            "hooks\\wrong.ts",
            "hooks/nested/a.ts",
            "hooks/.ts",
        ] {
            assert!(
                upsert_global_hook(&git, &trust, bad, "PostToolUse", "", true).is_err(),
                "{bad}"
            );
            assert!(delete_global_hook(&git, &trust, bad).is_err(), "{bad}");
        }
        assert!(upsert_global_hook(&git, &trust, path, "Unexpected", "", true).is_err());
        assert_eq!(git.head_sha().unwrap(), base);
        let old = "// @event SessionStart\nexport {};";
        trust
            .save_user_hook(path, old.as_bytes(), TrustStatus::Trusted)
            .unwrap();
        let new = "// @event PreToolUse\nexport {};";
        commit(&git, base, "Update fixture", vec![upsert(path, new.into())]).unwrap();
        let entry = list_global_hooks(&git, &trust).unwrap().pop().unwrap();
        assert_eq!(entry.event, "PreToolUse");
        assert_eq!(entry.status, TrustStatus::Untrusted);
        assert!(!trust.is_trusted(TrustKind::Hook, path, new.as_bytes()));
        let record = trust.get(TrustKind::Hook, path).unwrap();
        trust.revoke(&record.id, TrustStatus::Disabled).unwrap();
        assert_eq!(
            list_global_hooks(&git, &trust).unwrap()[0].status,
            TrustStatus::Disabled
        );
    }
}
