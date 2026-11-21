use crate::{
    protocol::{ExecResult, SandboxMode},
    security::sha256,
};
use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[cfg(windows)]
#[path = "sandbox_windows.rs"]
pub(crate) mod windows;

const STAGE_LIMIT: u64 = 64 * 1024 * 1024;
const MAX_FILES: usize = 20_000;
const OUTPUT_LIMIT: usize = 1024 * 1024;
static WORKSPACE_WRITES: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn denied(reason: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, reason)
}

pub(crate) fn validate_relative(path: &str) -> io::Result<PathBuf> {
    if path.is_empty() || path.len() > 4096 {
        return Err(denied("invalid path length"));
    }
    let mut parts = Vec::new();
    for part in path.split(['/', '\\']) {
        if parts.len() == 64
            || part.is_empty()
            || matches!(part, "." | "..")
            || part.ends_with(['.', ' '])
            || part.starts_with(' ')
            || part
                .chars()
                .any(|c| c.is_control() || "<>:\"|?*~".contains(c))
        {
            return Err(denied("path traversal or ambiguous file name"));
        }
        let lower = part.to_uppercase().to_lowercase();
        let device = lower.split('.').next().unwrap_or_default();
        if matches!(
            lower.as_str(),
            ".git" | ".ssh" | ".harnex" | "src-tauri" | "trust.json"
        ) || matches!(device, "con" | "prn" | "aux" | "nul" | "conin$" | "conout$")
            || ["com", "lpt"].iter().any(|prefix| {
                device.strip_prefix(prefix).is_some_and(|n| {
                    matches!(
                        n,
                        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                    )
                })
            })
            || (parts.last().is_some_and(|last| *last == "packages")
                && matches!(lower.as_str(), "protocol" | "interfaces"))
        {
            return Err(denied("immutable path"));
        }
        parts.push(lower);
    }
    Ok(path.split(['/', '\\']).collect())
}

fn validate_absolute(path: &Path) -> io::Result<()> {
    let components: Vec<_> = path
        .components()
        .filter_map(|part| {
            if let std::path::Component::Normal(name) = part {
                Some(name.to_str())
            } else {
                None
            }
        })
        .collect::<Option<_>>()
        .ok_or_else(|| denied("non-UTF-8 sandbox path"))?;
    if !components.is_empty() {
        validate_relative(&components.join("/"))?;
    }
    if path
        .components()
        .any(|part| part == std::path::Component::ParentDir)
    {
        return Err(denied("parent traversal"));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug)]
pub enum Backend {
    Seatbelt,
    Bubblewrap,
    WindowsAppContainer,
    Unavailable,
}

impl Backend {
    pub fn detect() -> Self {
        if cfg!(target_os = "macos") && Path::new("/usr/bin/sandbox-exec").is_file() {
            Self::Seatbelt
        } else if cfg!(target_os = "linux") && bwrap().is_some() {
            Self::Bubblewrap
        } else if cfg!(windows) {
            Self::WindowsAppContainer
        } else {
            Self::Unavailable
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Seatbelt => "seatbelt",
            Self::Bubblewrap => "bubblewrap",
            Self::WindowsAppContainer => "windows-appcontainer-job",
            Self::Unavailable => "unavailable",
        }
    }
}

fn bwrap() -> Option<&'static str> {
    ["/usr/bin/bwrap", "/bin/bwrap"]
        .into_iter()
        .find(|path| Path::new(path).is_file())
}

pub struct Sandbox {
    root: PathBuf,
    dir: Dir,
    backend: Backend,
}

impl Sandbox {
    pub fn new(workspace: &Path) -> io::Result<Self> {
        if workspace
            .components()
            .any(|part| part == std::path::Component::ParentDir)
        {
            return Err(denied("parent traversal"));
        }
        let root = workspace.canonicalize()?;
        validate_absolute(&root)?;
        if root.parent().is_none()
            || dirs::home_dir()
                .and_then(|home| home.canonicalize().ok())
                .is_some_and(|home| root == home || home.starts_with(&root))
        {
            return Err(denied("workspace must be a dedicated directory"));
        }
        let dir = Dir::open_ambient_dir(&root, ambient_authority())?;
        Ok(Self {
            root,
            dir,
            backend: Backend::detect(),
        })
    }

    pub fn backend(&self) -> Backend {
        self.backend
    }

    pub(crate) fn new_shadow(workspace: &Path) -> io::Result<Self> {
        if !workspace.is_absolute() || !fs::symlink_metadata(workspace)?.is_dir() {
            return Err(denied("shadow workspace must be an absolute directory"));
        }
        let sandbox = Self::new(workspace)?;
        let temp = std::env::temp_dir().canonicalize()?;
        if sandbox.root.parent() != Some(temp.as_path())
            || !sandbox
                .root
                .file_name()
                .and_then(OsStr::to_str)
                .and_then(|name| name.strip_prefix("harnex-shadow-"))
                .is_some_and(|suffix| !suffix.is_empty())
        {
            return Err(denied("shadow workspace must be a disposable Harnex directory in the system temporary directory"));
        }
        Ok(sandbox)
    }

    pub(crate) fn overlaps(&self, other: &Self) -> bool {
        self.root.starts_with(&other.root) || other.root.starts_with(&self.root)
    }

    fn relative(&self, raw: &str) -> io::Result<PathBuf> {
        let path = Path::new(raw);
        if !path.is_absolute() {
            return validate_relative(raw);
        }
        if raw
            .split(['/', '\\'])
            .any(|part| matches!(part, "." | ".."))
        {
            return Err(denied("parent traversal"));
        }
        let relative = path.strip_prefix(&self.root).or_else(|_| {
            // Windows canonical paths may carry the \?\ prefix; only accept an exact canonical root.
            self.root
                .to_str()
                .and_then(|root| root.strip_prefix(r"\\?\"))
                .map(Path::new)
                .ok_or_else(|| denied("path is outside workspace"))
                .and_then(|root| {
                    path.strip_prefix(root)
                        .map_err(|_| denied("path is outside workspace"))
                })
        })?;
        validate_relative(
            relative
                .to_str()
                .ok_or_else(|| denied("non-UTF-8 sandbox path"))?,
        )
    }

    pub fn check_path(&self, raw: &str, mode: SandboxMode) -> io::Result<PathBuf> {
        if mode == SandboxMode::ReadOnly {
            return Err(denied("read-only sandbox"));
        }
        let relative = self.relative(raw)?;
        match open_parent(&self.dir, &relative, false) {
            Ok((parent, name)) => match parent.symlink_metadata(name) {
                Ok(meta) if meta.is_file() && !meta.is_symlink() => (),
                Ok(_) => return Err(denied("target must be a regular file")),
                Err(e) if e.kind() == io::ErrorKind::NotFound => (),
                Err(e) => return Err(e),
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
            Err(e) => return Err(e),
        }
        Ok(relative)
    }

    pub(crate) fn read_asset(&self, raw: &str) -> io::Result<(PathBuf, Vec<u8>)> {
        let rel = self.relative(raw)?;
        Ok((rel.clone(), read_file(&self.dir, &rel, STAGE_LIMIT)?))
    }

    pub(crate) fn cwd(&self, raw: Option<&str>) -> io::Result<PathBuf> {
        let Some(raw) = raw else {
            return Ok(PathBuf::new());
        };
        if raw == "." || Path::new(raw) == self.root {
            return Ok(PathBuf::new());
        }
        let relative = self.relative(raw)?;
        open_dir(&self.dir, &relative, false)?;
        Ok(relative)
    }

    pub fn write_file(&self, raw: &str, mode: SandboxMode, content: &[u8]) -> io::Result<()> {
        let _guard = WORKSPACE_WRITES.lock().unwrap();
        let relative = self.check_path(raw, mode)?;
        write_file(&self.dir, &relative, content)
    }

    pub fn delete_file(&self, raw: &str, mode: SandboxMode) -> io::Result<()> {
        let _guard = WORKSPACE_WRITES.lock().unwrap();
        let relative = self.check_path(raw, mode)?;
        let (parent, name) = open_parent(&self.dir, &relative, false)?;
        parent.remove_file(name)
    }

    pub(crate) fn can_run(&self, network: bool) -> io::Result<()> {
        match self.backend {
            Backend::Unavailable => Err(denied("OS process sandbox unavailable")),
            Backend::WindowsAppContainer if network => {
                Err(denied("the Windows sandbox does not allow network access"))
            }
            _ => Ok(()),
        }
    }

    pub(crate) async fn run(&self, spec: ProcessSpec) -> io::Result<ExecResult> {
        self.can_run(spec.network)?;
        let root = self.dir.try_clone()?;
        let backend = self.backend;
        tokio::task::spawn_blocking(move || execute_process(root, backend, spec))
            .await
            .map_err(io::Error::other)?
    }
}

fn open_dir(dir: &Dir, path: &Path, create: bool) -> io::Result<Dir> {
    let mut here = dir.try_clone()?;
    for part in path {
        let next = match here.open_dir_nofollow(part) {
            Err(err) if create && err.kind() == io::ErrorKind::NotFound => {
                match here.create_dir(part) {
                    Ok(()) => (),
                    Err(err) if err.kind() == io::ErrorKind::AlreadyExists => (),
                    Err(err) => return Err(err),
                }
                here.open_dir_nofollow(part)?
            }
            result => result?,
        };
        here = next;
    }
    Ok(here)
}

fn open_parent<'a>(dir: &Dir, path: &'a Path, create: bool) -> io::Result<(Dir, &'a OsStr)> {
    let name = path
        .file_name()
        .ok_or_else(|| denied("missing file name"))?;
    let parent = open_dir(dir, path.parent().unwrap_or(Path::new("")), create)?;
    Ok((parent, name))
}

fn read_file(root: &Dir, path: &Path, limit: u64) -> io::Result<Vec<u8>> {
    let (dir, name) = open_parent(root, path, false)?;
    let meta = dir.symlink_metadata(name)?;
    if !meta.is_file() || meta.is_symlink() || meta.len() > limit {
        return Err(denied("invalid file type or size"));
    }
    let file = dir.open_with(
        name,
        OpenOptions::new().read(true).follow(FollowSymlinks::No),
    )?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.nlink() != 1 {
        return Err(denied("invalid file type or hard link"));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(denied("file size limit exceeded"));
    }
    Ok(bytes)
}

fn write_file(root: &Dir, path: &Path, bytes: &[u8]) -> io::Result<()> {
    let (dir, name) = open_parent(root, path, true)?;
    let temp = format!(".harnex-write-{}", uuid::Uuid::new_v4());
    let mut file = dir.open_with(&temp, OpenOptions::new().write(true).create_new(true))?;
    let result = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    let result = result.and_then(|_| dir.rename(&temp, &dir, name));
    if result.is_err() {
        let _ = dir.remove_file(&temp);
    }
    result
}

pub(crate) enum Program {
    Command(PathBuf, Vec<String>),
    Bun {
        executable: PathBuf,
        asset: Vec<u8>,
        args: Vec<String>,
    },
}

pub(crate) struct ProcessSpec {
    pub program: Program,
    pub cwd: PathBuf,
    pub mode: SandboxMode,
    pub network: bool,
    pub timeout: Duration,
    pub stdin: Option<Vec<u8>>,
}

type Snapshot = BTreeMap<PathBuf, String>;

fn snapshot(root: &Dir, destination: Option<&Path>, reject_unsafe: bool) -> io::Result<Snapshot> {
    fn visit(
        dir: &Dir,
        relative: &Path,
        destination: Option<&Path>,
        reject: bool,
        files: &mut Snapshot,
        available: &mut u64,
    ) -> io::Result<()> {
        for entry in dir.entries()? {
            let entry = entry?;
            let path = relative.join(entry.file_name());
            let safe = path
                .to_str()
                .is_some_and(|path| validate_relative(path).is_ok());
            if !safe {
                if reject {
                    return Err(denied("sandbox produced a protected path"));
                }
                continue;
            }
            let kind = entry.file_type()?;
            if kind.is_dir() {
                if path.components().count() > 64 {
                    return Err(denied("sandbox directory nesting exceeds limit"));
                }
                if let Some(dest) = destination {
                    fs::create_dir(dest.join(&path))?;
                }
                visit(
                    &dir.open_dir_nofollow(entry.file_name())?,
                    &path,
                    destination,
                    reject,
                    files,
                    available,
                )?;
            } else if kind.is_file() {
                if files.len() >= MAX_FILES {
                    return Err(denied("sandbox file count exceeds limit"));
                }
                let bytes = read_file(dir, Path::new(&entry.file_name()), *available)?;
                *available -= bytes.len() as u64;
                if let Some(dest) = destination {
                    fs::write(dest.join(&path), &bytes)?;
                }
                files.insert(path, sha256(&bytes));
            } else if reject {
                return Err(denied("sandbox produced a link or special file"));
            }
        }
        Ok(())
    }
    let mut files = BTreeMap::new();
    let mut available = STAGE_LIMIT;
    visit(
        root,
        Path::new(""),
        destination,
        reject_unsafe,
        &mut files,
        &mut available,
    )?;
    Ok(files)
}

fn synchronize(root: &Dir, staged: &Dir, before: &Snapshot, after: &Snapshot) -> io::Result<()> {
    let _guard = WORKSPACE_WRITES.lock().unwrap();
    let paths: std::collections::BTreeSet<_> = before
        .keys()
        .chain(after.keys())
        .filter(|path| before.get(*path) != after.get(*path))
        .collect();
    let mut writes = Vec::new();
    for path in paths {
        let current = match read_file(root, path, STAGE_LIMIT) {
            Ok(bytes) => Some(sha256(&bytes)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) => return Err(e),
        };
        if current.as_ref() != before.get(path) {
            return Err(denied("workspace changed while the operation ran"));
        }
        let contents = after
            .get(path)
            .map(|digest| {
                let bytes = read_file(staged, path, STAGE_LIMIT)?;
                if sha256(&bytes) != *digest {
                    return Err(denied("sandbox output changed before import"));
                }
                Ok(bytes)
            })
            .transpose()?;
        writes.push((path, contents));
    }
    for (path, contents) in writes {
        if let Some(contents) = contents {
            write_file(root, path, &contents)?;
        } else {
            let (parent, name) = open_parent(root, path, false)?;
            parent.remove_file(name)?;
        }
    }
    Ok(())
}

pub(crate) fn command_path(name: &str) -> io::Result<PathBuf> {
    if name.is_empty()
        || name.len() > 120
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
    {
        return Err(denied("command must be a system executable name"));
    }
    #[cfg(windows)]
    {
        let system = windows::system_directory()?;
        let path = system.join(if name.to_ascii_lowercase().ends_with(".exe") {
            name.into()
        } else {
            format!("{name}.exe")
        });
        if path.is_file() {
            return Ok(path);
        }
    }
    #[cfg(unix)]
    for dir in ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
        let path = Path::new(dir).join(name);
        if path.is_file() {
            return Ok(path);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "system executable not found",
    ))
}

fn execute_process(root: Dir, backend: Backend, spec: ProcessSpec) -> io::Result<ExecResult> {
    let start = Instant::now();
    let stage = tempfile::Builder::new()
        .prefix("harnex-sandbox-")
        .tempdir()?;
    let stage_path = stage.path().canonicalize()?;
    let work = stage_path.join("work");
    fs::create_dir(&work)?;
    fs::create_dir(stage_path.join("tmp"))?;
    let stage_dir = Dir::open_ambient_dir(&stage_path, ambient_authority())?;
    let before = snapshot(&root, Some(&work), false)?;
    let guest = if matches!(backend, Backend::Bubblewrap) {
        Path::new("/l0").to_owned()
    } else {
        stage_path.clone()
    };
    let cwd = guest.join("work").join(&spec.cwd);
    let (program, args, embedded) = match spec.program {
        Program::Command(program, args) => (
            program,
            args.into_iter().map(OsString::from).collect::<Vec<_>>(),
            false,
        ),
        Program::Bun {
            executable,
            asset,
            args,
        } => {
            let runtime = if cfg!(windows) {
                "runtime.exe"
            } else {
                "runtime"
            };
            fs::copy(executable, stage_path.join(runtime))?;
            fs::write(stage_path.join("asset.ts"), asset)?;
            fs::write(stage_path.join("bunfig.toml"), "")?;
            let mut config = OsString::from("--config=");
            config.push(guest.join("bunfig.toml"));
            let mut argv = vec![
                OsString::from("--no-env-file"),
                OsString::from("--no-install"),
                config,
                guest.join("asset.ts").into_os_string(),
            ];
            argv.extend(args.into_iter().map(OsString::from));
            (guest.join(runtime), argv, true)
        }
    };
    let mut environment = BTreeMap::new();
    environment.insert("HOME", guest.join("tmp").into_os_string());
    for name in ["TEMP", "TMP", "TMPDIR"] {
        environment.insert(name, guest.join("tmp").into_os_string());
    }
    if embedded {
        environment.insert("BUN_BE_BUN", "1".into());
    }
    #[cfg(windows)]
    {
        let system = windows::system_directory()?;
        environment.insert("PATH", system.clone().into_os_string());
        let root = system
            .parent()
            .ok_or_else(|| denied("Windows system directory invalid"))?;
        environment.insert("SystemRoot", root.as_os_str().to_owned());
        environment.insert("windir", root.as_os_str().to_owned());
        for name in [
            "USERPROFILE",
            "LOCALAPPDATA",
            "APPDATA",
            "ProgramData",
            "SystemDrive",
        ] {
            if let Some(value) = std::env::var_os(name) {
                environment.insert(name, value);
            }
        }
    }
    #[cfg(unix)]
    {
        environment.insert("PATH", "/usr/bin:/bin:/usr/sbin:/sbin".into());
    }
    let (exit_code, stdout, stderr) = launch(
        backend,
        &stage_path,
        &cwd,
        &program,
        &args,
        &environment,
        spec.network,
        spec.timeout,
        spec.stdin,
    )?;
    if exit_code == 0 && spec.mode != SandboxMode::ReadOnly {
        let staged = stage_dir.open_dir_nofollow("work")?;
        let after = snapshot(&staged, None, true)?;
        synchronize(&root, &staged, &before, &after)?;
    }
    Ok(ExecResult {
        ok: exit_code == 0,
        exit_code,
        stdout,
        stderr,
        duration_ms: start.elapsed().as_millis() as u64,
        sandbox_backend: backend.name().into(),
        denied_reason: None,
    })
}

fn capture(mut input: impl Read) -> String {
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    while let Ok(n @ 1..) = input.read(&mut buffer) {
        bytes.extend_from_slice(&buffer[..n.min(OUTPUT_LIMIT.saturating_sub(bytes.len()))]);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn feed_input(
    mut writer: impl Write + Send + 'static,
    input: Vec<u8>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        // A hook may exit without reading all input. Closing the writer also signals EOF.
        let _ = writer.write_all(&input);
    })
}

#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
fn launch(
    backend: Backend,
    stage: &Path,
    cwd: &Path,
    program: &Path,
    args: &[OsString],
    env: &BTreeMap<&str, OsString>,
    network: bool,
    timeout: Duration,
    input: Option<Vec<u8>>,
) -> io::Result<(i32, String, String)> {
    use std::os::unix::process::{CommandExt, ExitStatusExt};
    use std::process::{Command, Stdio};
    let mut command = match backend {
        Backend::Bubblewrap => {
            let mut cmd = Command::new(bwrap().ok_or_else(|| denied("bubblewrap unavailable"))?);
            cmd.args(["--unshare-all", "--die-with-parent", "--cap-drop", "ALL"]);
            if network {
                cmd.arg("--share-net");
            }
            for directory in ["/usr", "/bin", "/sbin", "/lib", "/lib64"] {
                if Path::new(directory).is_dir() {
                    cmd.args(["--ro-bind", directory, directory]);
                }
            }
            cmd.args(["--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"]);
            for file in [
                "/etc/ld.so.cache",
                "/etc/resolv.conf",
                "/etc/hosts",
                "/etc/ssl/certs",
            ] {
                if Path::new(file).exists() {
                    cmd.args(["--ro-bind", file, file]);
                }
            }
            cmd.arg("--ro-bind")
                .arg(stage)
                .arg("/l0")
                .arg("--bind")
                .arg(stage.join("work"))
                .arg("/l0/work")
                .arg("--bind")
                .arg(stage.join("tmp"))
                .arg("/l0/tmp")
                .arg("--chdir")
                .arg(cwd)
                .arg("--");
            cmd
        }
        Backend::Seatbelt => {
            let mut cmd = Command::new("/usr/bin/sandbox-exec");
            cmd.arg("-p")
                .arg(seatbelt_profile(stage, network)?)
                .current_dir(cwd)
                .arg("--");
            cmd
        }
        _ => return Err(denied("no OS process sandbox")),
    };
    let mut child = command
        .arg(program)
        .args(args)
        .env_clear()
        .envs(env)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()?;
    let writer = input
        .zip(child.stdin.take())
        .map(|(input, pipe)| feed_input(pipe, input));
    let pid = child.id() as i32;
    let stdout = std::thread::spawn({
        let pipe = child.stdout.take().unwrap();
        move || capture(pipe)
    });
    let stderr = std::thread::spawn({
        let pipe = child.stderr.take().unwrap();
        move || capture(pipe)
    });
    let start = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                break Ok(status
                    .code()
                    .unwrap_or_else(|| 128 + status.signal().unwrap_or(0)))
            }
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(10)),
            Ok(None) => break Ok(124),
            Err(e) => break Err(e),
        }
    };
    // The process group owns the pipe writers, including any descendants of the main process.
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
    let _ = child.wait();
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    Ok((
        code?,
        stdout.join().unwrap_or_default(),
        stderr.join().unwrap_or_default(),
    ))
}

#[cfg(windows)]
use windows::launch;

#[cfg(not(any(unix, windows)))]
#[allow(clippy::too_many_arguments)]
fn launch(
    _: Backend,
    _: &Path,
    _: &Path,
    _: &Path,
    _: &[OsString],
    _: &BTreeMap<&str, OsString>,
    _: bool,
    _: Duration,
    _: Option<Vec<u8>>,
) -> io::Result<(i32, String, String)> {
    Err(denied("no OS process sandbox"))
}

pub fn seatbelt_profile(stage: &Path, network: bool) -> io::Result<String> {
    let root = stage
        .to_str()
        .filter(|path| path.starts_with('/') && !path.chars().any(char::is_control))
        .ok_or_else(|| denied("invalid Seatbelt root"))?;
    let work = serde_json::to_string(&format!("{root}/work"))?;
    let temp = serde_json::to_string(&format!("{root}/tmp"))?;
    let root = serde_json::to_string(root)?;
    Ok(format!(
        r#"(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow dynamic-code-generation)
(allow sysctl-read)
(allow sysctl-write (sysctl-name "kern.grade_cputype"))
(allow file-read-metadata)
(allow file-map-executable)
(allow file-read* (literal "/") (literal "/private") (literal "/private/var") (literal "/private/var/folders") (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/Library") (subpath "/private/etc") (subpath "/private/var/db") (subpath "/dev") (subpath {root}))
(allow file-write* (subpath {work}) (subpath {temp}) (literal "/dev/null") (literal "/dev/dtracehelper"))
(allow file-ioctl (literal "/dev/null") (literal "/dev/dtracehelper"))
(allow mach-lookup)
(allow ipc-posix-sem)
(allow ipc-posix-shm*)
(allow user-preference-read)
(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))
{}"#,
        if network {
            "(allow network-outbound)"
        } else {
            ""
        }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_guard_blocks_absolute_traversal_protected_paths_and_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        fs::create_dir(&work).unwrap();
        let os = Sandbox::new(&work).unwrap();
        for name in [
            "../outside",
            "folder/../../outside",
            ".git/HEAD",
            "nested/.GIT/config",
            ".harnex/harness/HEAD",
            ".ssh/key",
            "apps/desktop/src-tauri/main.rs",
            "trust.json",
            "file:stream",
        ] {
            assert!(
                os.write_file(name, SandboxMode::WorkspaceWrite, b"bad")
                    .is_err(),
                "{name}"
            );
            assert!(
                os.check_path(name, SandboxMode::WorkspaceWrite).is_err(),
                "{name}"
            );
        }
        let outside = dir.path().join("outside");
        fs::write(&outside, b"keep").unwrap();
        assert!(os
            .write_file(
                outside.to_str().unwrap(),
                SandboxMode::WorkspaceWrite,
                b"no"
            )
            .is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.path(), work.join("link")).unwrap();
            assert!(os
                .write_file("link/outside", SandboxMode::WorkspaceWrite, b"no")
                .is_err());
        }
        #[cfg(windows)]
        if std::os::windows::fs::symlink_dir(dir.path(), work.join("link")).is_ok() {
            assert!(os
                .write_file("link/outside", SandboxMode::WorkspaceWrite, b"no")
                .is_err());
        }
        assert_eq!(fs::read(outside).unwrap(), b"keep");
        assert!(os
            .write_file("result.csv", SandboxMode::ReadOnly, b"no")
            .is_err());
        os.write_file("nested/result.csv", SandboxMode::WorkspaceWrite, b"ok")
            .unwrap();
        os.delete_file("nested/result.csv", SandboxMode::WorkspaceWrite)
            .unwrap();
    }
}
