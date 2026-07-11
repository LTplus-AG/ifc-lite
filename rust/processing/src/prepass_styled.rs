// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Styled-item resolution helpers for the pre-pass (split from `prepass.rs`).
//! The loop here is byte-identical to the historic inline loop in
//! `resolve_prepass`; the sharded pre-pass fans slices of it across workers.

use ifc_lite_core::EntityDecoder;
use rustc_hash::FxHashMap;

use crate::prepass::{collect_geometry_style_info, extract_style_info_from_styled_item, Span};
use crate::style::GeometryStyleInfo;

/// Pre-resolved styled maps: `(orphan id -> rgba, geometry id -> style info)`.
pub type StyleSeeds = (FxHashMap<u32, [f32; 4]>, FxHashMap<u32, GeometryStyleInfo>);

/// The styled-item classification/resolution loop of [`resolve_prepass`],
/// exposed so the browser's SHARDED pre-pass can fan slices of the (file-
/// ordered) styled-item span list across workers: each worker resolves its
/// contiguous slice with this exact loop, and the host merges shard results in
/// shard order with first-wins per geometry id — reproducing the serial
/// resolver's file-order first-wins precedence (`collect_geometry_style_info`
/// skips ids already present).
pub fn resolve_styled_items_into(
    styled_items: &[Span],
    decoder: &mut EntityDecoder,
    defer_attached_styles: bool,
    orphan_styled_items: &mut FxHashMap<u32, [f32; 4]>,
    geometry_style_index: &mut FxHashMap<u32, GeometryStyleInfo>,
    deferred_attached_styled_spans: &mut Vec<(usize, usize)>,
) {
    for &(id, start, end) in styled_items {
        let Ok(styled_item) = decoder.decode_at_with_id(id, start, end) else {
            if defer_attached_styles {
                // Undecodable now — let the replay try again later, matching
                // the historic defer behaviour.
                deferred_attached_styled_spans.push((start, end));
            }
            continue;
        };
        if styled_item.get_ref(0).is_none() {
            // Orphan styled item (null Item) = a material appearance (#407).
            // Always resolved up front — even in defer mode — or
            // material-only-styled elements render default-gray (#913 §2c).
            if let Some(info) = extract_style_info_from_styled_item(&styled_item, decoder) {
                orphan_styled_items.insert(id, info.color);
            }
        } else if defer_attached_styles {
            deferred_attached_styled_spans.push((start, end));
        } else {
            collect_geometry_style_info(geometry_style_index, &styled_item, decoder);
        }
    }
}


/// [`crate::prepass::flat_styles_rgba8`] with the (dominant) geometry-style
/// source supplied as PRE-MERGED columns instead of a map — the sharded
/// finalize path. `geom_ids` are unique (the host merged shard results
/// first-wins) with `geom_colors` as rgba f32 quads; `resolved` carries the
/// support resolution (indexed colours, materials, element colours) and MUST
/// have an empty `geometry_style_index`. Output is byte-identical to the
/// serial flatten: same precedence (geometry > indexed colour > material >
/// element material), same id-ascending wire order, same rgba8 conversion —
/// without ever building the 4M-entry geometry hashmap.
pub fn flat_styles_rgba8_from_geometry_columns(
    geom_ids: &[u32],
    geom_colors: &[f32],
    resolved: &crate::prepass::ResolvedPrepass,
    decoder: &mut EntityDecoder,
) -> (Vec<u32>, Vec<u8>) {
    debug_assert!(resolved.geometry_style_index.is_empty());
    // Overlay sources in serial precedence order, or_insert among themselves.
    let mut overlay: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
    for (&geometry_id, &color) in &resolved.indexed_colour_index {
        overlay.entry(geometry_id).or_insert(color);
    }
    let material_styles = crate::style::build_material_style_index(
        &resolved.material_def_reprs,
        &resolved.orphan_styled_items,
        decoder,
    );
    for (&mat_id, &color) in crate::style::flatten_material_color_index(&material_styles).iter() {
        overlay.entry(mat_id).or_insert(color);
    }
    for (&element_id, colors) in &resolved.element_material_colors {
        if let Some(&color) = colors.first() {
            overlay.entry(element_id).or_insert(color);
        }
    }

    // Sort both sides by id and merge, geometry winning on ties.
    let mut geom_order: Vec<u32> = (0..geom_ids.len() as u32).collect();
    geom_order.sort_unstable_by_key(|&i| geom_ids[i as usize]);
    let mut overlay_sorted: Vec<(u32, [f32; 4])> = overlay.into_iter().collect();
    overlay_sorted.sort_unstable_by_key(|&(id, _)| id);

    let mut ids: Vec<u32> = Vec::with_capacity(geom_ids.len() + overlay_sorted.len());
    let mut rgba: Vec<u8> = Vec::with_capacity((geom_ids.len() + overlay_sorted.len()) * 4);
    let push = |id: u32, color: [f32; 4], ids: &mut Vec<u32>, rgba: &mut Vec<u8>| {
        ids.push(id);
        rgba.extend_from_slice(&crate::style::Rgba::from_array(color).to_rgba8());
    };
    let mut oi = 0;
    for &gi in &geom_order {
        let id = geom_ids[gi as usize];
        while oi < overlay_sorted.len() && overlay_sorted[oi].0 < id {
            let (oid, oc) = overlay_sorted[oi];
            push(oid, oc, &mut ids, &mut rgba);
            oi += 1;
        }
        if oi < overlay_sorted.len() && overlay_sorted[oi].0 == id {
            oi += 1; // geometry wins the tie, overlay entry dropped
        }
        let c = gi as usize * 4;
        push(
            id,
            [geom_colors[c], geom_colors[c + 1], geom_colors[c + 2], geom_colors[c + 3]],
            &mut ids,
            &mut rgba,
        );
    }
    while oi < overlay_sorted.len() {
        let (oid, oc) = overlay_sorted[oi];
        push(oid, oc, &mut ids, &mut rgba);
        oi += 1;
    }
    (ids, rgba)
}
