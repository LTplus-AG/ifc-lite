// SPDX-License-Identifier: MPL-2.0
//! GlobalId reconciliation for merged export. Ports the GUID machinery of
//! `merged-exporter.ts`: a deterministic 22-char IfcGloballyUniqueId minter
//! (byte-identical to `@ifc-lite/parser`'s `deterministicGlobalId`), the
//! schema-derived rooted-entity check, and the read/replace helpers used to
//! unify or re-stamp a duplicated GlobalId across federated models.

use std::collections::HashSet;

use crate::rooted_type::is_rooted_type;

/// buildingSMART base64 alphabet (64 chars) used by IfcGloballyUniqueId.
const GLOBAL_ID_CHARS: &[u8; 64] =
    b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

/// Deterministic 22-char GlobalId from an arbitrary seed. A faithful port of
/// `@ifc-lite/parser`'s `deterministicGlobalId` (four independent 32-bit rolling
/// hashes cross-mixed into a 128-bit state, stamped MSB-first as `2 + 21*6` bits)
/// so a merged file re-stamped natively carries the same ids the JS path would.
///
/// The input is iterated as UTF-16 code units to match JavaScript's `charCodeAt`
/// semantics exactly (seeds are ASCII in practice, but this keeps parity if a
/// non-ASCII model id ever reaches the mint salt).
pub fn deterministic_global_id(seed: &str) -> String {
    let mut h0: u32 = 0x811c_9dc5;
    let mut h1: u32 = 0x9e37_79b9;
    let mut h2: u32 = 0x6c07_8965;
    let mut h3: u32 = 0xb529_7a4d;
    for unit in seed.encode_utf16() {
        let c = unit as u32;
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
    let words = [m0, m1, m2, m3];

    // Read the 128-bit state as a plain MSB-first bit string.
    let bit = |idx: usize| -> u32 {
        let word = words[idx / 32];
        let shift = 31 - (idx % 32);
        (word >> shift) & 1
    };
    let mut out = String::with_capacity(22);
    out.push(GLOBAL_ID_CHARS[((bit(0) << 1) | bit(1)) as usize] as char);
    for i in 0..21 {
        let mut v = 0u32;
        for b in 0..6 {
            v = (v << 1) | bit(2 + i * 6 + b);
        }
        out.push(GLOBAL_ID_CHARS[v as usize] as char);
    }
    out
}

/// True for a 22-char IfcGloballyUniqueId (`^[0-9A-Za-z_$]{22}$`).
pub fn is_global_id(s: &str) -> bool {
    s.len() == 22
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'$')
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
    let window = &line[..line.len().min(128)];
    let open = window.iter().position(|&b| b == b'(')?;
    let mut i = open + 1;
    while i < window.len() && window[i].is_ascii_whitespace() {
        i += 1;
    }
    if i >= window.len() || window[i] != b'\'' {
        return None;
    }
    let start = i + 1;
    let close = window[start..].iter().position(|&b| b == b'\'')? + start;
    let inner = std::str::from_utf8(&window[start..close]).ok()?;
    is_global_id(inner).then(|| inner.to_string())
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

/// Read the GlobalId of an already-rendered STEP line (first `'…'` after the
/// first `(`). Used to register the *actually emitted* GUID after remap /
/// re-stamp / schema conversion. Returns `None` when the first string is not a
/// GlobalId (safe — the caller then falls back to the known local GUID).
pub fn read_leading_guid(text: &str) -> Option<String> {
    let b = text.as_bytes();
    let open = b.iter().position(|&c| c == b'(')?;
    let q1 = b[open..].iter().position(|&c| c == b'\'')? + open;
    let q2 = b[q1 + 1..].iter().position(|&c| c == b'\'')? + q1 + 1;
    let inner = &text[q1 + 1..q2];
    is_global_id(inner).then(|| inner.to_string())
}

/// Rewrite the leading 22-char GlobalId field of a STEP line with `new_guid`.
/// Safe because the GUID charset excludes the apostrophe, so the first `'…'`
/// after `(` is exactly the GlobalId slot. Returns the input unchanged if no
/// quoted first attribute is found.
pub fn replace_global_id(text: &str, new_guid: &str) -> String {
    let b = text.as_bytes();
    let Some(open) = b.iter().position(|&c| c == b'(') else {
        return text.to_string();
    };
    let Some(q1rel) = b[open..].iter().position(|&c| c == b'\'') else {
        return text.to_string();
    };
    let q1 = open + q1rel;
    let Some(q2rel) = b[q1 + 1..].iter().position(|&c| c == b'\'') else {
        return text.to_string();
    };
    let q2 = q1 + 1 + q2rel;
    let mut out = String::with_capacity(text.len() + new_guid.len());
    out.push_str(&text[..q1 + 1]);
    out.push_str(new_guid);
    out.push_str(&text[q2..]);
    out
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
