// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Per-record prepass classification for the sharded scan (split from
//! `parallel_scan.rs` — the byte-identical shard/stitch protocol lives there;
//! this module owns the class codes and the classified scan variant the
//! browser's sharded pre-pass consumes).

use crate::parallel_scan::ShardRecords;
use ifc_lite_core::EntityScanner;

/// Per-record prepass class emitted by [`scan_shard_classified`].
///
/// Only the codes a downstream consumer needs are defined; everything else is
/// [`PREPASS_CLASS_NONE`]. Classification happens AT SCAN TIME from the same
/// `type_name` string the serial pre-pass matches on, so a consumer that
/// filters records by class reproduces the serial pre-pass's span collection
/// byte-for-byte (same keyword compare, same file order).
pub const PREPASS_CLASS_NONE: u8 = 0;
/// `IFCSTYLEDITEM` — the styled-item spans the pre-pass resolver classifies
/// into orphan (material appearance) vs geometry-attached styles.
pub const PREPASS_CLASS_STYLED_ITEM: u8 = 4;
/// `IFCINDEXEDCOLOURMAP` (#663/#858).
pub const PREPASS_CLASS_INDEXED_COLOUR_MAP: u8 = 5;
/// `IFCMATERIALDEFINITIONREPRESENTATION` (#407).
pub const PREPASS_CLASS_MATERIAL_DEF_REPR: u8 = 6;
/// `IFCRELASSOCIATESMATERIAL` (#407).
pub const PREPASS_CLASS_REL_ASSOCIATES_MATERIAL: u8 = 7;
/// `IFCRELVOIDSELEMENT`.
pub const PREPASS_CLASS_REL_VOIDS: u8 = 8;
/// `IFCRELFILLSELEMENT`.
pub const PREPASS_CLASS_REL_FILLS: u8 = 9;
/// `IFCRELAGGREGATES`.
pub const PREPASS_CLASS_REL_AGGREGATES: u8 = 10;

/// [`scan_shard`] plus a parallel per-record class column (see the
/// `PREPASS_CLASS_*` codes). Same records, same handoff; the class byte lets
/// the browser host extract pre-pass span lists (today: styled items) from the
/// stitched shard columns WITHOUT waiting for the serial pre-pass scan.
pub fn scan_shard_classified(
    content: &[u8],
    range_start: usize,
    range_end: usize,
) -> (ShardRecords, Vec<u8>, Option<usize>) {
    let mut scanner = if range_start == 0 {
        EntityScanner::new(content)
    } else {
        EntityScanner::new_at(content, range_start)
    };
    let mut records = Vec::new();
    let mut classes = Vec::new();
    let mut handoff = None;
    while let Some((id, type_name, start, entity_end)) = scanner.next_entity() {
        if start >= range_end {
            handoff = Some(start);
            break;
        }
        records.push((id, start, entity_end));
        classes.push(match type_name {
            "IFCSTYLEDITEM" => PREPASS_CLASS_STYLED_ITEM,
            "IFCINDEXEDCOLOURMAP" => PREPASS_CLASS_INDEXED_COLOUR_MAP,
            "IFCMATERIALDEFINITIONREPRESENTATION" => PREPASS_CLASS_MATERIAL_DEF_REPR,
            "IFCRELASSOCIATESMATERIAL" => PREPASS_CLASS_REL_ASSOCIATES_MATERIAL,
            "IFCRELVOIDSELEMENT" => PREPASS_CLASS_REL_VOIDS,
            "IFCRELFILLSELEMENT" => PREPASS_CLASS_REL_FILLS,
            "IFCRELAGGREGATES" => PREPASS_CLASS_REL_AGGREGATES,
            _ => PREPASS_CLASS_NONE,
        });
    }
    (records, classes, handoff)
}
