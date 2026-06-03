// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcIndexedColourMap` resolution (issue #913, Phase 2).
//!
//! Ported from the browser pipeline (`rust/wasm-bindings/src/api/styling.rs`)
//! so the backend resolves the same authored colors. CATIA / 3DEXPERIENCE
//! exports color tessellated geometry through `IFCINDEXEDCOLOURMAP` +
//! `IFCCOLOURRGBLIST` with no `IFCSTYLEDITEM` chain; pre-fix the backend
//! ignored them and fell back to the default type color (issue #663).
//!
//! This resolves the **dominant** palette color per face set — enough to fix
//! the off-white regression. Per-triangle splitting (issue #858, the
//! multi-color face set case) is a follow-up that needs mesh partitioning at
//! emission time.

use super::Rgba;
use ifc_lite_core::{DecodedEntity, EntityDecoder};

/// Resolve an `IfcIndexedColourMap` to `(target geometry id, dominant colour)`.
///
/// Schema (IFC4):
/// - attr 0: `MappedTo` → `IfcTessellatedFaceSet` (the geometry to color)
/// - attr 1: `Opacity` (optional `0..=1`, `1.0` when omitted)
/// - attr 2: `Colours` → `IfcColourRgbList`
/// - attr 3: `ColourIndex` → list of 1-based indices into `Colours`
///
/// Single-index maps (the common case) take that index directly; multi-index
/// maps take the most-frequent one.
pub(crate) fn resolve_indexed_colour_map(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Option<(u32, Rgba)> {
    let geometry_id = entity.get_ref(0)?;
    let opacity = entity
        .get(1)
        .and_then(|a| a.as_float())
        .map(|v| v as f32)
        .unwrap_or(1.0);
    let colours_id = entity.get_ref(2)?;
    let index_attr = entity.get(3)?;
    let index_list = index_attr.as_list()?;

    let dominant_index: usize = if index_list.is_empty() {
        return None;
    } else if index_list.len() == 1 {
        index_list[0].as_int()? as usize
    } else {
        let mut counts: rustc_hash::FxHashMap<i64, u32> = rustc_hash::FxHashMap::default();
        for v in index_list {
            if let Some(i) = v.as_int() {
                *counts.entry(i).or_insert(0) += 1;
            }
        }
        *counts.iter().max_by_key(|(_, c)| *c)?.0 as usize
    };

    // IfcColourRgbList.ColourList is attr 0; index is 1-based (ISO 10303-21).
    let colours = decoder.decode_by_id(colours_id).ok()?;
    let colour_list = colours.get(0)?.as_list()?;
    let zero_based = dominant_index.checked_sub(1).unwrap_or(0);
    let rgb = colour_list.get(zero_based)?.as_list()?;

    let r = rgb.first().and_then(|v| v.as_float())? as f32;
    let g = rgb.get(1).and_then(|v| v.as_float())? as f32;
    let b = rgb.get(2).and_then(|v| v.as_float())? as f32;

    Some((geometry_id, Rgba::new(r, g, b, opacity.clamp(0.0, 1.0))))
}
