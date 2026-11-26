pub mod budget;
pub mod executor;
pub mod git_store;
pub mod guardian;
pub mod hooks;
pub mod keyring;
mod pricing_catalog;
pub mod protocol;
pub mod risk;
pub mod runtime;
pub mod sandbox_os;
pub mod security;
pub mod sidecar;
#[cfg(feature = "tauri-runtime")]
pub mod tray;
#[cfg(feature = "tui")]
pub mod tui;
pub mod updater;

use std::{fs, io, path::Path};

fn persist_json(path: &Path, data: &impl serde::Serialize) -> io::Result<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent)?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(file.as_file_mut(), data)?;
    file.as_file().sync_all()?;
    file.persist(path)?;
    Ok(())
}
