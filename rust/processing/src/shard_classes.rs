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
/// `IFCPROJECT`.
pub const PREPASS_CLASS_PROJECT: u8 = 2;
/// `IFCSITE` (also a geometry job — the pre-pass buffers it like one).
pub const PREPASS_CLASS_SITE: u8 = 3;
/// `IFCMATERIALLAYERSET` / `IFCMATERIALLAYERSETUSAGE` (arms the layer index).
pub const PREPASS_CLASS_MATERIAL_LAYER_SET: u8 = 13;
/// FLAG bit: geometry-bearing entity (`has_geometry_by_name`) — a pre-pass
/// geometry job. Composes with the named codes' nibble range (2..=13) and
/// with [`PREPASS_CLASS_FLAG_TYPE_CANDIDATE`].
pub const PREPASS_CLASS_FLAG_GEOMETRY_JOB: u8 = 0x80;
/// FLAG bit: `IfcTypeProduct` subtype candidate (name ends TYPE/STYLE) for the
/// #957 orphan type-geometry pass.
pub const PREPASS_CLASS_FLAG_TYPE_CANDIDATE: u8 = 0x40;
/// `IFCMAPPEDITEM` (#957/#1623 repmap plans).
pub const PREPASS_CLASS_MAPPED_ITEM: u8 = 11;
/// `IFCRELDEFINESBYTYPE` (#957 instantiated-type ids).
pub const PREPASS_CLASS_REL_DEFINES_BY_TYPE: u8 = 12;
/// Mask extracting the named-arm code from a class byte (drops the flag bits).
pub const PREPASS_CLASS_CODE_MASK: u8 = 0x3F;

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
        classes.push(classify_type_name(type_name));
    }
    (records, classes, handoff)
}

/// Classify a scanned STEP keyword into the prepass class byte: a named-arm
/// code for the exact keywords the serial pre-pass matches, plus the
/// geometry-job / type-candidate FLAG bits from the same helpers it calls
/// (`has_geometry_by_name`, `IfcType::is_subtype_of`). Byte-identical span
/// collection and job discovery follow from using the identical predicates at
/// scan time.
pub fn classify_type_name(type_name: &str) -> u8 {
    use ifc_lite_core::{has_geometry_by_name, IfcType};
    let named = match type_name {
        "IFCPROJECT" => PREPASS_CLASS_PROJECT,
        "IFCSITE" => return PREPASS_CLASS_SITE, // site is job + site-record; flags implied
        "IFCSTYLEDITEM" => PREPASS_CLASS_STYLED_ITEM,
        "IFCINDEXEDCOLOURMAP" => PREPASS_CLASS_INDEXED_COLOUR_MAP,
        "IFCMATERIALDEFINITIONREPRESENTATION" => PREPASS_CLASS_MATERIAL_DEF_REPR,
        "IFCRELASSOCIATESMATERIAL" => PREPASS_CLASS_REL_ASSOCIATES_MATERIAL,
        "IFCRELVOIDSELEMENT" => PREPASS_CLASS_REL_VOIDS,
        "IFCRELFILLSELEMENT" => PREPASS_CLASS_REL_FILLS,
        "IFCRELAGGREGATES" => PREPASS_CLASS_REL_AGGREGATES,
        "IFCMAPPEDITEM" => PREPASS_CLASS_MAPPED_ITEM,
        "IFCRELDEFINESBYTYPE" => PREPASS_CLASS_REL_DEFINES_BY_TYPE,
        "IFCMATERIALLAYERSET" | "IFCMATERIALLAYERSETUSAGE" => PREPASS_CLASS_MATERIAL_LAYER_SET,
        _ => PREPASS_CLASS_NONE,
    };
    if named != PREPASS_CLASS_NONE {
        // The named keywords are mutually exclusive with the flag predicates in
        // the serial match (its arms return before the `_` arm runs them).
        return named;
    }
    let mut class = PREPASS_CLASS_NONE;
    if type_name.ends_with("TYPE") || type_name.ends_with("STYLE") {
        let ty = IfcType::from_str(type_name);
        if ty.is_subtype_of(IfcType::IfcTypeProduct) {
            class |= PREPASS_CLASS_FLAG_TYPE_CANDIDATE;
        }
    }
    if has_geometry_by_name(type_name) {
        class |= PREPASS_CLASS_FLAG_GEOMETRY_JOB;
    }
    class
}
