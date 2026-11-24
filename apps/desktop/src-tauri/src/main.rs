#![cfg_attr(
    all(not(debug_assertions), feature = "tauri-runtime"),
    windows_subsystem = "windows"
)]

#[cfg(feature = "tauri-runtime")]
fn main() {
    harnex_l0::tray::run();
}

#[cfg(not(feature = "tauri-runtime"))]
fn main() {
    println!("Harnex L0 core v{}", harnex_l0::protocol::PROTOCOL_VERSION);
}
