use harnex_l0::sandbox_os::Backend;
use std::{
    env, io,
    path::{Path, PathBuf},
    process::Command,
};

pub fn compiled_bun(root: &Path) -> Option<PathBuf> {
    let executable = env::var_os("HARNEX_TEST_COMPILED_BUN").map(PathBuf::from);
    let required = executable.is_some() || env::var_os("HARNEX_REQUIRE_PENTEST_SANDBOX").is_some();
    if matches!(Backend::detect(), Backend::Unavailable) {
        assert!(!required, "OS sandbox unavailable");
        return None;
    }
    if let Some(executable) = executable {
        assert!(
            executable.is_file(),
            "HARNEX_TEST_COMPILED_BUN must point to a compiled Bun executable"
        );
        return Some(executable);
    }

    let output = root.join(if cfg!(windows) {
        "fixture.exe"
    } else {
        "fixture"
    });
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/bun_sidecar.ts");
    let result = Command::new("bun")
        .args(["build", "--compile", "--outfile"])
        .arg(&output)
        .arg(fixture)
        .output();
    match result {
        Ok(result) => assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        ),
        Err(error) if error.kind() == io::ErrorKind::NotFound && !required => return None,
        Err(error) => panic!("Bun fixture compilation failed: {error}"),
    }
    Some(output)
}
