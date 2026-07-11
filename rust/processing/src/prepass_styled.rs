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

