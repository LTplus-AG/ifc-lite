// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IFC-Lite Desktop Application
//!
//! Native Tauri application that provides high-performance IFC parsing
//! and geometry processing using the same Rust crates as the WASM version,
//! but with native performance and multi-threading support.

mod commands;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::ifc::get_geometry,
            commands::ifc::get_geometry_streaming,
            commands::cache::get_cached,
            commands::cache::set_cached,
            commands::cache::clear_cache,
            commands::cache::delete_cache_entry,
            commands::cache::get_cache_stats,
            commands::file_dialog::open_ifc_file,
        ])
        .setup(|app| {
            // Create cache directory on startup
            if let Ok(cache_dir) = app.path().app_cache_dir() {
                let _ = std::fs::create_dir_all(&cache_dir);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
