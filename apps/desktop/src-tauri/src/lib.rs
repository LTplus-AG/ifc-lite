// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IFC-Lite Desktop — Tauri v2 reference shell.
//!
//! This is the native host the surviving `@ifc-lite/geometry` `NativeBridge`
//! talks to. It registers the geometry commands documented in
//! `docs/guide/desktop.md` and drives them through `ifc-lite-desktop-engine`,
//! which wraps the same shared processing pipeline as the WASM build and the
//! HTTP server — but compiled native, with a real Rayon thread pool over one
//! shared-memory heap (no per-worker WASM heap duplication, no wasm32 4 GB cap).
//!
//! The frontend is the ordinary web viewer: in a Tauri window
//! `GeometryProcessor({ preferNative: true })` detects `isTauri()` and routes
//! geometry to these commands instead of WASM. See `apps/desktop/src`.

mod commands;
mod pool;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::ifc::get_geometry,
            commands::ifc::get_geometry_from_path,
            commands::ifc::get_geometry_streaming,
            commands::file_dialog::open_ifc_file,
        ])
        .setup(|app| {
            if let Ok(cache_dir) = app.path().app_cache_dir() {
                let _ = std::fs::create_dir_all(&cache_dir);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
