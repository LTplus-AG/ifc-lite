// SPDX-License-Identifier: MPL-2.0
//! GlobalId reconciliation for merged export. Ports the GUID machinery of
//! `merged-exporter.ts`: a deterministic 22-char IfcGloballyUniqueId minter
//! (byte-identical to `@ifc-lite/parser`'s `deterministicGlobalId`), the
//! schema-derived rooted-entity check, and the read/replace helpers used to
//! unify or re-stamp a duplicated GlobalId across federated models.

use std::collections::HashSet;

use crate::rooted_type::is_rooted_type;

/// Deterministic 22-char GlobalId from a seed, byte-identical to
/// `@ifc-lite/parser`'s `deterministicGlobalId`. See [`ifc_lite_core::guid::deterministic`].
pub fn deterministic_global_id(seed: &str) -> String {
    ifc_lite_core::guid::deterministic(seed)
}

/// True for IfcRelationship subtypes (objectified relationships): a shared GUID
/// on two of these does NOT imply the same membership, so they are re-stamped
/// (never unified/dropped) during reconciliation.
pub fn is_relationship_type(type_upper: &str) -> bool {
    type_upper.starts_with("IFCREL")
}

/// True when `type_upper` is a **rooted** entity (an `IfcRoot` subtype). Delegates
/// to the crate's shared, schema-driven [`crate::rooted_type::is_rooted_type`],
/// which decides rootedness from the EXPRESS inheritance graph (plus the legacy
/// IFC2X3/IFC4 rooted set for types the IFC4X3-only generated schema dropped)
/// rather than a hand-maintained denylist — so a non-rooted resource that happens
/// to lead with a 22-char Name/Identifier string (`IfcColourRgb`,
/// `IfcMaterialLayer`, `IfcRegularTimeSeries`, an `IfcSimpleProperty`) is never
/// misread as carrying a GlobalId. A single source of truth shared with the JS
/// exporter's `isRootedType` and cross-language parity-gated (#3015/#3124), so the
/// two sides cannot drift.
pub fn is_rooted_entity_type(type_upper: &str) -> bool {
    is_rooted_type(type_upper)
}

/// The leading 22-char GlobalId of a rooted entity's raw STEP line, or `None` if
/// the type is not rooted or the first attribute is not a GlobalId string.
/// Only inspects the first 128 bytes (a GlobalId is always the first attribute).
pub fn extract_global_id_fast(type_upper: &str, line: &[u8]) -> Option<String> {
    if !is_rooted_entity_type(type_upper) {
        return None;
    }
    ifc_lite_core::guid::leading_global_id(line).map(str::to_string)
}

/// The uppercase entity type token of a `#id=TYPE(...)` line, tolerating
/// whitespace after `=` (some exporters write `#1= IFCPROJECT(`).
pub fn entity_type_upper(line: &[u8]) -> Option<String> {
    let eq = line.iter().position(|&b| b == b'=')?;
    let mut i = eq + 1;
    while i < line.len() && line[i].is_ascii_whitespace() {
        i += 1;
    }
    let start = i;
    while i < line.len() && line[i] != b'(' && !line[i].is_ascii_whitespace() {
        i += 1;
    }
    if i == start {
        return None;
    }
    std::str::from_utf8(&line[start..i]).ok().map(|s| s.to_ascii_uppercase())
}

/// The leading GlobalId of a raw STEP entity line, classified by TYPE (not just
/// the 22-char shape): reads the type from the line and applies the rooted-entity
/// rule, so a non-rooted entity leading with a 22-char charset Name (e.g. an
/// `IfcColourRgb`) is not counted as a rooted GlobalId. For callers that only
/// have raw text — the merge harness and duplicate-GlobalId diagnostics — and
/// want the same classification the merge itself uses.
pub fn leading_rooted_global_id(line: &[u8]) -> Option<String> {
    let type_upper = entity_type_upper(line)?;
    extract_global_id_fast(&type_upper, line)
}

/// Read the GlobalId of an already-rendered STEP line. Used to register the
/// *actually emitted* GUID after remap / re-stamp / schema conversion. Returns
/// `None` when the first string is not a GlobalId (safe — the caller then falls
/// back to the known local GUID). Same scan as [`extract_global_id_fast`].
pub fn read_leading_guid(text: &str) -> Option<String> {
    ifc_lite_core::guid::leading_global_id(text.as_bytes()).map(str::to_string)
}

/// Rewrite the leading GlobalId field of a STEP line with `new_guid`. Returns
/// the input unchanged if the line has no valid leading GlobalId.
pub fn replace_global_id(text: &str, new_guid: &str) -> String {
    ifc_lite_core::guid::replace_leading_global_id(text, new_guid)
}

/// Mints deterministic replacement GlobalIds that avoid collisions with both the
/// GUIDs already emitted into the merge and the ones minted so far. Seeded from
/// the source GUID + stable model id so the result is reproducible and does not
/// churn when an unrelated earlier model changes size.
#[derive(Default)]
pub struct GuidMinter {
    pending: HashSet<String>,
}

impl GuidMinter {
    pub fn new() -> Self {
        Self::default()
    }

    /// A fresh GlobalId for `original` (seeded by `model_id`), guaranteed not to
    /// collide with anything in `emitted`, in `also` (e.g. the current model's own
    /// unchanged GlobalIds, which are not yet in `emitted`), or previously minted here.
    pub fn mint(
        &mut self,
        original: &str,
        model_id: &str,
        emitted: &HashSet<String>,
        also: &HashSet<String>,
    ) -> String {
        let mut candidate = deterministic_global_id(&format!("{original}#{model_id}"));
        let mut n: u32 = 0;
        while emitted.contains(&candidate)
            || also.contains(&candidate)
            || self.pending.contains(&candidate)
        {
            candidate = deterministic_global_id(&format!("{original}#{model_id}#{n}"));
            n = n.wrapping_add(1);
        }
        self.pending.insert(candidate.clone());
        candidate
    }
}

#[cfg(test)]
#[path = "guid_tests.rs"]
mod guid_tests;
