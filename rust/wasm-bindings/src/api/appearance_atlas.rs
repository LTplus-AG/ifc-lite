// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::appearance::encode_bounded;
use ifc_lite_processing::appearance::{AppearanceItemImage, AppearancePlan, PageAppearancePlan};
use serde::Serialize;

pub(super) fn encode_atlas(
    result: Option<&PageAppearancePlan>,
    density: f64,
    extra: &impl Serialize,
) -> Result<Vec<u8>, String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Asset<'a> {
        image_uri: &'a str,
        width: u32,
        height: u32,
        byte_offset: usize,
        byte_length: usize,
    }
    let mut offset = 0usize;
    let assets: Vec<_> = result
        .into_iter()
        .flat_map(|r| r.assets.iter())
        .map(|asset| {
            let metadata = Asset {
                image_uri: &asset.image_uri,
                width: asset.width,
                height: asset.height,
                byte_offset: offset,
                byte_length: asset.png.len(),
            };
            offset += asset.png.len();
            metadata
        })
        .collect();
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Metadata<'a, T: Serialize> {
        plan: Option<&'a AppearancePlan>,
        item_images: &'a [AppearanceItemImage],
        assets: &'a [Asset<'a>],
        texels_per_metre: f64,
        #[serde(flatten)]
        extra: &'a T,
    }
    let metadata = encode_bounded(&Metadata {
        plan: result.map(|r| &r.plan),
        item_images: result.map_or(&[], |r| r.item_images.as_slice()),
        assets: &assets,
        texels_per_metre: density,
        extra,
    })?;
    let size = 8usize
        .checked_add(metadata.len())
        .and_then(|v| v.checked_add(offset))
        .ok_or("Page output length overflow")?;
    if size > 160 * 1024 * 1024 {
        return Err("Page output exceeds 160 MiB transport budget".into());
    }
    let mut output = Vec::with_capacity(size);
    output.extend_from_slice(b"IFPA");
    output.extend_from_slice(&(metadata.len() as u32).to_le_bytes());
    output.extend_from_slice(&metadata);
    for asset in result.into_iter().flat_map(|r| &r.assets) {
        output.extend_from_slice(&asset.png);
    }
    Ok(output)
}
