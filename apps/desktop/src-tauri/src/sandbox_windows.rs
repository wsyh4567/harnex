use super::{capture, denied, feed_input, Backend};
use std::{
    collections::BTreeMap,
    ffi::{c_void, OsStr, OsString},
    fs::File,
    io,
    mem::{size_of, size_of_val},
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    ptr::{null, null_mut},
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::{
        LocalFree, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    Security::{
        Authorization::*,
        FreeSid,
        Isolation::{CreateAppContainerProfile, DeleteAppContainerProfile},
        DACL_SECURITY_INFORMATION, PSID, SECURITY_CAPABILITIES, SUB_CONTAINERS_AND_OBJECTS_INHERIT,
    },
    Storage::FileSystem::{DELETE, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE},
    System::{JobObjects::*, SystemInformation::GetSystemDirectoryW, Threading::*},
};

pub(crate) fn system_directory() -> io::Result<PathBuf> {
    let mut path = vec![0; 32768];
    let size = unsafe { GetSystemDirectoryW(path.as_mut_ptr(), path.len() as u32) } as usize;
    if size == 0 || size >= path.len() {
        return Err(io::Error::last_os_error());
    }
    Ok(PathBuf::from(OsString::from_wide(&path[..size])))
}

fn wide(value: &OsStr) -> io::Result<Vec<u16>> {
    let mut value: Vec<_> = value.encode_wide().collect();
    if value.contains(&0) {
        return Err(denied("NUL in process arguments"));
    }
    value.push(0);
    Ok(value)
}

fn win32(result: i32) -> io::Result<()> {
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
fn acl_result(result: u32) -> io::Result<()> {
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(result as i32))
    }
}

struct Local(*mut c_void);
impl Drop for Local {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

struct Profile {
    name: Vec<u16>,
    sid: PSID,
}
impl Profile {
    fn new() -> io::Result<Self> {
        let name = wide(OsStr::new(&format!("Harnex.{}", uuid::Uuid::new_v4())))?;
        let description = wide(OsStr::new("Harnex isolated process"))?;
        let mut sid = null_mut();
        let result = unsafe {
            CreateAppContainerProfile(
                name.as_ptr(),
                description.as_ptr(),
                description.as_ptr(),
                null(),
                0,
                &mut sid,
            )
        };
        if result < 0 {
            return Err(io::Error::from_raw_os_error(result));
        }
        Ok(Self { name, sid })
    }

    fn grant(&self, stage: &Path, access: u32) -> io::Result<()> {
        let path = wide(stage.as_os_str())?;
        let mut descriptor = Local(null_mut());
        let mut old = null_mut();
        unsafe {
            acl_result(GetNamedSecurityInfoW(
                path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut old,
                null_mut(),
                &mut descriptor.0,
            ))?;
            if old.is_null() {
                return Err(denied("staging directory has no ACL"));
            }
            let entry = EXPLICIT_ACCESS_W {
                grfAccessPermissions: access,
                grfAccessMode: GRANT_ACCESS,
                grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
                Trustee: TRUSTEE_W {
                    TrusteeForm: TRUSTEE_IS_SID,
                    TrusteeType: TRUSTEE_IS_UNKNOWN,
                    ptstrName: self.sid.cast(),
                    ..Default::default()
                },
            };
            let mut new = null_mut();
            let result = SetEntriesInAclW(1, &entry, old, &mut new);
            let _new = Local(new.cast());
            acl_result(result)?;
            acl_result(SetNamedSecurityInfoW(
                path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                new,
                null(),
            ))
        }
    }
}

impl Drop for Profile {
    fn drop(&mut self) {
        unsafe {
            DeleteAppContainerProfile(self.name.as_ptr());
            FreeSid(self.sid);
        }
    }
}

struct Attributes {
    _memory: Vec<usize>,
    pointer: LPPROC_THREAD_ATTRIBUTE_LIST,
}
impl Attributes {
    fn new(count: u32) -> io::Result<Self> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), count, 0, &mut bytes);
        }
        if bytes == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut memory = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        let pointer = memory.as_mut_ptr().cast();
        win32(unsafe { InitializeProcThreadAttributeList(pointer, count, 0, &mut bytes) })?;
        Ok(Self {
            _memory: memory,
            pointer,
        })
    }

    fn set<T>(&self, id: u32, value: &T) -> io::Result<()> {
        win32(unsafe {
            UpdateProcThreadAttribute(
                self.pointer,
                0,
                id as usize,
                (value as *const T).cast(),
                size_of_val(value),
                null_mut(),
                null(),
            )
        })
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.pointer) }
    }
}

fn quoted(value: &OsStr, line: &mut Vec<u16>) -> io::Result<()> {
    const SLASH: u16 = b'\\' as u16;
    const QUOTE: u16 = b'"' as u16;
    line.push(QUOTE);
    let mut slashes = 0;
    for ch in value.encode_wide() {
        if ch == 0 {
            return Err(denied("NUL in process arguments"));
        }
        if ch == SLASH {
            slashes += 1;
            continue;
        }
        if ch == QUOTE {
            line.extend(std::iter::repeat_n(SLASH, slashes + 1));
        }
        line.extend(std::iter::repeat_n(SLASH, slashes));
        slashes = 0;
        line.push(ch);
    }
    line.extend(std::iter::repeat_n(SLASH, slashes * 2));
    line.push(QUOTE);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn launch(
    backend: Backend,
    stage: &Path,
    cwd: &Path,
    program: &Path,
    args: &[OsString],
    environment: &BTreeMap<&str, OsString>,
    network: bool,
    timeout: Duration,
    input: Option<Vec<u8>>,
) -> io::Result<(i32, String, String)> {
    if !matches!(backend, Backend::WindowsAppContainer) || network {
        return Err(denied("AppContainer required"));
    }
    let profile =
        Profile::new().map_err(|e| io::Error::other(format!("AppContainer profile: {e}")))?;
    let readable = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
    let writable = readable | FILE_GENERIC_WRITE | DELETE;
    profile
        .grant(stage, readable)
        .and_then(|_| profile.grant(&stage.join("work"), writable))
        .and_then(|_| profile.grant(&stage.join("tmp"), writable))
        .map_err(|e| io::Error::other(format!("AppContainer staging ACL: {e}")))?;
    let job = unsafe { CreateJobObjectW(null(), null()) };
    if job.is_null() {
        return Err(io::Error::last_os_error());
    }
    let job = unsafe { OwnedHandle::from_raw_handle(job) };
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        | JOB_OBJECT_LIMIT_JOB_MEMORY;
    limits.BasicLimitInformation.ActiveProcessLimit = 16;
    limits.JobMemoryLimit = 1024 * 1024 * 1024;
    win32(unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            size_of_val(&limits) as u32,
        )
    })?;

    let (out, out_writer) = io::pipe()?;
    let (err, err_writer) = io::pipe()?;
    let input_pipe = input.as_ref().map(|_| io::pipe()).transpose()?;
    let null_input = if input_pipe.is_none() {
        Some(File::open("NUL")?)
    } else {
        None
    };
    let handles: [HANDLE; 3] = [
        input_pipe
            .as_ref()
            .map(|(reader, _)| reader.as_raw_handle())
            .unwrap_or_else(|| null_input.as_ref().unwrap().as_raw_handle()),
        out_writer.as_raw_handle(),
        err_writer.as_raw_handle(),
    ];
    for &handle in &handles {
        win32(unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) })?;
    }
    let capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: profile.sid,
        ..Default::default()
    };
    let jobs = [job.as_raw_handle()];
    let attributes = Attributes::new(3)?;
    attributes.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &handles)?;
    attributes.set(PROC_THREAD_ATTRIBUTE_JOB_LIST, &jobs)?;
    attributes.set(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities)?;

    let exe = wide(program.as_os_str())?;
    let cwd = wide(cwd.as_os_str())?;
    let mut line = Vec::new();
    quoted(program.as_os_str(), &mut line)?;
    for arg in args {
        line.push(b' ' as u16);
        quoted(arg, &mut line)?;
    }
    line.push(0);
    let mut variables: Vec<_> = environment.iter().collect();
    variables.sort_unstable_by_key(|(name, _)| name.to_ascii_uppercase());
    let mut env = Vec::new();
    for (name, value) in variables {
        let mut pair = OsString::from(format!("{name}="));
        pair.push(value);
        env.extend(wide(&pair)?);
    }
    env.push(0);
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    (
        startup.StartupInfo.hStdInput,
        startup.StartupInfo.hStdOutput,
        startup.StartupInfo.hStdError,
    ) = (handles[0], handles[1], handles[2]);
    startup.lpAttributeList = attributes.pointer;
    let mut info = PROCESS_INFORMATION::default();
    win32(unsafe {
        CreateProcessW(
            exe.as_ptr(),
            line.as_mut_ptr(),
            null(),
            null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
            env.as_ptr().cast(),
            cwd.as_ptr(),
            &startup.StartupInfo,
            &mut info,
        )
    })
    .map_err(|e| io::Error::other(format!("AppContainer launch: {e}")))?;
    let process = unsafe { OwnedHandle::from_raw_handle(info.hProcess) };
    let _thread = unsafe { OwnedHandle::from_raw_handle(info.hThread) };
    let writer = input
        .zip(input_pipe)
        .map(|(input, (_reader, writer))| feed_input(writer, input));
    drop(out_writer);
    drop(err_writer);
    let stdout = std::thread::spawn(move || capture(out));
    let stderr = std::thread::spawn(move || capture(err));
    let mut exit: u32 = 0;
    let status = match unsafe {
        WaitForSingleObject(
            process.as_raw_handle(),
            timeout.as_millis().min(u32::MAX as u128 - 1) as u32,
        )
    } {
        WAIT_OBJECT_0 => win32(unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut exit) }),
        WAIT_TIMEOUT => {
            exit = 124;
            Ok(())
        }
        _ => Err(io::Error::last_os_error()),
    };
    drop(job);
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    Ok((
        status.map(|()| exit as i32)?,
        stdout.join().unwrap_or_default(),
        stderr.join().unwrap_or_default(),
    ))
}
