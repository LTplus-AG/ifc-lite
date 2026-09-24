// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Decoded/referenced surface texture attached to a `MeshData` (issues #961,
//! #1781). Split out of `mesh.rs` under the ~400-line module rule.

use serde::{Deserialize, Serialize};

/// A surface texture attached to a mesh (issues #961, #1781). Exactly one of
/// `rgba` / `url` is set:
/// - `rgba`: decoded in Rust (`IfcBlobTexture` PNG / `IfcPixelTexture` raw);
///   the browser only uploads it to a GPU texture — no image logic in TS.
/// - `url`: an `IfcImageTexture` reference (#1781) the HOST layer resolves —
///   typically a sibling image file inside the `.ifcZIP` container. Real files
///   share one multi-megapixel image across dozens of face sets, so the
///   pipeline ships the reference, never per-mesh pixels.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshTextureData {
    /// Express id of the source `IfcSurfaceTexture` — the stable dedup key:
    /// every mesh sampling the same image carries the same id, so consumers
    /// create ONE GPU texture per id, not one per mesh. 0 in legacy payloads.
    #[serde(default)]
    pub texture_id: u32,
    /// `width * height * 4` bytes, row-major, top-down, straight alpha.
    /// `Arc`-shared across meshes; `None` for an external image reference.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rgba: Option<std::sync::Arc<Vec<u8>>>,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    /// `IfcImageTexture.URLReference` verbatim (#1781); `None` for decoded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Sampler wrap from `IfcSurfaceTexture.RepeatS/RepeatT`.
    pub repeat_s: bool,
    pub repeat_t: bool,
}

impl MeshTextureData {
    /// Build from the geometry crate's per-face-set attachment.
    pub fn from_attachment(att: &ifc_lite_geometry::TextureAttachment) -> Self {
        match &att.source {
            ifc_lite_geometry::TextureSource::Decoded(tex) => Self {
                texture_id: att.texture_id,
                rgba: Some(tex.rgba.clone()),
                width: tex.width,
                height: tex.height,
                url: None,
                repeat_s: tex.repeat_s,
                repeat_t: tex.repeat_t,
            },
            ifc_lite_geometry::TextureSource::Image(img) => Self {
                texture_id: att.texture_id,
                rgba: None,
                width: 0,
                height: 0,
                url: Some(img.url.clone()),
                repeat_s: img.repeat_s,
                repeat_t: img.repeat_t,
            },
        }
    }
}
