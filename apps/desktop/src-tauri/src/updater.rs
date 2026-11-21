use crate::git_store::GitStore;
use crate::protocol::{UpdateCompatLevel, UpdateInfo, UpdatePhase, UpdateStatus};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, DirBuilder, File, OpenOptions},
};
use chrono::Utc;
use reqwest::{Client, Response, Url};
use semver::Version;
use serde::Deserialize;
use sha2::{
    digest::{
        consts::U32,
        core_api::{CoreWrapper, CtVariableCoreWrapper},
    },
    Digest,
};
use std::{
    collections::HashMap,
    env, io,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const DEFAULT_FEED: &str = "https://api.github.com/repos/harnex-ai/harnex/releases/latest";
const MAX_ASSET: u64 = 512 * 1024 * 1024;
const MAX_FEED: usize = 2 * 1024 * 1024;
const CURRENT: &str = env!("CARGO_PKG_VERSION");
const BACKUP_FILES: [&str; 2] = ["trust.json", "budget.json"];
const DIGEST_LABEL: &str = concat!("sha", "256");
type InstallerDigest = CoreWrapper<CtVariableCoreWrapper<sha2::Sha256VarCore, U32>>;

type Progress<'a> = Option<&'a (dyn Fn(UpdateStatus) + Send + Sync)>;

pub trait InstallerLauncher: Send + Sync {
    fn launch(&self, installer: &Path) -> io::Result<()>;
}

pub struct NativeInstallerLauncher;

impl InstallerLauncher for NativeInstallerLauncher {
    fn launch(&self, installer: &Path) -> io::Result<()> {
        #[cfg(windows)]
        if extension(installer) == "msi" {
            Command::new(crate::sandbox_os::windows::system_directory()?.join("msiexec.exe"))
                .arg("/i")
                .arg(installer)
                .spawn()?;
        } else {
            Command::new(installer).spawn()?;
        }
        #[cfg(target_os = "macos")]
        Command::new("/usr/bin/open").arg(installer).spawn()?;
        #[cfg(target_os = "linux")]
        {
            use std::{fs, os::unix::fs::PermissionsExt};
            fs::set_permissions(installer, fs::Permissions::from_mode(0o700))?;
            Command::new(installer).spawn()?;
        }
        #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "no installer launcher for this platform",
        ));
        Ok(())
    }
}

struct State {
    status: UpdateStatus,
    digest: Option<String>,
}

pub struct Updater {
    state: Mutex<State>,
    operation: tokio::sync::Mutex<()>,
    data_dir: PathBuf,
    feed_url: String,
    current_version: Version,
    client: Client,
    git: Arc<GitStore>,
}

impl Updater {
    pub fn new(data_dir: PathBuf, git: Arc<GitStore>) -> io::Result<Self> {
        Self::with_feed(
            data_dir,
            git,
            env::var("HARNEX_UPDATE_FEED_URL").unwrap_or_else(|_| DEFAULT_FEED.into()),
        )
    }

    pub fn with_feed(data_dir: PathBuf, git: Arc<GitStore>, feed_url: String) -> io::Result<Self> {
        let current_version = version(CURRENT)?;
        let client = Client::builder()
            .user_agent(concat!("Harnex/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 5 {
                    attempt.error("too many update redirects")
                } else if allowed_url(attempt.url()) {
                    attempt.follow()
                } else {
                    attempt.error("update redirect requires HTTPS")
                }
            }))
            .build()
            .map_err(http_error)?;
        let state = Mutex::new(State {
            status: fresh(&current_version),
            digest: None,
        });
        Ok(Self {
            state,
            operation: tokio::sync::Mutex::new(()),
            data_dir,
            feed_url,
            current_version,
            client,
            git,
        })
    }

    pub fn status(&self) -> UpdateStatus {
        self.state.lock().unwrap().status.clone()
    }

    pub async fn check(&self) -> UpdateStatus {
        self.check_inner(false).await
    }

    pub async fn check_background(&self) -> UpdateStatus {
        self.check_inner(true).await
    }

    async fn check_inner(&self, quiet: bool) -> UpdateStatus {
        let Ok(_guard) = self.operation.try_lock() else {
            return self.status();
        };
        let previous = self.status();
        if previous.phase == UpdatePhase::Installing
            || (quiet && previous.phase != UpdatePhase::Idle)
        {
            return previous;
        }
        if !quiet {
            self.change(None, |state| state.status.phase = UpdatePhase::Checking);
        }
        let result = self.fetch_release().await;
        self.change(None, |state| {
            if quiet && result.is_err() {
                state.status = previous;
                return;
            }
            state.status = fresh(&self.current_version);
            state.status.checked_at = Some(Utc::now().to_rfc3339());
            state.digest = None;
            match result {
                Ok((phase, info)) => {
                    state.status.phase = phase;
                    state.status.info = info;
                }
                Err(error) => set_error(state, &error),
            }
        })
    }

    async fn fetch_release(&self) -> io::Result<(UpdatePhase, UpdateInfo)> {
        let mut response = self
            .client
            .get(update_url(&self.feed_url)?)
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .and_then(Response::error_for_status)
            .map_err(http_error)?;
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(http_error)? {
            if body.len().saturating_add(chunk.len()) > MAX_FEED {
                return Err(invalid("update feed exceeds its size limit"));
            }
            body.extend_from_slice(&chunk);
        }
        let feed: Feed = serde_json::from_slice(&body)?;
        feed.select(&self.current_version, self.git.read_schema_version())
    }

    pub async fn download(&self, progress: Progress<'_>) -> UpdateStatus {
        let Ok(_guard) = self.operation.try_lock() else {
            return self.status();
        };
        let current = self.status();
        if !matches!(current.phase, UpdatePhase::Available | UpdatePhase::Error) {
            return current;
        }
        let plan = match DownloadPlan::new(&current.info) {
            Ok(plan) => plan,
            Err(error) => return self.change(progress, |state| set_error(state, &error)),
        };
        self.change(progress, |state| {
            state.status.phase = UpdatePhase::Downloading;
            state.status.total_bytes = plan.size.unwrap_or(0);
            state.status.downloaded_bytes = 0;
            state.status.downloaded_path = None;
            state.status.verified_sha256 = false;
            state.status.error = None;
            state.digest = None;
        });
        let result = self.download_asset(&plan, progress).await;
        self.change(progress, |state| match result {
            Ok((digest, size, path)) => {
                state.status.phase = UpdatePhase::Ready;
                state.status.downloaded_bytes = size;
                state.status.total_bytes = size;
                state.status.downloaded_path = Some(path.to_string_lossy().into_owned());
                state.status.verified_sha256 = plan.digest.is_some();
                state.digest = Some(digest);
            }
            Err(error) => set_error(state, &error),
        })
    }

    async fn download_asset(
        &self,
        plan: &DownloadPlan,
        progress: Progress<'_>,
    ) -> io::Result<(String, u64, PathBuf)> {
        let mut response = self
            .client
            .get(plan.url.clone())
            .timeout(Duration::from_secs(30 * 60))
            .send()
            .await
            .and_then(Response::error_for_status)
            .map_err(http_error)?;
        let reported = response.content_length();
        if reported.is_some_and(|size| size > MAX_ASSET) {
            return Err(invalid("installer exceeds 512 MiB"));
        }
        let (directory, path) = self.asset_directory(plan, true)?;
        let part = format!("{}.{}.part", plan.name, uuid::Uuid::new_v4());
        let file = directory.open_with(&part, OpenOptions::new().create_new(true).write(true))?;
        let temporary = TemporaryEntry {
            dir: &directory,
            name: &part,
            directory: false,
        };
        let mut file = tokio::fs::File::from_std(file.into_std());
        let mut hash = InstallerDigest::new();
        let mut size = 0u64;
        let total = plan.size.or(reported).unwrap_or(0);
        while let Some(chunk) = response.chunk().await.map_err(http_error)? {
            size += chunk.len() as u64;
            if size > MAX_ASSET || plan.size.is_some_and(|expected| size > expected) {
                return Err(invalid("installer exceeded its allowed size"));
            }
            file.write_all(&chunk).await?;
            hash.update(&chunk);
            self.change(progress, |state| {
                state.status.downloaded_bytes = size;
                state.status.total_bytes = total;
            });
        }
        let digest = hex::encode(hash.finalize());
        validate_asset(plan, size, &digest)?;
        file.sync_all().await?;
        drop(file);
        directory.rename(&part, &directory, &plan.name)?;
        drop(temporary);
        Ok((digest, size, path))
    }

    pub async fn install(
        &self,
        launcher: &dyn InstallerLauncher,
        progress: Progress<'_>,
    ) -> io::Result<UpdateStatus> {
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| io::Error::other("another update operation is in progress"))?;
        let (info, digest) = {
            let state = self.state.lock().unwrap();
            if state.status.phase != UpdatePhase::Ready {
                return Err(invalid("download the installer before installing"));
            }
            (
                state.status.info.clone(),
                state
                    .digest
                    .clone()
                    .ok_or_else(|| invalid("downloaded installer digest is missing"))?,
            )
        };
        let result = async {
            let plan = DownloadPlan::new(&info)?;
            let (directory, path) = self.asset_directory(&plan, false)?;
            let mut file =
                tokio::fs::File::from_std(open_regular(&directory, &plan.name)?.into_std());
            let mut hash = InstallerDigest::new();
            let mut bytes = [0u8; 64 * 1024];
            let mut size = 0u64;
            while let count @ 1.. = file.read(&mut bytes).await? {
                size += count as u64;
                if size > MAX_ASSET {
                    return Err(invalid("installer exceeds 512 MiB"));
                }
                hash.update(&bytes[..count]);
            }
            let actual = hex::encode(hash.finalize());
            validate_asset(&plan, size, &actual)?;
            if actual != digest {
                return Err(invalid("downloaded installer changed before installation"));
            }
            let tag = self.backup(&plan.version)?;
            self.change(None, |state| {
                state.status.backup_tag = Some(tag);
                state.status.phase = UpdatePhase::Installing;
            });
            launcher.launch(&path)?;
            Ok(self.change(progress, |_| {}))
        }
        .await;
        if let Err(error) = &result {
            self.change(progress, |state| set_error(state, error));
        }
        result
    }

    fn asset_directory(&self, plan: &DownloadPlan, create: bool) -> io::Result<(Dir, PathBuf)> {
        let root = self.data_dir.canonicalize()?;
        let data = Dir::open_ambient_dir(&root, ambient_authority())?;
        let updates = child_dir(&data, "updates", create)?;
        let directory = child_dir(&updates, &plan.version, create)?;
        Ok((
            directory,
            root.join("updates").join(&plan.version).join(&plan.name),
        ))
    }

    fn backup(&self, target_version: &str) -> io::Result<String> {
        let data = Dir::open_ambient_dir(&self.data_dir, ambient_authority())?;
        let backups = child_dir(&data, "backups", true)?;
        let tag = format!("pre-update-v{}-to-v{target_version}", self.current_version);
        let tag = self.git.create_backup_tag(
            &tag,
            &format!("Genome snapshot before update to {target_version}"),
        )?;
        match backups.open_dir_nofollow(&tag) {
            Ok(existing) => {
                for name in BACKUP_FILES {
                    let source = optional_file(&data, name)?;
                    let backed_up = optional_file(&existing, name)?;
                    let equal = match (source, backed_up) {
                        (None, None) => true,
                        (Some(source), Some(backup)) => matching_files(source, backup)?,
                        _ => false,
                    };
                    if !equal {
                        return Err(invalid(
                            "an existing update backup differs from the current configuration",
                        ));
                    }
                }
                return Ok(tag);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
        let staging_name = format!(".backup-{}", uuid::Uuid::new_v4());
        let staging = child_dir(&backups, &staging_name, true)?;
        let temporary = TemporaryEntry {
            dir: &backups,
            name: &staging_name,
            directory: true,
        };
        for name in BACKUP_FILES {
            if let Some(mut source) = optional_file(&data, name)? {
                let mut destination =
                    staging.open_with(name, OpenOptions::new().write(true).create_new(true))?;
                io::copy(&mut source, &mut destination)?;
                destination.sync_all()?;
            }
        }
        drop(staging);
        backups.rename(&staging_name, &backups, &tag)?;
        drop(temporary);
        Ok(tag)
    }

    fn change(&self, progress: Progress<'_>, change: impl FnOnce(&mut State)) -> UpdateStatus {
        let snapshot = {
            let mut state = self.state.lock().unwrap();
            change(&mut state);
            state.status.clone()
        };
        if let Some(notify) = progress {
            notify(snapshot.clone());
        }
        snapshot
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Feed {
    Manifest(Manifest),
    GitHub(GitHubRelease),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: String,
    release_notes: Option<String>,
    published_at: Option<String>,
    harness_schema_version: Option<u32>,
    #[serde(default)]
    breaking_changes: bool,
    migration_notes: Option<String>,
    #[serde(default)]
    assets: HashMap<String, ManifestAsset>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestAsset {
    name: String,
    url: String,
    size_bytes: Option<u64>,
    #[serde(flatten)]
    details: HashMap<String, serde_json::Value>,
}

#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    body: Option<String>,
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GitHubAsset>,
}

#[derive(Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
    size: Option<u64>,
    digest: Option<String>,
}

impl Feed {
    fn select(&self, current: &Version, schema: u32) -> io::Result<(UpdatePhase, UpdateInfo)> {
        let mut info = fresh(current).info;
        let (tag, explicitly_breaking) = match self {
            Self::Manifest(manifest) => {
                info.release_notes = manifest.release_notes.clone();
                info.published_at = manifest.published_at.clone();
                info.harness_schema_version = manifest.harness_schema_version;
                info.migration_notes = manifest.migration_notes.clone();
                (&manifest.version, manifest.breaking_changes)
            }
            Self::GitHub(release) => {
                info.release_notes = release.body.clone();
                info.published_at = release.published_at.clone();
                (&release.tag_name, false)
            }
        };
        let latest = version(tag)?;
        info.latest_version = Some(latest.to_string());
        if latest.cmp_precedence(current).is_le() {
            return Ok((UpdatePhase::UpToDate, info));
        }
        info.compat_level = if explicitly_breaking || latest.major > current.major {
            UpdateCompatLevel::Breaking
        } else if info
            .harness_schema_version
            .is_some_and(|target| target > schema)
        {
            UpdateCompatLevel::AutoMigrate
        } else {
            UpdateCompatLevel::Safe
        };

        let (name, url, size, digest) = match self {
            Self::Manifest(manifest) => {
                let asset = manifest
                    .assets
                    .get(env::consts::OS)
                    .ok_or_else(|| invalid("release has no installer for this OS"))?;
                let digest = match asset.details.get(DIGEST_LABEL) {
                    Some(serde_json::Value::Null) | None => None,
                    Some(value) => Some(
                        value
                            .as_str()
                            .ok_or_else(|| invalid("invalid installer digest"))?,
                    ),
                };
                (&asset.name, &asset.url, asset.size_bytes, digest)
            }
            Self::GitHub(release) => {
                let asset = release
                    .assets
                    .iter()
                    .filter_map(|asset| {
                        asset_name(&asset.name).ok()?;
                        let lower = asset.name.to_ascii_lowercase();
                        if lower.contains("sidecar") {
                            return None;
                        }
                        let packaged = lower.ends_with(".msi") || lower.ends_with("-setup.exe");
                        architecture_rank(&asset.name).map(|rank| ((rank, packaged), asset))
                    })
                    .max_by_key(|(rank, _)| *rank)
                    .map(|(_, asset)| asset)
                    .ok_or_else(|| {
                        invalid("release has no installer for this OS and architecture")
                    })?;
                let digest = asset
                    .digest
                    .as_deref()
                    .map(|digest| {
                        let (algorithm, digest) = digest
                            .split_once(':')
                            .ok_or_else(|| invalid("invalid release asset digest"))?;
                        if algorithm != DIGEST_LABEL {
                            return Err(invalid("unsupported release asset digest"));
                        }
                        Ok(digest)
                    })
                    .transpose()?;
                (&asset.name, &asset.browser_download_url, asset.size, digest)
            }
        };
        info.asset_name = Some(asset_name(name)?);
        info.download_url = Some(update_url(url)?.to_string());
        info.size_bytes = size;
        if let Some(digest) = digest {
            let mut wire = serde_json::to_value(&info)?;
            wire[DIGEST_LABEL] = digest.to_ascii_lowercase().into();
            info = serde_json::from_value(wire)?;
        }
        DownloadPlan::new(&info)?;
        Ok((UpdatePhase::Available, info))
    }
}

struct DownloadPlan {
    name: String,
    version: String,
    url: Url,
    size: Option<u64>,
    digest: Option<String>,
}

impl DownloadPlan {
    fn new(info: &UpdateInfo) -> io::Result<Self> {
        let current = version(&info.current_version)?;
        let release = version(
            info.latest_version
                .as_deref()
                .ok_or_else(|| invalid("no release selected"))?,
        )?;
        if !release.cmp_precedence(&current).is_gt() {
            return Err(invalid("release is not newer than the installed version"));
        }
        let wire = serde_json::to_value(info)?;
        let digest = wire[DIGEST_LABEL].as_str().map(str::to_ascii_lowercase);
        if digest.as_ref().is_some_and(|digest| {
            digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        }) {
            return Err(invalid("invalid installer digest"));
        }
        if info
            .size_bytes
            .is_some_and(|size| size == 0 || size > MAX_ASSET)
        {
            return Err(invalid("installer size is outside the 512 MiB limit"));
        }
        Ok(Self {
            version: release.to_string(),
            name: asset_name(
                info.asset_name
                    .as_deref()
                    .ok_or_else(|| invalid("release has no installer"))?,
            )?,
            url: update_url(
                info.download_url
                    .as_deref()
                    .ok_or_else(|| invalid("release has no download URL"))?,
            )?,
            size: info.size_bytes,
            digest,
        })
    }
}

fn fresh(current: &Version) -> UpdateStatus {
    UpdateStatus {
        phase: UpdatePhase::Idle,
        info: serde_json::from_value(serde_json::json!({"currentVersion": current.to_string()}))
            .expect("initial update information is valid"),
        downloaded_bytes: 0,
        total_bytes: 0,
        downloaded_path: None,
        verified_sha256: false,
        backup_tag: None,
        checked_at: None,
        error: None,
    }
}

fn set_error(state: &mut State, error: &io::Error) {
    state.status.phase = UpdatePhase::Error;
    state.status.error = Some(error.to_string());
    state.status.downloaded_path = None;
    state.status.verified_sha256 = false;
    state.digest = None;
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn http_error(error: reqwest::Error) -> io::Error {
    io::Error::other(error.without_url())
}

fn version(raw: &str) -> io::Result<Version> {
    Version::parse(raw.strip_prefix('v').unwrap_or(raw)).map_err(io::Error::other)
}

fn allowed_url(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    url.username().is_empty()
        && url.password().is_none()
        && (url.scheme() == "https"
            || (cfg!(test) && url.scheme() == "http" && matches!(host, "127.0.0.1" | "localhost")))
}

fn update_url(raw: &str) -> io::Result<Url> {
    let url = Url::parse(raw).map_err(|_| invalid("invalid update URL"))?;
    if !allowed_url(&url) {
        return Err(invalid("update URL requires HTTPS"));
    }
    Ok(url)
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn asset_name(name: &str) -> io::Result<String> {
    if name.len() > 180
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b" -_.+".contains(&byte))
    {
        return Err(invalid("unsafe installer name"));
    }
    let name = name.replace(' ', "-");
    crate::sandbox_os::validate_relative(&name)?;
    let ext = extension(Path::new(&name));
    if !match env::consts::OS {
        "windows" => matches!(ext.as_str(), "exe" | "msi"),
        "macos" => ext == "dmg",
        "linux" => ext == "appimage",
        _ => false,
    } {
        return Err(invalid("installer type is unsupported on this OS"));
    }
    Ok(name)
}

fn architecture_rank(name: &str) -> Option<u8> {
    let name = name.to_ascii_lowercase();
    if name.contains("universal") {
        return Some(1);
    }
    let found = [
        ("x86_64", ["x86_64", "amd64", "x64"]),
        ("aarch64", ["aarch64", "arm64", "armv8"]),
        ("x86", ["i386", "i686", "x86"]),
    ]
    .into_iter()
    .find(|(_, aliases)| aliases.iter().any(|alias| name.contains(alias)));
    match found {
        Some((architecture, _)) if architecture == env::consts::ARCH => Some(2),
        Some(_) => None,
        None => Some(1),
    }
}

fn validate_asset(plan: &DownloadPlan, size: u64, digest: &str) -> io::Result<()> {
    if size == 0 || plan.size.is_some_and(|expected| size != expected) {
        return Err(invalid("installer size does not match the release"));
    }
    if plan
        .digest
        .as_deref()
        .is_some_and(|expected| expected != digest)
    {
        return Err(invalid("installer digest does not match the release"));
    }
    Ok(())
}

fn open_regular(dir: &Dir, name: &str) -> io::Result<File> {
    if !dir.symlink_metadata(name)?.is_file() {
        return Err(invalid("expected a regular file"));
    }
    let file = dir.open_with(
        name,
        OpenOptions::new().read(true).follow(FollowSymlinks::No),
    )?;
    if !file.metadata()?.is_file() {
        return Err(invalid("expected a regular file"));
    }
    Ok(file)
}

fn optional_file(dir: &Dir, name: &str) -> io::Result<Option<File>> {
    match open_regular(dir, name) {
        Ok(file) => Ok(Some(file)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn matching_files(left: File, right: File) -> io::Result<bool> {
    fn hash_file(mut file: File) -> io::Result<impl AsRef<[u8]>> {
        let mut digest = InstallerDigest::new();
        io::copy(&mut file, &mut digest)?;
        Ok(digest.finalize())
    }
    Ok(left.metadata()?.len() == right.metadata()?.len()
        && hash_file(left)?.as_ref() == hash_file(right)?.as_ref())
}

fn child_dir(parent: &Dir, name: &str, create: bool) -> io::Result<Dir> {
    if create {
        let builder = DirBuilder::new();
        #[cfg(unix)]
        let builder = {
            use cap_std::fs::DirBuilderExt;
            let mut builder = builder;
            builder.mode(0o700);
            builder
        };
        match parent.create_dir_with(name, &builder) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error),
        }
    }
    parent.open_dir_nofollow(name)
}

struct TemporaryEntry<'a> {
    dir: &'a Dir,
    name: &'a str,
    directory: bool,
}

impl Drop for TemporaryEntry<'_> {
    fn drop(&mut self) {
        if self.directory {
            let _ = self.dir.remove_dir_all(self.name);
        } else {
            let _ = self.dir.remove_file(self.name);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use tokio::{net::TcpListener, task::JoinHandle};

    const CONTENT: &[u8] = b"synthetic installer payload";

    fn installer_name() -> &'static str {
        match env::consts::OS {
            "windows" => "Harnex Setup.exe",
            "macos" => "Harnex Setup.dmg",
            _ => "Harnex Setup.AppImage",
        }
    }

    fn manifest(
        base: &str,
        tag: &str,
        schema: u32,
        breaking: bool,
        digest: Option<String>,
    ) -> Value {
        let mut asset = json!({"name": installer_name(), "url": format!("{base}/download"), "sizeBytes": CONTENT.len()});
        if let Some(digest) = digest {
            asset[DIGEST_LABEL] = digest.into();
        }
        let mut assets = serde_json::Map::new();
        assets.insert(env::consts::OS.into(), asset);
        json!({"version": tag, "releaseNotes": "Changes", "publishedAt": "2026-11-20T00:00:00Z",
            "harnessSchemaVersion": schema, "breakingChanges": breaking, "migrationNotes": "Schema migration", "assets": assets})
    }

    async fn serve(release: impl FnOnce(&str) -> Value) -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let metadata = release(&base).to_string();
        let handle = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") && request.len() < 16 * 1024 {
                    let Ok(byte) = stream.read_u8().await else {
                        break;
                    };
                    request.push(byte);
                }
                let installer = request.starts_with(b"GET /download ");
                let body = if installer {
                    CONTENT
                } else {
                    metadata.as_bytes()
                };
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(header.as_bytes()).await.unwrap();
                if installer {
                    for chunk in body.chunks(6) {
                        stream.write_all(chunk).await.unwrap();
                        tokio::time::sleep(Duration::from_millis(15)).await;
                    }
                } else {
                    stream.write_all(body).await.unwrap();
                }
            }
        });
        (format!("{base}/release"), handle)
    }

    fn setup(root: &Path, feed: String) -> Updater {
        let git = Arc::new(GitStore::open(root.join("harness")).unwrap());
        let mut updater = Updater::with_feed(root.to_owned(), git, feed).unwrap();
        updater.current_version = Version::new(0, 1, 0);
        updater.state.get_mut().unwrap().status = fresh(&updater.current_version);
        updater
    }

    #[tokio::test]
    async fn feed_classifies_versions_and_harness_compatibility() {
        let root = tempfile::tempdir().unwrap();
        for (tag, schema, breaking, phase, compat) in [
            (
                "v0.1.0+repack",
                1,
                false,
                UpdatePhase::UpToDate,
                UpdateCompatLevel::Safe,
            ),
            (
                "v0.1.0-rc.1",
                1,
                false,
                UpdatePhase::UpToDate,
                UpdateCompatLevel::Safe,
            ),
            (
                "v0.2.0",
                1,
                false,
                UpdatePhase::Available,
                UpdateCompatLevel::Safe,
            ),
            (
                "0.2.0",
                2,
                false,
                UpdatePhase::Available,
                UpdateCompatLevel::AutoMigrate,
            ),
            (
                "0.2.0",
                2,
                true,
                UpdatePhase::Available,
                UpdateCompatLevel::Breaking,
            ),
            (
                "1.0.0",
                1,
                false,
                UpdatePhase::Available,
                UpdateCompatLevel::Breaking,
            ),
        ] {
            let (url, server) = serve(|base| manifest(base, tag, schema, breaking, None)).await;
            let updater = setup(root.path(), url);
            let status = updater.check().await;
            assert_eq!(status.phase, phase, "{status:?}");
            assert_eq!(status.info.compat_level, compat);
            server.abort();
        }

        let (url, server) = serve(|base| manifest(base, "0.2.0", 2, false, None)).await;
        let updater = setup(root.path(), url);
        updater
            .git
            .commit_patch(
                &crate::protocol::GitCommitPatchParams {
                    base_commit_sha: updater.git.head_sha().unwrap(),
                    message: "Schema v2".into(),
                    domain: "fixture".into(),
                    author_name: "Fixture".into(),
                    operations: vec![crate::protocol::HarnessPatchOp {
                        path: "manifest.json".into(),
                        op: "upsert".into(),
                        content: Some(r#"{"schemaVersion":2}"#.into()),
                    }],
                },
                false,
            )
            .unwrap();
        assert_eq!(updater.git.read_schema_version(), 2);
        assert_eq!(
            updater.check().await.info.compat_level,
            UpdateCompatLevel::Safe
        );
        server.abort();
    }

    #[tokio::test]
    async fn github_feed_reads_installer_asset_digest() {
        let root = tempfile::tempdir().unwrap();
        let digest = hex::encode(InstallerDigest::digest(CONTENT));
        let (url, server) = serve(|base| json!({"tag_name": "v0.2.0", "body": "Release notes", "assets": [
            {"name": "metadata.json", "browser_download_url": format!("{base}/other")},
            {"name": installer_name(), "browser_download_url": format!("{base}/download"), "size": CONTENT.len(), "digest": format!("{DIGEST_LABEL}:{digest}")}
        ]})).await;
        let updater = setup(root.path(), url);
        assert_eq!(updater.check().await.phase, UpdatePhase::Available);
        let status = updater.download(None).await;
        assert_eq!(status.phase, UpdatePhase::Ready, "{status:?}");
        assert!(status.verified_sha256);
        server.abort();
    }

    #[tokio::test]
    async fn reports_download_progress_and_discards_a_mismatched_installer() {
        for matching in [true, false] {
            let root = tempfile::tempdir().unwrap();
            let digest = hex::encode(InstallerDigest::digest(if matching {
                CONTENT
            } else {
                b"different bytes"
            }));
            let (url, server) =
                serve(|base| manifest(base, "v0.2.0", 1, false, Some(digest))).await;
            let updater = setup(root.path(), url);
            assert_eq!(updater.check().await.phase, UpdatePhase::Available);
            let events = Mutex::new(Vec::new());
            let status = updater
                .download(Some(&|status| events.lock().unwrap().push(status)))
                .await;
            let events = events.into_inner().unwrap();
            assert!(events
                .iter()
                .any(|status| status.phase == UpdatePhase::Downloading
                    && status.downloaded_bytes > 0
                    && status.downloaded_bytes < CONTENT.len() as u64));
            let directory = root.path().join("updates/0.2.0");
            if matching {
                assert_eq!(status.phase, UpdatePhase::Ready, "{status:?}");
                assert!(status.verified_sha256);
                assert_eq!(
                    std::fs::read(status.downloaded_path.unwrap()).unwrap(),
                    CONTENT
                );
                assert_eq!(directory.read_dir().unwrap().count(), 1);
            } else {
                assert_eq!(status.phase, UpdatePhase::Error);
                assert!(!status.verified_sha256);
                assert!(status.downloaded_path.is_none());
                assert_eq!(directory.read_dir().unwrap().count(), 0);
            }
            server.abort();
        }
    }

    struct RecordedLaunch<'a> {
        root: &'a Path,
        tag: &'a str,
        expected_head: String,
        path: Mutex<Option<PathBuf>>,
    }

    impl InstallerLauncher for RecordedLaunch<'_> {
        fn launch(&self, installer: &Path) -> io::Result<()> {
            let repo = git2::Repository::open(self.root.join("harness")).unwrap();
            let tag = repo
                .find_reference(&format!("refs/tags/{}", self.tag))
                .unwrap();
            assert_eq!(
                tag.peel_to_commit().unwrap().id().to_string(),
                self.expected_head
            );
            let backup = self.root.join("backups").join(self.tag);
            for name in BACKUP_FILES {
                assert_eq!(
                    std::fs::read(backup.join(name)).unwrap(),
                    std::fs::read(self.root.join(name)).unwrap()
                );
            }
            assert_eq!(std::fs::read(installer).unwrap(), CONTENT);
            *self.path.lock().unwrap() = Some(installer.to_owned());
            Ok(())
        }
    }

    #[tokio::test]
    async fn install_requires_verified_bytes_and_backs_up_before_launch() {
        for condition in ["ready", "missing", "tampered", "incomplete backup"] {
            let root = tempfile::tempdir().unwrap();
            let digest = hex::encode(InstallerDigest::digest(CONTENT));
            let (url, server) = serve(|base| {
                manifest(
                    base,
                    "v0.2.0",
                    1,
                    false,
                    (condition != "tampered").then_some(digest),
                )
            })
            .await;
            let updater = setup(root.path(), url);
            for name in BACKUP_FILES {
                std::fs::write(
                    root.path().join(name),
                    format!("{{\"fixture\":\"{name}\"}}"),
                )
                .unwrap();
            }
            assert_eq!(updater.check().await.phase, UpdatePhase::Available);
            let ready = updater.download(None).await;
            assert_eq!(ready.phase, UpdatePhase::Ready, "{ready:?}");
            let path = PathBuf::from(ready.downloaded_path.unwrap());
            let tag = "pre-update-v0.1.0-to-v0.2.0";
            match condition {
                "missing" => std::fs::remove_file(&path).unwrap(),
                "tampered" => std::fs::write(&path, vec![b'x'; CONTENT.len()]).unwrap(),
                "incomplete backup" => {
                    std::fs::create_dir_all(root.path().join("backups").join(tag)).unwrap()
                }
                _ => (),
            }
            let launcher = RecordedLaunch {
                root: root.path(),
                tag,
                expected_head: updater.git.head_sha().unwrap(),
                path: Mutex::new(None),
            };
            let events = Mutex::new(Vec::new());
            let result = updater
                .install(
                    &launcher,
                    Some(&|status| events.lock().unwrap().push(status)),
                )
                .await;
            if condition == "ready" {
                let status = result.unwrap();
                assert_eq!(status.phase, UpdatePhase::Installing);
                assert_eq!(status.backup_tag.as_deref(), Some(tag));
                assert_eq!(launcher.path.into_inner().unwrap(), Some(path));
            } else {
                assert!(result.is_err());
                assert_eq!(updater.status().phase, UpdatePhase::Error);
                assert!(launcher.path.into_inner().unwrap().is_none());
            }
            assert_eq!(events.into_inner().unwrap().len(), 1);
            server.abort();
        }
    }

    #[test]
    fn rejects_insecure_urls_and_ambiguous_installer_names() {
        for url in [
            "http://example.com/installer",
            "http://127.0.0.1.example.com/installer",
            "file:///tmp/installer",
            "https://user:pass@example.com/installer",
        ] {
            assert!(update_url(url).is_err(), "{url}");
        }
        assert!(update_url("https://example.com/installer").is_ok());
        assert!(update_url("http://localhost:12345/installer").is_ok());
        assert!(asset_name(&format!("../{}", installer_name())).is_err());
        assert!(asset_name(&format!("nested\\{}", installer_name())).is_err());
        let mut release = manifest("https://example.com", "0.2.0", 1, false, None);
        release["assets"][env::consts::OS]["sizeBytes"] = (MAX_ASSET + 1).into();
        let feed: Feed = serde_json::from_value(release).unwrap();
        assert!(feed.select(&Version::new(0, 1, 0), 1).is_err());
    }
}
