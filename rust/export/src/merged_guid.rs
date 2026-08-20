// SPDX-License-Identifier: MPL-2.0
//! GlobalId identification and re-stamping for the merged/federated STEP
//! exporter (`merged.rs`). Split out from `merged.rs` along the seam
//! `merged.rs` itself already documents: identifying an entity's GlobalId
//! and minting a fresh one on collision is a self-contained concern,
//! independent of the emission loop (offsetting, visibility filtering,
//! relationship narrowing) that calls it.

use ifc_lite_core::IfcType;
use std::collections::HashSet;

pub(crate) const GLOBAL_ID_CHARS: &[u8; 64] =
    b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

/// True for a 22-character token drawn entirely from the buildingSMART
/// GlobalId alphabet -- mirrors `GLOBAL_ID_RE` in `merged-exporter.ts`.
fn is_global_id_shaped(s: &str) -> bool {
    s.len() == 22 && s.bytes().all(|b| GLOBAL_ID_CHARS.contains(&b))
}

/// Read the entity's **first attribute** (the GlobalId position for an
/// `IfcRoot` subtype), if it is 22-char GlobalId-shaped and the entity's
/// type actually derives from `IfcRoot`.
///
/// Two things distinguish this from a plain "first quoted string on the
/// line" scan, and both matter: (1) the quote must be the FIRST thing after
/// `(` (only whitespace allowed in between) -- a non-rooted entity whose
/// first attribute is a number/enum/reference and whose Name/Identifier
/// happens to be a 22-char quoted string LATER on the line must not be
/// mistaken for a rooted entity's GlobalId; (2) `type_name` is checked
/// against the generated schema's `IfcRoot` subtype table via
/// [`IfcType::is_subtype_of`] (plus [`is_legacy_rooted_type`] for the
/// handful of IFC2X3/IFC4-only rooted types that table doesn't know, since
/// it's generated from IFC4X3 alone) rather than an entity-type denylist -- a
/// denylist can only ever be as complete as whoever last audited the
/// schema for non-rooted resource types that lead with a string, while this
/// positive allowlist is derived from the schema itself and can't drift out
/// of sync with it. Mirrors `extractGlobalIdFast` in
/// `packages/export/src/merged-exporter.ts`, which is likewise positional
/// (skips only whitespace after `(`) though it still uses the denylist —
/// `rust-core`'s generated schema has no JS-side equivalent to allowlist
/// from.
///
/// Works off raw bytes the same way `rewrite_refs` does (a GlobalId's
/// charset excludes `'`, so a naive first-quote-pair scan of the attribute
/// content is safe -- it never needs the doubled-apostrophe in/out-of-string
/// toggle `rewrite_refs` uses for arbitrary string content).
pub(crate) fn leading_guid(line: &[u8], type_name: &str) -> Option<String> {
    let ifc_type = IfcType::from_str(type_name);
    let rooted = ifc_type.is_subtype_of(IfcType::IfcRoot)
        || (matches!(ifc_type, IfcType::Unknown(_))
            && is_legacy_rooted_type(&type_name.to_ascii_uppercase()));
    if !rooted {
        return None;
    }
    let open = line.iter().position(|&b| b == b'(')?;
    let mut i = open + 1;
    while i < line.len() && line[i].is_ascii_whitespace() {
        i += 1;
    }
    if line.get(i) != Some(&b'\'') {
        return None;
    }
    let after_q1 = &line[i + 1..];
    let q2 = after_q1.iter().position(|&b| b == b'\'')?;
    let raw = &after_q1[..q2];
    let s = std::str::from_utf8(raw).ok()?;
    is_global_id_shaped(s).then(|| s.to_string())
}

/// Rooted entity types that exist in IFC2X3 and/or IFC4 but were dropped or
/// renamed by IFC4X3 -- the only schema `rust-core`'s generated `IfcType`
/// table is derived from (`rust/core/src/generated/schema.rs`). For these,
/// `IfcType::from_str` resolves to `Unknown`, which `is_subtype_of(IfcRoot)`
/// correctly refuses -- an *unrecognised* type must never be assumed rooted,
/// that is the exact corruption this file's type check exists to prevent.
/// This closes the resulting gap for the entities that genuinely ARE rooted
/// in the older schemas real IFC2X3/IFC4 files still use, so their GlobalIds
/// keep getting deduplicated across a merge instead of silently duplicating.
///
/// Derived by diffing `@ifc-lite/data`'s IFC2X3/IFC4/IFC4X3 entity tables
/// (`packages/data/src/ifc-schema/generated/entities-*.ts`) against this
/// crate's IFC4X3-only schema and keeping only the entries whose parent
/// chain in the older schema reaches `IfcRoot`. Update by re-running that
/// diff, not by ad hoc inspection.
fn is_legacy_rooted_type(upper: &str) -> bool {
    matches!(
        upper,
        "IFCBEAMSTANDARDCASE" | "IFCBUILDINGELEMENT" | "IFCBUILDINGELEMENTCOMPONENT"
        | "IFCBUILDINGELEMENTTYPE" | "IFCCHAMFEREDGEFEATURE" | "IFCCOLUMNSTANDARDCASE"
        | "IFCCONDITION" | "IFCCONDITIONCRITERION" | "IFCDOORSTANDARDCASE" | "IFCDOORSTYLE"
        | "IFCEDGEFEATURE" | "IFCELECTRICDISTRIBUTIONPOINT" | "IFCELECTRICHEATERTYPE"
        | "IFCELECTRICALBASEPROPERTIES" | "IFCELECTRICALCIRCUIT" | "IFCELECTRICALELEMENT"
        | "IFCENERGYPROPERTIES" | "IFCEQUIPMENTELEMENT" | "IFCEQUIPMENTSTANDARD"
        | "IFCFLUIDFLOWPROPERTIES" | "IFCFURNITURESTANDARD" | "IFCGASTERMINALTYPE"
        | "IFCMEMBERSTANDARDCASE" | "IFCMOVE" | "IFCOPENINGSTANDARDCASE" | "IFCORDERACTION"
        | "IFCPLATESTANDARDCASE" | "IFCPROJECTORDERRECORD" | "IFCPROXY" | "IFCRELASSIGNSTASKS"
        | "IFCRELASSIGNSTOPROJECTORDER" | "IFCRELASSOCIATESAPPLIEDVALUE"
        | "IFCRELASSOCIATESPROFILEPROPERTIES" | "IFCRELCONNECTSSTRUCTURALELEMENT"
        | "IFCRELINTERACTIONREQUIREMENTS" | "IFCRELOCCUPIESSPACES" | "IFCRELOVERRIDESPROPERTIES"
        | "IFCRELSCHEDULESCOSTITEMS" | "IFCROUNDEDEDGEFEATURE" | "IFCSCHEDULETIMECONTROL"
        | "IFCSERVICELIFE" | "IFCSERVICELIFEFACTOR" | "IFCSLABELEMENTEDCASE"
        | "IFCSLABSTANDARDCASE" | "IFCSOUNDPROPERTIES" | "IFCSOUNDVALUE" | "IFCSPACEPROGRAM"
        | "IFCSPACETHERMALLOADPROPERTIES" | "IFCSTRUCTURALLINEARACTIONVARYING"
        | "IFCSTRUCTURALPLANARACTIONVARYING" | "IFCTIMESERIESSCHEDULE" | "IFCWALLELEMENTEDCASE"
        | "IFCWINDOWSTANDARDCASE" | "IFCWINDOWSTYLE"
    )
}

/// Replace a line's first quoted attribute (the GlobalId) with `new_guid`.
/// `new_guid` is always 22 charset characters (no quote in that charset), so
/// a straightforward byte replace between the first two apostrophes after
/// `(` is safe -- same shape as `replaceGlobalId` in `merged-exporter.ts`.
pub(crate) fn replace_leading_guid(line: &str, new_guid: &str) -> String {
    let open = match line.find('(') {
        Some(i) => i,
        None => return line.to_string(),
    };
    let rest = &line[open + 1..];
    let q1 = match rest.find('\'') {
        Some(i) => i,
        None => return line.to_string(),
    };
    let after_q1 = &rest[q1 + 1..];
    let q2 = match after_q1.find('\'') {
        Some(i) => i,
        None => return line.to_string(),
    };
    let abs_q1 = open + 1 + q1;
    let abs_q2 = open + 1 + q1 + 1 + q2;
    format!("{}{}{}", &line[..abs_q1 + 1], new_guid, &line[abs_q2..])
}

/// Deterministic 22-char GlobalId from an arbitrary seed. Byte-for-byte port
/// of `deterministicGlobalId` in `packages/parser/src/deterministic-global-id.ts`
/// (cross-checked against that implementation for identical seeds) -- four
/// independent 32-bit rolling hashes, cross-mixed, then stamped MSB-first as
/// a standard IFC GlobalId. Byte-for-byte identity with the JS path's minted
/// ids is not required (the two exporters mint independently, never for the
/// same collision), but porting the well-specified, already-hardened
/// algorithm avoids re-deriving a weaker one from scratch.
fn deterministic_global_id(seed: &str) -> String {
    let mut h0: u32 = 0x811c_9dc5;
    let mut h1: u32 = 0x9e37_79b9;
    let mut h2: u32 = 0x6c07_8965;
    let mut h3: u32 = 0xb529_7a4d;
    for u in seed.encode_utf16() {
        let c = u as u32;
        h0 = (h0 ^ c).wrapping_mul(0x0100_0193);
        h1 = (h1 ^ c ^ (h1 >> 11)).wrapping_mul(0x85eb_ca6b);
        h2 = h2.wrapping_add(c).wrapping_add(h2 >> 7).wrapping_mul(0xc2b2_ae35);
        h3 = (h3 ^ ((c << 3) | (c >> 5)) ^ (h3 >> 13)).wrapping_mul(0x27d4_eb2f);
    }
    let mix = |x: u32, y: u32| -> u32 {
        ((x ^ y).wrapping_add((x >> 7) | (y << 25))).wrapping_mul(0x85eb_ca6b)
    };
    let m0 = mix(h0, h2);
    let m1 = mix(h1, h3);
    let m2 = mix(h2, m1);
    let m3 = mix(h3, m0);

    let mut bits: Vec<u8> = Vec::with_capacity(128);
    for word in [m0, m1, m2, m3] {
        for b in (0..32).rev() {
            bits.push(((word >> b) & 1) as u8);
        }
    }
    let mut out = String::with_capacity(22);
    out.push(GLOBAL_ID_CHARS[((bits[0] << 1) | bits[1]) as usize] as char);
    for i in 0..21usize {
        let mut v: usize = 0;
        for b in 0..6usize {
            v = (v << 1) | bits[2 + i * 6 + b] as usize;
        }
        out.push(GLOBAL_ID_CHARS[v] as char);
    }
    out
}

/// Mint a fresh, deterministic, collision-free GlobalId for an entity whose
/// GlobalId collides with one already emitted. Seeded from the original
/// GlobalId and the source model's index so the output is reproducible.
/// Mirrors `mintUniqueGuid` in `merged-exporter.ts`.
pub(crate) fn mint_unique_guid(
    original: &str,
    model_index: usize,
    emitted: &HashSet<String>,
    pending: &mut HashSet<String>,
) -> String {
    let mut n = 0u32;
    let mut candidate = deterministic_global_id(&format!("{original}#{model_index}"));
    while emitted.contains(&candidate) || pending.contains(&candidate) {
        candidate = deterministic_global_id(&format!("{original}#{model_index}#{n}"));
        n += 1;
    }
    pending.insert(candidate.clone());
    candidate
}
