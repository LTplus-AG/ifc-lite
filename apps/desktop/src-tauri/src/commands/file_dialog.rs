// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Native file-picker command.

use super::types::FileInfo;
use tauri_plugin_dialog::DialogExt;

/// Open a native file dialog to select an IFC file. Returns the path + metadata
/// (not the contents); the frontend either reads the bytes via the fs plugin and
/// calls `get_geometry_streaming`, or passes the path to `get_geometry_from_path`.
#[tauri::command]
pub async fn open_ifc_file(app: tauri::AppHandle) -> Result<Option<FileInfo>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("IFC Files", &["ifc", "ifczip", "ifcxml"])
        .add_filter("All Files", &["*"])
        .set_title("Open IFC File")
        .blocking_pick_file();

    let Some(path) = picked else {
        return Ok(None);
    };
    let path_str = path.to_string();

    let metadata = tokio::fs::metadata(&path_str)
        .await
        .map_err(|e| format!("Failed to read file metadata: {e}"))?;

    let name = std::path::Path::new(&path_str)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown.ifc")
        .to_string();

    Ok(Some(FileInfo {
        path: path_str,
        name,
        size: metadata.len(),
    }))
}
