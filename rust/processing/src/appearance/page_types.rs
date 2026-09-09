// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::{AppearancePlan, AppearanceRequest};
use serde::{Deserialize, Serialize};

/// Offset into the separately supplied top-down, straight-alpha RGBA8 payload.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppearanceRaster {
    pub width: u32,
    pub height: u32,
    pub byte_offset: usize,
    pub byte_length: usize,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppearanceSourceRaster {
    /// Exact effective IfcImageTexture.URLReference; runtime GPU IDs may differ.
    pub image_uri: String,
    pub raster: AppearanceRaster,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageAppearanceRequest {
    /// Must use Planar mapping and non-repeating axes. Generated atlas URIs are
    /// textures/<SHA256 of encoded PNG bytes>.png, independent of input imageUri.
    pub appearance: AppearanceRequest,
    pub page: AppearanceRaster,
    pub source_images: Vec<AppearanceSourceRaster>,
    /// Requested atlas sampling density. Never silently reduced to meet limits.
    pub texels_per_metre: f64,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceItemImage {
    pub geometry_item_id: u32,
    pub image_uri: String,
}
#[derive(Debug, Clone)]
pub struct AppearanceGeneratedImage {
    pub image_uri: String,
    pub width: u32,
    pub height: u32,
    pub png: Vec<u8>,
}
#[derive(Debug)]
pub struct PageAppearancePlan {
    pub plan: AppearancePlan,
    pub item_images: Vec<AppearanceItemImage>,
    pub assets: Vec<AppearanceGeneratedImage>,
    pub texels_per_metre: f64,
}
