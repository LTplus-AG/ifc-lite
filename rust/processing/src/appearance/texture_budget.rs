// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::source::Source;
use ifc_lite_core::{AttributeValue as A, IfcType};
use std::collections::BTreeSet;
const ERROR: &str = "Appearance source texture budget exceeded. Reduce embedded image sizes or simplify texture mappings before authoring.";

/// Canonical indexing scans ALL maps, including those outside the chosen scope.
/// Charge shared UV lists per map, but decoded rasters once per texture identity.
pub(super) fn preflight(source: &mut Source<'_>) -> Result<(), String> {
    let maps: Vec<u32> = source.texture_maps.values().flatten().copied().collect();
    let mut uvs = 0usize;
    let mut corners = 0usize;
    let mut raster_bytes = 0u64;
    let mut textures = BTreeSet::new();
    for id in maps {
        let map = source.entity(id)?;
        if let Some(list_id) = map.get_ref(2) {
            let list = source.entity(list_id)?;
            let count = list.get(0).and_then(A::as_list).map_or(0, |rows| rows.len());
            uvs = uvs.checked_add(count).ok_or(ERROR)?;
            if uvs > 500_000 { return Err(ERROR.into()); }
        }
        let triangles = map.get(3).and_then(A::as_list).map_or(0, |rows| rows.len());
        corners = triangles.checked_mul(3).and_then(|count| corners.checked_add(count)).ok_or(ERROR)?;
        if corners > 1_500_000 { return Err(ERROR.into()); }
        let texture_id = map.get(0).and_then(A::as_list).and_then(|ids| ids.iter().find_map(A::as_entity_ref));
        let Some(texture_id) = texture_id else { continue; };
        if !textures.insert(texture_id) { continue; }
        let texture = source.entity(texture_id)?;
        let dimensions = match texture.ifc_type {
            IfcType::IfcPixelTexture => {
                let dimension = |index| {
                    texture.get(index).and_then(A::as_int)
                        .and_then(|v| u32::try_from(v).ok())
                        .filter(|&v| v > 0 && v <= ifc_lite_geometry::MAX_TEXTURE_DIMENSION)
                        .ok_or_else(|| format!("{ERROR} Invalid embedded pixel texture dimensions"))
                };
                Some((dimension(5)?, dimension(6)?))
            }
            IfcType::IfcBlobTexture => {
                let encoded = texture.get(6).and_then(A::as_string).ok_or("Invalid embedded raster texture")?;
                Some(ifc_lite_geometry::embedded_raster_dimensions(encoded).ok_or("Cannot budget embedded image header; re-export it as valid PNG or JPEG")?)
            }
            _ => None,
        };
        if let Some((width, height)) = dimensions {
            // Decoder output plus RGBA conversion coexist; conservatively reserve
            // eight bytes per pixel before either allocation (PNG16 is stripped).
            let cost = u64::from(width).checked_mul(u64::from(height)).and_then(|v| v.checked_mul(8)).ok_or(ERROR)?;
            raster_bytes = raster_bytes.checked_add(cost).ok_or(ERROR)?;
            if raster_bytes > 128 * 1024 * 1024 { return Err(ERROR.into()); }
        }
    }
    Ok(())
}
