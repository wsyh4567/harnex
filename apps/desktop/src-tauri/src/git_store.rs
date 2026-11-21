use crate::{persist_json, protocol::*, sandbox_os::validate_relative, security::TrustStore};
use chrono::{TimeZone, Utc};
use git2::{ErrorCode, Oid, Repository, Signature, Tree};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};

const HEAD: &str = "refs/heads/main";
const WINDOW: usize = 10;
const MAX_BUNDLE: usize = 32 * 1024 * 1024;
pub type GenomeBundle = BTreeMap<String, String>;

#[derive(Debug, thiserror::Error)]
pub enum GitStoreError {
    #[error(transparent)]
    Git(#[from] git2::Error),
    #[error(transparent)]
    Storage(#[from] io::Error),
    #[error("{0}")]
    Invalid(String),
    #[error("a human must approve changes to {0}")]
    HumanApproval(String),
}

#[derive(Clone, Serialize, Deserialize)]
struct Sample {
    sha: String,
    success: bool,
}

type Domains = BTreeMap<String, VecDeque<Sample>>;

pub struct GitStore {
    inner: Mutex<Repository>,
    health_path: PathBuf,
    health: Mutex<Domains>,
}

impl GitStore {
    pub fn open_default() -> Result<Self, GitStoreError> {
        let home = dirs::home_dir()
            .ok_or_else(|| GitStoreError::Invalid("home directory unavailable".into()))?;
        Self::open_seeded(home.join(".harnex/harness"), None)
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, GitStoreError> {
        Self::open_with_initial_tree(path, || Ok(GenomeBundle::new()))
    }

    pub fn open_seeded(
        path: impl AsRef<Path>,
        directory: Option<&Path>,
    ) -> Result<Self, GitStoreError> {
        Self::open_with_initial_tree(path, || match directory {
            Some(directory) => load_seed(directory),
            None => Ok(GenomeBundle::from([
                (
                    "manifest.json".into(),
                    r#"{"schemaVersion":1,"name":"harnex-seed","version":"0.1.0"}"#.into(),
                ),
                (
                    "systemprompt.md".into(),
                    "Work within the user's request and the bound workspace.\n".into(),
                ),
                (
                    "guardrails.md".into(),
                    "Use the L0 executor for side effects.\n".into(),
                ),
            ])),
        })
    }

    fn open_with_initial_tree(
        path: impl AsRef<Path>,
        initial: impl FnOnce() -> Result<GenomeBundle, GitStoreError>,
    ) -> Result<Self, GitStoreError> {
        let path = path.as_ref();
        fs::create_dir_all(path)?;
        let repo = match Repository::open(path) {
            Ok(repo) => repo,
            Err(e) if e.code() == ErrorCode::NotFound => Repository::init_bare(path)?,
            Err(e) => return Err(e.into()),
        };
        match head(&repo) {
            Ok(_) => (),
            Err(e) if e.code() == ErrorCode::NotFound => {
                let seed = initial()?;
                validate_files(&seed)?;
                let tree = repo.find_tree(write_tree(&repo, &seed)?)?;
                let sig = Signature::now("Harnex", "l0@harnex.local")?;
                repo.commit(Some(HEAD), &sig, &sig, "Initialize harness", &tree, &[])?;
                repo.set_head(HEAD)?;
            }
            Err(e) => return Err(e.into()),
        }
        let health_path = repo.path().join("harnex-health.json");
        let health = match fs::read(&health_path) {
            Ok(data) => serde_json::from_slice(&data).map_err(io::Error::other)?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => BTreeMap::new(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self {
            inner: Mutex::new(repo),
            health_path,
            health: Mutex::new(health),
        })
    }

    pub fn head_sha(&self) -> Result<String, GitStoreError> {
        Ok(head(&self.inner.lock().unwrap())?.to_string())
    }

    pub fn create_backup_tag(&self, tag_name: &str, message: &str) -> io::Result<String> {
        let reference_name = format!("refs/tags/{tag_name}");
        if tag_name.is_empty()
            || tag_name.contains('\0')
            || !git2::Reference::is_valid_name(&reference_name)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid backup tag name",
            ));
        }
        let repo = self.inner.lock().unwrap();
        let target = repo
            .find_commit(head(&repo).map_err(io::Error::other)?)
            .map_err(io::Error::other)?;
        match repo.find_reference(&reference_name) {
            Ok(reference) => {
                if reference.peel_to_commit().map_err(io::Error::other)?.id() != target.id() {
                    return Err(io::Error::new(
                        io::ErrorKind::AlreadyExists,
                        "backup tag points at a different genome snapshot",
                    ));
                }
            }
            Err(error) if error.code() == ErrorCode::NotFound => {
                let signature =
                    Signature::now("Harnex", "l0@harnex.local").map_err(io::Error::other)?;
                repo.tag(tag_name, target.as_object(), &signature, message, false)
                    .map_err(io::Error::other)?;
            }
            Err(error) => return Err(io::Error::other(error)),
        }
        Ok(tag_name.to_owned())
    }

    pub fn read_schema_version(&self) -> u32 {
        let repo = self.inner.lock().unwrap();
        (|| {
            let commit = repo.find_commit(head(&repo).ok()?).ok()?;
            let tree = commit.tree().ok()?;
            let blob = repo.find_blob(tree.get_name("manifest.json")?.id()).ok()?;
            let value: serde_json::Value = serde_json::from_slice(blob.content()).ok()?;
            u32::try_from(value["schemaVersion"].as_u64()?)
                .ok()
                .filter(|version| *version > 0)
        })()
        .unwrap_or(1)
    }

    pub fn read_tree(&self, sha: &str) -> Result<GenomeBundle, GitStoreError> {
        let repo = self.inner.lock().unwrap();
        let commit = repo.find_commit(oid(sha)?)?;
        let tree = commit.tree()?;
        read_tree(&repo, &tree)
    }

    pub fn log(&self, limit: usize) -> Result<Vec<GenomeCommit>, GitStoreError> {
        let repo = self.inner.lock().unwrap();
        let mut cursor = Some(head(&repo)?);
        let mut commits = Vec::new();
        while let Some(id) = cursor.filter(|_| commits.len() < limit.min(1000)) {
            let commit = repo.find_commit(id)?;
            cursor = commit.parent_ids().next();
            let message = commit.message().unwrap_or_default();
            let (body, domain) = message
                .rsplit_once("\n\nHarnex-Domain: ")
                .map_or((message, None), |(body, domain)| {
                    (body, Some(domain.to_owned()))
                });
            let parent = cursor
                .map(|id| repo.find_commit(id).and_then(|c| c.tree()))
                .transpose()?;
            let diff = repo.diff_tree_to_tree(parent.as_ref(), Some(&commit.tree()?), None)?;
            let changed_components = diff
                .deltas()
                .filter_map(|delta| {
                    delta
                        .new_file()
                        .path()
                        .or_else(|| delta.old_file().path())
                        .map(Path::to_path_buf)
                })
                .map(|path| component(&path.to_string_lossy()).to_owned())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            commits.push(GenomeCommit {
                sha: id.to_string(),
                parent_sha: cursor.map(|id| id.to_string()),
                version_tag: format!("{}", &id.to_string()[..8]),
                message: body.into(),
                timestamp: Utc
                    .timestamp_opt(commit.time().seconds(), 0)
                    .single()
                    .unwrap_or_default()
                    .to_rfc3339(),
                domain,
                pass_rate: None,
                changed_components,
                is_rollback: body.starts_with("Rollback to "),
            });
        }
        Ok(commits)
    }

    /// `human_approved` belongs to the trusted UI, never to an RPC intent from the sidecar.
    pub fn commit_patch(
        &self,
        patch: &GitCommitPatchParams,
        human_approved: bool,
    ) -> Result<GitCommitPatchResult, GitStoreError> {
        let repo = self.inner.lock().unwrap();
        apply_patch(&repo, patch, human_approved)
    }

    pub fn revert(&self, sha: &str, reason: &str) -> Result<GitCommitPatchResult, GitStoreError> {
        revert(&self.inner.lock().unwrap(), oid(sha)?, reason)
    }

    pub fn record_health(
        &self,
        domain: &str,
        sha: &str,
        success: bool,
    ) -> Result<Option<GitCommitPatchResult>, GitStoreError> {
        let repo = self.inner.lock().unwrap();
        let commit = repo.find_commit(oid(sha)?)?;
        let sha = commit.id().to_string();
        let mut locked = self.health.lock().unwrap();
        let mut next = locked.clone();
        let samples = next.entry(domain.into()).or_default();
        samples.push_back(Sample {
            sha: sha.clone(),
            success,
        });
        while samples.len() > WINDOW {
            samples.pop_front();
        }

        let active_samples: Vec<_> = samples.iter().filter(|sample| sample.sha == sha).collect();
        let mut rollback = None;
        if commit.id() == head(&repo)? && active_samples.len() >= 3 {
            let failures = active_samples
                .iter()
                .filter(|sample| !sample.success)
                .count();
            let consecutive = active_samples
                .iter()
                .rev()
                .take(3)
                .all(|sample| !sample.success);
            let failure_rate = failures as f64 / active_samples.len() as f64;
            let mut cursor = commit.parent_ids().next();
            let mut previous = None;
            while let Some(parent) = cursor {
                let parent_sha = parent.to_string();
                let baseline: Vec<_> = samples
                    .iter()
                    .filter(|sample| sample.sha == parent_sha)
                    .collect();
                if !baseline.is_empty() {
                    let baseline_rate = baseline.iter().filter(|sample| !sample.success).count()
                        as f64
                        / baseline.len() as f64;
                    if baseline_rate < failure_rate {
                        previous.get_or_insert((parent, baseline_rate));
                    }
                    if failure_rate > baseline_rate * 1.2 {
                        rollback = Some(parent);
                        break;
                    }
                }
                cursor = repo.find_commit(parent)?.parent_ids().next();
            }
            if rollback.is_none() && consecutive {
                rollback = previous
                    .map(|(id, _)| id)
                    .or_else(|| commit.parent_ids().next());
            }
        }
        persist_json(&self.health_path, &next)?;
        *locked = next;
        rollback
            .map(|target| revert(&repo, target, &format!("Health regression in {domain}")))
            .transpose()
    }

    pub fn scan_export(
        &self,
        sha: &str,
        include_memory: bool,
    ) -> Result<ExportScanResult, GitStoreError> {
        Ok(scan(&self.read_tree(sha)?, include_memory))
    }

    pub fn export_bundle(
        &self,
        sha: &str,
        include_memory: bool,
        strip_findings: bool,
    ) -> Result<GenomeBundle, GitStoreError> {
        let mut files = self.read_tree(sha)?;
        let report = scan(&files, include_memory);
        if !report.safe_to_export && !strip_findings {
            return Err(GitStoreError::Invalid(
                "export contains potential secrets or personal data".into(),
            ));
        }
        files.retain(|name, _| {
            report.included_files.contains(name)
                && !report.findings.iter().any(|finding| &finding.file == name)
        });
        Ok(files)
    }

    /// The bundle is data only. Executable entries are disabled before the new snapshot is published.
    pub fn import_bundle(
        &self,
        bundle: GenomeBundle,
        trust: &TrustStore,
        human_approved: bool,
    ) -> Result<GitCommitPatchResult, GitStoreError> {
        let repo = self.inner.lock().unwrap();
        validate_files(&bundle)?;
        if !human_approved {
            return Err(GitStoreError::HumanApproval("genome import".into()));
        }
        let registrations = bundle.iter().filter_map(|(name, contents)| {
            executable_kind(name).map(|kind| (kind, name.as_str(), contents.as_bytes()))
        });
        trust.mark_imported(registrations)?;
        apply_patch(
            &repo,
            &GitCommitPatchParams {
                base_commit_sha: head(&repo)?.to_string(),
                message: "Import genome bundle".into(),
                domain: "import".into(),
                author_name: "Harnex".into(),
                operations: bundle
                    .into_iter()
                    .map(|(path, content)| HarnessPatchOp {
                        path,
                        op: "upsert".into(),
                        content: Some(content),
                    })
                    .collect(),
            },
            true,
        )
    }
}

pub fn executable_kind(path: &str) -> Option<TrustKind> {
    let path = path.to_ascii_lowercase();
    if path.starts_with("scripts/") {
        Some(TrustKind::Script)
    } else if path.starts_with("hooks/") {
        Some(TrustKind::Hook)
    } else if path == "mcp/servers.json" {
        Some(TrustKind::Mcp)
    } else {
        None
    }
}

pub fn component(path: &str) -> &'static str {
    match path.split(['/', '\\']).next().unwrap_or("meta") {
        "memory" => "memory",
        "skills" => "skills",
        "mcp" => "mcp",
        "hooks" => "hooks",
        "sub_agents" => "sub_agents",
        "sandbox_policies" => "sandbox_policies",
        "scripts" => "scripts",
        "views" => "views",
        "tool_descriptions" => "tool_descriptions",
        "systemprompt.md" => "systemprompt",
        "guardrails.md" => "guardrails",
        _ => "meta",
    }
}

fn oid(sha: &str) -> Result<Oid, GitStoreError> {
    if sha.len() != 40 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(GitStoreError::Invalid(
            "full Git commit SHA required".into(),
        ));
    }
    Ok(Oid::from_str(sha)?)
}

fn head(repo: &Repository) -> Result<Oid, git2::Error> {
    repo.refname_to_id(HEAD)
}

fn validate_name(path: &str) -> Result<(), GitStoreError> {
    validate_relative(path)?;
    if path.contains('\\') {
        return Err(GitStoreError::Invalid("genome paths must use '/'".into()));
    }
    Ok(())
}

pub(crate) fn validate_files(files: &GenomeBundle) -> Result<(), GitStoreError> {
    if files.len() > 10_000
        || files
            .values()
            .try_fold(0usize, |sum, text| sum.checked_add(text.len()))
            .unwrap_or(usize::MAX)
            > MAX_BUNDLE
    {
        return Err(GitStoreError::Invalid(
            "genome bundle exceeds its size limit".into(),
        ));
    }
    let mut casing = BTreeMap::new();
    for path in files.keys() {
        validate_name(path)?;
        for parent in Path::new(path)
            .ancestors()
            .filter(|p| !p.as_os_str().is_empty())
        {
            let name = parent.to_str().unwrap();
            let lower = name.to_lowercase();
            if casing.insert(lower, name).is_some_and(|old| old != name)
                || (parent != Path::new(path) && files.contains_key(name))
            {
                return Err(GitStoreError::Invalid(format!(
                    "ambiguous genome path: {path}"
                )));
            }
        }
    }
    Ok(())
}

fn load_seed(root: &Path) -> Result<GenomeBundle, GitStoreError> {
    fn visit(
        root: &Path,
        prefix: &str,
        files: &mut GenomeBundle,
        remaining: &mut usize,
    ) -> Result<(), GitStoreError> {
        for entry in fs::read_dir(root)? {
            let entry = entry?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| GitStoreError::Invalid("non-UTF-8 seed path".into()))?;
            let name = format!("{prefix}{name}");
            validate_name(&name)?;
            let kind = entry.file_type()?;
            if kind.is_dir() {
                visit(&entry.path(), &format!("{name}/"), files, remaining)?;
            } else if kind.is_file() {
                let mut text = String::new();
                fs::File::open(entry.path())?
                    .take(*remaining as u64 + 1)
                    .read_to_string(&mut text)?;
                if text.len() > *remaining || files.len() >= 10_000 {
                    return Err(GitStoreError::Invalid(
                        "factory seed exceeds its size limit".into(),
                    ));
                }
                *remaining -= text.len();
                files.insert(name, text);
            } else {
                return Err(GitStoreError::Invalid(
                    "factory seed must contain regular files and directories".into(),
                ));
            }
        }
        Ok(())
    }
    let mut files = GenomeBundle::new();
    let mut remaining = MAX_BUNDLE;
    visit(root, "", &mut files, &mut remaining)?;
    Ok(files)
}

fn read_tree(repo: &Repository, tree: &Tree<'_>) -> Result<GenomeBundle, GitStoreError> {
    fn collect(
        repo: &Repository,
        tree: &Tree<'_>,
        prefix: &str,
        out: &mut GenomeBundle,
    ) -> Result<(), GitStoreError> {
        for entry in tree.iter() {
            let name = entry
                .name()
                .ok_or_else(|| GitStoreError::Invalid("non-UTF-8 genome path".into()))?;
            let name = format!("{prefix}{name}");
            validate_name(&name)?;
            match entry.filemode() {
                0o040000 => collect(repo, &repo.find_tree(entry.id())?, &format!("{name}/"), out)?,
                0o100644 | 0o100755 => {
                    let blob = repo.find_blob(entry.id())?;
                    let data = std::str::from_utf8(blob.content())
                        .map_err(|_| GitStoreError::Invalid("binary genome entry".into()))?;
                    out.insert(name, data.into());
                }
                _ => {
                    return Err(GitStoreError::Invalid(
                        "unsupported genome entry type".into(),
                    ))
                }
            }
        }
        Ok(())
    }
    let mut files = BTreeMap::new();
    collect(repo, tree, "", &mut files)?;
    validate_files(&files)?;
    Ok(files)
}

fn write_tree(repo: &Repository, files: &GenomeBundle) -> Result<Oid, GitStoreError> {
    let mut index = git2::Index::new()?;
    for (name, contents) in files {
        let zero = git2::IndexTime::new(0, 0);
        index.add(&git2::IndexEntry {
            ctime: zero,
            mtime: zero,
            dev: 0,
            ino: 0,
            mode: 0o100644,
            uid: 0,
            gid: 0,
            file_size: contents.len() as u32,
            id: repo.blob(contents.as_bytes())?,
            flags: 0,
            flags_extended: 0,
            path: name.as_bytes().to_vec(),
        })?;
    }
    Ok(index.write_tree_to(repo)?)
}

fn apply_patch(
    repo: &Repository,
    patch: &GitCommitPatchParams,
    human_approved: bool,
) -> Result<GitCommitPatchResult, GitStoreError> {
    let current = repo.find_commit(head(repo)?)?;
    let base = repo.find_commit(oid(&patch.base_commit_sha)?)?;
    if base.id() != current.id() && !repo.graph_descendant_of(current.id(), base.id())? {
        return Err(GitStoreError::Invalid(
            "patch base is not an ancestor of HEAD".into(),
        ));
    }
    let base_tree = base.tree()?;
    let mut files = read_tree(repo, &base_tree)?;
    for op in &patch.operations {
        validate_name(&op.path)?;
        if is_high_privilege_harness_path(&op.path.to_lowercase()) && !human_approved {
            return Err(GitStoreError::HumanApproval(op.path.clone()));
        }
        match (op.op.as_str(), &op.content) {
            ("upsert", Some(content)) => {
                files.insert(op.path.clone(), content.clone());
            }
            ("delete", None) => {
                files.remove(&op.path);
            }
            _ => {
                return Err(GitStoreError::Invalid(
                    "invalid genome patch operation".into(),
                ))
            }
        }
    }
    validate_files(&files)?;
    let proposed = repo.find_tree(write_tree(repo, &files)?)?;
    let sig = Signature::now(&patch.author_name, "l0@harnex.local")?;
    let domain: String = patch.domain.chars().filter(|c| !c.is_control()).collect();
    let message = format!("{}\n\nHarnex-Domain: {}", patch.message, domain);
    let id = if base.id() == current.id() {
        repo.commit(None, &sig, &sig, &message, &proposed, &[&current])?
    } else {
        let mut merge = repo.merge_trees(&base_tree, &current.tree()?, &proposed, None)?;
        if merge.has_conflicts() {
            let mut names = BTreeSet::new();
            for conflict in merge.conflicts()? {
                let conflict = conflict?;
                for entry in [conflict.ancestor, conflict.our, conflict.their]
                    .into_iter()
                    .flatten()
                {
                    names.insert(String::from_utf8_lossy(&entry.path).into_owned());
                }
            }
            return Ok(GitCommitPatchResult {
                ok: false,
                new_commit_sha: None,
                conflict: true,
                conflicting_files: names.into_iter().collect(),
                error: None,
            });
        }
        let tree = repo.find_tree(merge.write_tree_to(repo)?)?;
        read_tree(repo, &tree)?;
        let proposal =
            repo.find_commit(repo.commit(None, &sig, &sig, &message, &proposed, &[&base])?)?;
        repo.commit(None, &sig, &sig, &message, &tree, &[&current, &proposal])?
    };
    publish(repo, current.id(), id, &message)
}

fn publish(
    repo: &Repository,
    current: Oid,
    id: Oid,
    message: &str,
) -> Result<GitCommitPatchResult, GitStoreError> {
    repo.reference_matching(HEAD, id, true, current, message)?;
    Ok(GitCommitPatchResult {
        ok: true,
        new_commit_sha: Some(id.to_string()),
        conflict: false,
        conflicting_files: Vec::new(),
        error: None,
    })
}

fn revert(
    repo: &Repository,
    target: Oid,
    reason: &str,
) -> Result<GitCommitPatchResult, GitStoreError> {
    let current = repo.find_commit(head(repo)?)?;
    if target != current.id() && !repo.graph_descendant_of(current.id(), target)? {
        return Err(GitStoreError::Invalid(
            "rollback target is not an ancestor of HEAD".into(),
        ));
    }
    let tree = repo.find_commit(target)?.tree()?;
    read_tree(repo, &tree)?;
    let message = format!("Rollback to {target}: {reason}");
    let sig = Signature::now("Harnex", "l0@harnex.local")?;
    publish(
        repo,
        current.id(),
        repo.commit(None, &sig, &sig, &message, &tree, &[&current])?,
        &message,
    )
}

static PATTERNS: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    [
        ("api_key", r"\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{35}|AKIA[A-Z0-9]{16}|(?:ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{16,})\b"),
        ("private_key", r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----"),
        ("jwt", r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b"),
        ("email", r"(?i)\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+\b"),
        ("personal_number", r"(?:\b\d{3}-\d{2}-\d{4}\b|\b\d{3}[- .]\d{3}[- .]\d{4}\b)"),
        ("credential_assignment", r#"(?i)\b(?:api[-_ ]?key|secret|password|access[-_ ]?token)\s*[:=]\s*['\"]?[A-Z0-9_./+=-]{8,}"#),
    ].into_iter().map(|(name, expr)| (name, Regex::new(expr).unwrap())).collect()
});

static TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[A-Za-z0-9_+/=-]{24,}").unwrap());

fn entropy(token: &str) -> f64 {
    let mut frequencies = [0usize; 128];
    for byte in token.bytes() {
        frequencies[byte as usize] += 1;
    }
    frequencies
        .into_iter()
        .filter(|count| *count > 0)
        .map(|count| {
            let p = count as f64 / token.len() as f64;
            -p * p.log2()
        })
        .sum()
}

fn scan(files: &GenomeBundle, include_memory: bool) -> ExportScanResult {
    let mut report = ExportScanResult {
        included_files: Vec::new(),
        excluded_files: Vec::new(),
        findings: Vec::new(),
        safe_to_export: true,
    };
    for (name, content) in files {
        let lower = name.to_lowercase();
        if (!include_memory && lower.starts_with("memory/"))
            || lower.split('/').any(|part| {
                part == ".env"
                    || part.starts_with(".env.")
                    || matches!(
                        part,
                        "config.local.json" | "providers.json" | "credentials.json"
                    )
            })
        {
            report.excluded_files.push(name.clone());
            continue;
        }
        report.included_files.push(name.clone());
        for (i, text) in std::iter::once(name.as_str())
            .chain(content.lines())
            .enumerate()
        {
            let rule = PATTERNS
                .iter()
                .find_map(|(rule, regex)| regex.is_match(text).then_some(*rule))
                .or_else(|| {
                    TOKEN
                        .find_iter(text)
                        .any(|m| entropy(m.as_str()) >= 4.25)
                        .then_some("high_entropy_token")
                });
            if let Some(rule) = rule {
                report.findings.push(SecretScanFinding {
                    file: name.clone(),
                    line: i,
                    rule: rule.into(),
                    masked_snippet: "[REDACTED]".into(),
                });
            }
        }
    }
    report.safe_to_export = report.findings.is_empty();
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    fn patch(sha: &str, path: &str, contents: &str) -> GitCommitPatchParams {
        GitCommitPatchParams {
            base_commit_sha: sha.into(),
            message: format!("Update {path}"),
            domain: "domain".into(),
            author_name: "test".into(),
            operations: vec![HarnessPatchOp {
                path: path.into(),
                op: "upsert".into(),
                content: Some(contents.into()),
            }],
        }
    }

    #[test]
    fn commits_merge_from_pinned_snapshots_and_conflicts_preserve_head() {
        let dir = tempfile::tempdir().unwrap();
        let store = GitStore::open(dir.path()).unwrap();
        let empty = store.head_sha().unwrap();
        assert!(store.read_tree(&empty).unwrap().is_empty());
        let base = store
            .commit_patch(&patch(&empty, "EXPERIENCE.md", "original"), false)
            .unwrap()
            .new_commit_sha
            .unwrap();
        let changed = store
            .commit_patch(&patch(&base, "EXPERIENCE.md", "ours"), false)
            .unwrap()
            .new_commit_sha
            .unwrap();
        let merged = store
            .commit_patch(&patch(&base, "other.md", "theirs"), false)
            .unwrap()
            .new_commit_sha
            .unwrap();
        assert_eq!(store.read_tree(&merged).unwrap().len(), 2);
        let conflict = store
            .commit_patch(&patch(&base, "EXPERIENCE.md", "conflict"), false)
            .unwrap();
        assert!(conflict.conflict);
        assert_eq!(conflict.conflicting_files, ["EXPERIENCE.md"]);
        assert_eq!(store.head_sha().unwrap(), merged);
        assert_eq!(store.read_tree(&base).unwrap()["EXPERIENCE.md"], "original");
        assert_eq!(store.read_tree(&changed).unwrap()["EXPERIENCE.md"], "ours");
        assert!(store
            .commit_patch(&patch(&merged, "nested/.git/config", "no"), true)
            .is_err());
        assert!(matches!(
            store.commit_patch(&patch(&merged, "hooks/file.ts", "no"), false),
            Err(GitStoreError::HumanApproval(_))
        ));
    }

    #[test]
    fn regression_reverts_active_version_only_and_preserves_snapshots() {
        let dir = tempfile::tempdir().unwrap();
        let store = GitStore::open(dir.path()).unwrap();
        let healthy = store.head_sha().unwrap();
        for _ in 0..3 {
            assert!(store
                .record_health("domain", &healthy, true)
                .unwrap()
                .is_none());
        }
        let bad = store
            .commit_patch(&patch(&healthy, "EXPERIENCE.md", "regression"), false)
            .unwrap()
            .new_commit_sha
            .unwrap();
        assert!(store.record_health("domain", &bad, true).unwrap().is_none());
        assert!(store
            .record_health("domain", &bad, false)
            .unwrap()
            .is_none());
        let rollback = store
            .record_health("domain", &bad, true)
            .unwrap()
            .unwrap()
            .new_commit_sha
            .unwrap();
        assert!(store.read_tree(&rollback).unwrap().is_empty());
        assert!(store.read_tree(&bad).unwrap().contains_key("EXPERIENCE.md"));
        assert!(store.log(1).unwrap()[0].is_rollback);
        assert!(store
            .record_health("domain", &bad, false)
            .unwrap()
            .is_none());
    }

    #[test]
    fn three_consecutive_failures_revert_without_a_measured_baseline() {
        let dir = tempfile::tempdir().unwrap();
        let store = GitStore::open(dir.path()).unwrap();
        let original = store.head_sha().unwrap();
        let active = store
            .commit_patch(&patch(&original, "EXPERIENCE.md", "new version"), false)
            .unwrap()
            .new_commit_sha
            .unwrap();
        assert!(store
            .record_health("unmeasured", &active, false)
            .unwrap()
            .is_none());
        assert!(store
            .record_health("unmeasured", &active, false)
            .unwrap()
            .is_none());
        let rollback = store
            .record_health("unmeasured", &active, false)
            .unwrap()
            .unwrap();
        assert_eq!(
            store.read_tree(&rollback.new_commit_sha.unwrap()).unwrap(),
            store.read_tree(&original).unwrap()
        );
    }

    #[test]
    fn exports_block_secrets_and_imports_disable_executable_assets() {
        let dir = tempfile::tempdir().unwrap();
        let store = GitStore::open(dir.path().join("harness")).unwrap();
        let trust = TrustStore::open(dir.path().join("trust.json")).unwrap();
        let files = GenomeBundle::from([
            ("hooks/a.ts".into(), "hook".into()), ("scripts/a.ts".into(), "script".into()), ("mcp/servers.json".into(), "{}".into()),
            ("memory/private.md".into(), "my private text".into()), ("EXPERIENCE.md".into(), "sk-FakeTestValue123456789\nname@example.net\n-----BEGIN PRIVATE KEY-----\nqS74jZ6v2C_8Wm9HDkA5XuE3".into()),
        ]);
        let sha = store
            .import_bundle(files, &trust, true)
            .unwrap()
            .new_commit_sha
            .unwrap();
        assert!(trust
            .list()
            .iter()
            .all(|r| r.status == TrustStatus::Disabled && r.origin == TrustOrigin::ImportedGenome));
        assert_eq!(trust.list().len(), 3);
        let report = store.scan_export(&sha, false).unwrap();
        assert_eq!(report.excluded_files, ["memory/private.md"]);
        assert!(!report.safe_to_export);
        assert_eq!(report.findings.len(), 4);
        assert!(report
            .findings
            .iter()
            .all(|f| f.masked_snippet == "[REDACTED]"));
        assert!(store.export_bundle(&sha, false, false).is_err());
        assert_eq!(store.export_bundle(&sha, false, true).unwrap().len(), 3);
    }
}
