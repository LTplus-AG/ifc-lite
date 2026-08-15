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
        classes.push(classify_type_name_with_content(
            type_name,
            &content[start..entity_end],
        ));
    }
    (records, classes, handoff)
}

/// [`classify_type_name`] plus the #1910 instance-level exception: a spatial
/// container `has_geometry_by_name` blocks by name (`IfcBuilding` et al.) is
/// still classified as a geometry job when THIS instance's `Representation`
/// attribute (index 6) is exceptionally non-null -- mirrors the identical
/// exception applied to the serial scan loop
/// (`rust/wasm-bindings/src/api/gpu_meshes/prepass.rs`) and the streaming
/// processor (`rust/processing/src/processor/mod.rs`), so all three
/// discovery paths agree on what counts as geometry. `entity_bytes` is the
/// full `#id=KEYWORD(...)` span for this record.
pub fn classify_type_name_with_content(type_name: &str, entity_bytes: &[u8]) -> u8 {
    let mut class = classify_type_name(type_name);
    if class & PREPASS_CLASS_FLAG_GEOMETRY_JOB == 0
        && ifc_lite_core::is_representationless_spatial_container_by_name(type_name)
        && ifc_lite_core::nth_attribute_is_present(entity_bytes, 6)
    {
        class |= PREPASS_CLASS_FLAG_GEOMETRY_JOB;
    }
    class
}

/// Classify a scanned STEP keyword into the prepass class byte: a named-arm
/// code for the exact keywords the serial pre-pass matches, plus the
/// geometry-job / type-candidate FLAG bits from the same helpers it calls
/// (`has_geometry_by_name`, `IfcType::is_subtype_of`). Byte-identical span
/// collection and job discovery follow from using the identical predicates at
/// scan time.
///
/// Deliberately name-only (cannot see the entity bytes) -- the #1910
/// instance-level exception lives one layer up, in
/// [`classify_type_name_with_content`], which is what [`scan_shard_classified`]
/// actually calls. Kept as a separate function (rather than inlining) so
/// every other named/flag arm here stays byte-identical to what it was
/// before #1910 -- the only new code path is the explicit OR-in above.
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The type-candidate check ORs two independent suffix tests
    /// (`ends_with("TYPE")` and `ends_with("STYLE")`) before confirming the
    /// resolved `IfcType` is a subtype of `IfcTypeProduct`. Pin that the TYPE
    /// arm alone is load-bearing: `IFCWALLTYPE` (a real `IfcTypeProduct`
    /// subtype) must set the flag even though it does NOT end in "STYLE", so a
    /// mutation that drops the `ends_with("TYPE")` disjunct and keeps only the
    /// STYLE check would misclassify it and lose #957's orphan type-geometry
    /// pass for every walltype-shaped keyword.
    #[test]
    fn type_suffix_sets_type_candidate_flag() {
        let class = classify_type_name("IFCWALLTYPE");
        assert_eq!(
            class & PREPASS_CLASS_FLAG_TYPE_CANDIDATE,
            PREPASS_CLASS_FLAG_TYPE_CANDIDATE,
            "IFCWALLTYPE is an IfcTypeProduct subtype ending in TYPE, not STYLE — \
             it must set the type-candidate flag via the TYPE arm alone"
        );
    }

    /// The STYLE arm is deliberately distinct from the TYPE arm: a keyword
    /// ending in "STYLE" that is NOT an `IfcTypeProduct` subtype (`IFCSURFACESTYLE`
    /// is an `IfcPresentationStyle`) must NOT set the flag. Combined with
    /// `type_suffix_sets_type_candidate_flag` above, this pins that the two
    /// suffix checks gate genuinely different keyword sets rather than one
    /// subsuming the other.
    #[test]
    fn style_suffix_without_type_product_subtype_does_not_set_flag() {
        let class = classify_type_name("IFCSURFACESTYLE");
        assert_eq!(
            class & PREPASS_CLASS_FLAG_TYPE_CANDIDATE,
            0,
            "IFCSURFACESTYLE is not an IfcTypeProduct subtype, so the type-candidate \
             flag must stay clear even though the name ends in STYLE"
        );
    }

    /// Pins every named-arm keyword to its own distinct class code. The two
    /// tests above cover only the TYPE/STYLE suffix flag; nothing asserted
    /// the named-arm lookup table itself, so this is a textbook lookup-table
    /// vacuity: any two of the 12 named arms could be swapped
    /// (e.g. `IFCRELVOIDSELEMENT` ↔ `IFCRELFILLSELEMENT`) and the full suite
    /// stayed green. A wrong class here means the sharded pre-pass hands the
    /// browser host the wrong span list for a record (voids treated as
    /// fills, materials treated as aggregates, etc.), silently diverging
    /// from the serial pre-pass it must reproduce byte-for-byte.
    #[test]
    fn classify_type_name_pins_every_named_arm_to_a_distinct_code() {
        let cases = [
            ("IFCPROJECT", PREPASS_CLASS_PROJECT),
            ("IFCSITE", PREPASS_CLASS_SITE),
            ("IFCSTYLEDITEM", PREPASS_CLASS_STYLED_ITEM),
            ("IFCINDEXEDCOLOURMAP", PREPASS_CLASS_INDEXED_COLOUR_MAP),
            ("IFCMATERIALDEFINITIONREPRESENTATION", PREPASS_CLASS_MATERIAL_DEF_REPR),
            ("IFCRELASSOCIATESMATERIAL", PREPASS_CLASS_REL_ASSOCIATES_MATERIAL),
            ("IFCRELVOIDSELEMENT", PREPASS_CLASS_REL_VOIDS),
            ("IFCRELFILLSELEMENT", PREPASS_CLASS_REL_FILLS),
            ("IFCRELAGGREGATES", PREPASS_CLASS_REL_AGGREGATES),
            ("IFCMAPPEDITEM", PREPASS_CLASS_MAPPED_ITEM),
            ("IFCRELDEFINESBYTYPE", PREPASS_CLASS_REL_DEFINES_BY_TYPE),
            ("IFCMATERIALLAYERSET", PREPASS_CLASS_MATERIAL_LAYER_SET),
            ("IFCMATERIALLAYERSETUSAGE", PREPASS_CLASS_MATERIAL_LAYER_SET),
        ];
        for (keyword, expected) in cases {
            assert_eq!(
                classify_type_name(keyword),
                expected,
                "{keyword} classified as {} not {expected}",
                classify_type_name(keyword)
            );
        }

        // Golden totals: every expected code above (except the two that
        // intentionally share MATERIAL_LAYER_SET) is pairwise distinct, so a
        // swap between any two arms is caught by the per-case assertion —
        // not just an aggregate that a swap could still satisfy.
        let distinct_codes: std::collections::HashSet<u8> =
            cases.iter().map(|(_, c)| *c).collect();
        assert_eq!(distinct_codes.len(), 12, "expected 12 distinct codes across 13 keywords (2 share MATERIAL_LAYER_SET)");

        // An unrecognised keyword with no geometry/type-candidate signal is NONE.
        assert_eq!(classify_type_name("IFCUNKNOWNTHING"), PREPASS_CLASS_NONE);
    }
}
