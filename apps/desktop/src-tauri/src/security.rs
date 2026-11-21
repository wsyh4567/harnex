use crate::{persist_json, protocol::*};
use chrono::Utc;
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Default)]
pub struct ExecPolicy {
    rules: Vec<ExecPolicyRule>,
}

impl ExecPolicy {
    pub fn rules(&self) -> &[ExecPolicyRule] {
        &self.rules
    }

    pub fn upsert(&mut self, rule: ExecPolicyRule) -> io::Result<()> {
        if rule.id.trim().is_empty()
            || rule.prefix.trim().is_empty()
            || rule.prefix.chars().any(char::is_control)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid policy rule",
            ));
        }
        self.delete(&rule.id);
        self.rules.push(rule);
        Ok(())
    }

    pub fn delete(&mut self, id: &str) {
        self.rules.retain(|rule| rule.id != id);
    }

    fn matches(prefix: &str, command: &str, args: &[String]) -> bool {
        let mut words = prefix.split_whitespace();
        if words.next() != Some(command) {
            return false;
        }
        words
            .enumerate()
            .all(|(index, word)| args.get(index).is_some_and(|arg| arg == word))
    }

    pub fn evaluate(&self, command: &str, args: &[String]) -> ExecPolicyAction {
        let executable = command
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(command)
            .to_ascii_lowercase();
        let executable = executable.strip_suffix(".exe").unwrap_or(&executable);
        if [
            "sudo", "su", "doas", "runas", "git", "mkfs", "diskpart", "shutdown", "reboot",
            "mount", "umount", "dd", "reg", "bcdedit", "takeown", "icacls",
        ]
        .iter()
        .any(|name| executable == *name || (*name == "mkfs" && executable.starts_with("mkfs.")))
        {
            return ExecPolicyAction::Forbidden;
        }
        let mut matches = self
            .rules
            .iter()
            .filter(|rule| Self::matches(&rule.prefix, command, args));
        if matches
            .clone()
            .any(|rule| rule.action == ExecPolicyAction::Forbidden)
        {
            return ExecPolicyAction::Forbidden;
        }
        if let Some(rule) = matches.by_ref().max_by_key(|rule| {
            (
                rule.prefix.split_whitespace().count(),
                rule.action == ExecPolicyAction::Prompt,
            )
        }) {
            return rule.action;
        }
        if matches!(
            command,
            "pwd" | "whoami" | "ls" | "cat" | "wc" | "head" | "tail"
        ) {
            ExecPolicyAction::Allow
        } else {
            ExecPolicyAction::Prompt
        }
    }
}

pub fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub struct TrustStore {
    path: PathBuf,
    records: Mutex<Vec<TrustRecord>>,
}

impl TrustStore {
    pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        let path = path.as_ref().to_owned();
        let records = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e),
        };
        Ok(Self {
            path,
            records: Mutex::new(records),
        })
    }

    pub fn open_default() -> io::Result<Self> {
        Self::open(
            dirs::home_dir()
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::NotFound, "home directory unavailable")
                })?
                .join(".harnex/trust.json"),
        )
    }

    pub fn list(&self) -> Vec<TrustRecord> {
        self.records.lock().unwrap().clone()
    }

    pub fn get(&self, kind: TrustKind, identifier: &str) -> Option<TrustRecord> {
        self.records
            .lock()
            .unwrap()
            .iter()
            .find(|r| r.kind == kind && r.identifier == identifier)
            .cloned()
    }

    pub fn is_trusted(&self, kind: TrustKind, identifier: &str, bytes: &[u8]) -> bool {
        self.get(kind, identifier).is_some_and(|record| {
            record.status == TrustStatus::Trusted
                && record.sha256.as_deref() == Some(sha256(bytes).as_str())
        })
    }

    pub fn register(
        &self,
        kind: TrustKind,
        identifier: &str,
        bytes: &[u8],
        origin: TrustOrigin,
    ) -> io::Result<TrustRecord> {
        let status = if origin == TrustOrigin::UserInstalled && kind == TrustKind::Mcp {
            TrustStatus::Trusted
        } else {
            TrustStatus::Untrusted
        };
        self.update(|records| {
            let next = make_record(kind, identifier, bytes, origin, status);
            if let Some(old) = records
                .iter()
                .find(|r| r.id == next.id && r.sha256 == next.sha256 && r.origin == next.origin)
            {
                return Ok(old.clone());
            }
            save_record(records, next.clone());
            Ok(next)
        })
    }

    pub fn mark_imported<'a>(
        &self,
        assets: impl IntoIterator<Item = (TrustKind, &'a str, &'a [u8])>,
    ) -> io::Result<()> {
        self.update(|records| {
            for (kind, identifier, bytes) in assets {
                save_record(
                    records,
                    make_record(
                        kind,
                        identifier,
                        bytes,
                        TrustOrigin::ImportedGenome,
                        TrustStatus::Disabled,
                    ),
                );
            }
            Ok(())
        })
    }

    /// Call only from a human approval surface after showing `expected_sha256`.
    pub fn trust(
        &self,
        kind: TrustKind,
        identifier: &str,
        bytes: &[u8],
        expected_sha256: &str,
    ) -> io::Result<TrustRecord> {
        if sha256(bytes) != expected_sha256 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "asset changed since review",
            ));
        }
        self.update(|records| {
            let origin = records
                .iter()
                .find(|r| r.kind == kind && r.identifier == identifier)
                .map_or(TrustOrigin::UserInstalled, |r| r.origin);
            let next = make_record(kind, identifier, bytes, origin, TrustStatus::Trusted);
            save_record(records, next.clone());
            Ok(next)
        })
    }

    pub fn revoke(&self, id: &str, status: TrustStatus) -> io::Result<()> {
        if status == TrustStatus::Trusted {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "trust requires digest confirmation",
            ));
        }
        self.update(|records| {
            let record = records
                .iter_mut()
                .find(|r| r.id == id)
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "trust record not found"))?;
            record.status = status;
            record.updated_at = Utc::now().to_rfc3339();
            Ok(())
        })
    }

    fn update<T>(
        &self,
        edit: impl FnOnce(&mut Vec<TrustRecord>) -> io::Result<T>,
    ) -> io::Result<T> {
        let mut locked = self.records.lock().unwrap();
        let mut next = locked.clone();
        let result = edit(&mut next)?;
        persist_json(&self.path, &next)?;
        *locked = next;
        Ok(result)
    }

    pub(crate) fn save_user_hook(
        &self,
        path: &str,
        bytes: &[u8],
        status: TrustStatus,
    ) -> io::Result<TrustRecord> {
        self.update(|records| {
            let record = make_record(
                TrustKind::Hook,
                path,
                bytes,
                TrustOrigin::UserInstalled,
                status,
            );
            save_record(records, record.clone());
            Ok(record)
        })
    }

    pub(crate) fn file_record(&self, path: &str, bytes: &[u8], snapshot_date: &str) -> TrustRecord {
        let mut record = make_record(
            TrustKind::Hook,
            path,
            bytes,
            TrustOrigin::UserInstalled,
            TrustStatus::Untrusted,
        );
        record.updated_at = snapshot_date.into();
        if let Some(stored) = self.get(TrustKind::Hook, path) {
            record.status = match stored.status {
                TrustStatus::Trusted if self.is_trusted(TrustKind::Hook, path, bytes) => {
                    TrustStatus::Trusted
                }
                TrustStatus::Disabled => TrustStatus::Disabled,
                _ => TrustStatus::Untrusted,
            };
            record.origin = stored.origin;
            record.updated_at = stored.updated_at;
        }
        record
    }

    pub fn remove(&self, kind: TrustKind, identifier: &str) -> io::Result<()> {
        self.update(|records| {
            records.retain(|record| record.kind != kind || record.identifier != identifier);
            Ok(())
        })
    }
}

fn make_record(
    kind: TrustKind,
    identifier: &str,
    bytes: &[u8],
    origin: TrustOrigin,
    status: TrustStatus,
) -> TrustRecord {
    TrustRecord {
        id: sha256(format!("{kind:?}\0{identifier}").as_bytes()),
        kind,
        identifier: identifier.into(),
        sha256: Some(sha256(bytes)),
        status,
        origin,
        updated_at: Utc::now().to_rfc3339(),
    }
}

fn save_record(records: &mut Vec<TrustRecord>, record: TrustRecord) {
    records.retain(|old| old.id != record.id);
    records.push(record);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_and_exact_bytes_determine_persisted_trust() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("trust.json");
        let store = TrustStore::open(&path).unwrap();
        let hook = "hooks/a.ts";
        assert_eq!(
            store
                .register(TrustKind::Hook, hook, b"a", TrustOrigin::UserInstalled)
                .unwrap()
                .status,
            TrustStatus::Untrusted
        );
        store
            .trust(TrustKind::Hook, hook, b"a", &sha256(b"a"))
            .unwrap();
        assert!(
            store
                .register(TrustKind::Hook, hook, b"a", TrustOrigin::UserInstalled)
                .unwrap()
                .status
                == TrustStatus::Trusted
        );
        assert!(TrustStore::open(&path)
            .unwrap()
            .is_trusted(TrustKind::Hook, hook, b"a"));
        assert!(!store.is_trusted(TrustKind::Hook, hook, b"b"));
        assert!(store
            .trust(TrustKind::Hook, hook, b"b", &sha256(b"a"))
            .is_err());
        assert_eq!(
            store
                .register(TrustKind::Mcp, "local", b"a", TrustOrigin::UserInstalled)
                .unwrap()
                .status,
            TrustStatus::Trusted
        );
        assert_eq!(
            store
                .register(TrustKind::Mcp, "local", b"b", TrustOrigin::RsiEvolved)
                .unwrap()
                .status,
            TrustStatus::Untrusted
        );
        store
            .mark_imported([(TrustKind::Hook, hook, b"a".as_slice())])
            .unwrap();
        assert_eq!(
            store.get(TrustKind::Hook, hook).unwrap().status,
            TrustStatus::Disabled
        );
    }

    #[test]
    fn policy_matches_whole_arguments_and_forbid_is_sticky() {
        let mut policy = ExecPolicy::default();
        policy
            .upsert(ExecPolicyRule {
                id: "allow".into(),
                prefix: "test run".into(),
                action: ExecPolicyAction::Allow,
                description: String::new(),
            })
            .unwrap();
        assert_eq!(
            policy.evaluate("test", &["run".into()]),
            ExecPolicyAction::Allow
        );
        assert_eq!(
            policy.evaluate("test", &["runner".into()]),
            ExecPolicyAction::Prompt
        );
        assert_eq!(
            policy.evaluate("/usr/bin/sudo", &[]),
            ExecPolicyAction::Forbidden
        );
        assert_eq!(policy.evaluate("cat", &[]), ExecPolicyAction::Allow);
    }
}
