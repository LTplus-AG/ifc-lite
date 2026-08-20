// SPDX-License-Identifier: MPL-2.0
//! **Merged** multi-model STEP exporter. Ports the core of `merged-exporter.ts`:
//! combine several IFC files into one by ID-offsetting each subsequent model and
//! rewriting every `#`-reference. The first model keeps its ids; each later model is
//! shifted past the running maximum.
//!
//! P1 unifies the **project**: subsequent models' `IfcProject` lines are dropped and any
//! reference to them is redirected to the first model's project, so the result is a single
//! valid `IfcProject` tree. Deeper shared-infrastructure dedup (units, contexts) and
//! spatial unification by name/elevation are the P2 follow-on.

use crate::merged_visibility::{compute_keep_set, narrow_for_emission, VisibilityFilter};
use crate::step_text::{detect_schema, escape};
use ifc_lite_core::EntityScanner;
use std::collections::HashSet;

/// Non-`IfcRoot` entity types whose first attribute is (or can be) a quoted
/// Name/Identifier string that could coincidentally be 22 charset characters
/// long. Ported from `NON_ROOTED_STRING_TYPES` in
/// `packages/export/src/merged-exporter.ts` (kept in sync there) -- without
/// this denylist, GlobalId reconciliation could mistake a `Name`/`Identifier`
/// for a GlobalId and corrupt it by "reconciling" a coincidental collision.
/// A miss in the other direction (treating a real root as non-rooted) only
/// skips one reconciliation, which is safe.
const NON_ROOTED_STRING_TYPES: &[&str] = &[
    // IfcSimpleProperty / IfcComplexProperty (IfcPropertyAbstraction — not rooted)
    "IFCPROPERTYSINGLEVALUE", "IFCPROPERTYENUMERATEDVALUE", "IFCPROPERTYLISTVALUE",
    "IFCPROPERTYBOUNDEDVALUE", "IFCPROPERTYTABLEVALUE", "IFCPROPERTYREFERENCEVALUE",
    "IFCCOMPLEXPROPERTY",
    // IfcPhysicalQuantity (not rooted)
    "IFCQUANTITYLENGTH", "IFCQUANTITYAREA", "IFCQUANTITYVOLUME", "IFCQUANTITYCOUNT",
    "IFCQUANTITYWEIGHT", "IFCQUANTITYTIME", "IFCQUANTITYNUMBER", "IFCPHYSICALCOMPLEXQUANTITY",
    // Materials & their constituents (IfcMaterialDefinition — not rooted; lead with a Name)
    "IFCMATERIAL", "IFCMATERIALPROFILE", "IFCMATERIALPROFILESET",
    "IFCMATERIALCONSTITUENT", "IFCMATERIALCONSTITUENTSET",
    // Classification, library & document refs (IfcExternalInformation/Reference)
    "IFCCLASSIFICATION", "IFCCLASSIFICATIONREFERENCE",
    "IFCLIBRARYINFORMATION", "IFCLIBRARYREFERENCE", "IFCEXTERNALREFERENCE",
    "IFCDOCUMENTINFORMATION", "IFCDOCUMENTREFERENCE",
    // Constraints & approvals (lead with a Name/Identifier)
    "IFCMETRIC", "IFCOBJECTIVE", "IFCAPPROVAL", "IFCTABLE",
    // Actors (IfcPerson/IfcOrganization lead with an Identification string)
    "IFCPERSON", "IFCORGANIZATION",
    // Presentation layers, styles & text literals (lead with a Name/Literal string)
    "IFCPRESENTATIONLAYERASSIGNMENT", "IFCPRESENTATIONLAYERWITHSTYLE",
    "IFCSURFACESTYLE", "IFCCURVESTYLE", "IFCTEXTSTYLE", "IFCFILLAREASTYLE",
    "IFCTEXTLITERAL", "IFCTEXTLITERALWITHEXTENT",
];

const GLOBAL_ID_CHARS: &[u8; 64] =
    b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

/// True for a 22-character token drawn entirely from the buildingSMART
/// GlobalId alphabet -- mirrors `GLOBAL_ID_RE` in `merged-exporter.ts`.
fn is_global_id_shaped(s: &str) -> bool {
    s.len() == 22 && s.bytes().all(|b| GLOBAL_ID_CHARS.contains(&b))
}

/// Read the first quoted attribute of a STEP entity line (the GlobalId
/// position for an `IfcRoot` subtype), if it is 22-char GlobalId-shaped and
/// the entity's type is not in the non-rooted denylist above. Mirrors
/// `extractGlobalIdFast`/`readLeadingGuid` in `merged-exporter.ts`, working
/// off raw bytes the same way `rewrite_refs` does (a GlobalId's charset
/// excludes `'`, so a naive first-quote-pair scan is safe -- it never needs
/// the doubled-apostrophe in/out-of-string toggle `rewrite_refs` uses for
/// arbitrary string content).
fn leading_guid(line: &[u8], type_name: &str) -> Option<String> {
    if NON_ROOTED_STRING_TYPES.contains(&type_name) {
        return None;
    }
    let open = line.iter().position(|&b| b == b'(')?;
    let rest = &line[open + 1..];
    let q1 = rest.iter().position(|&b| b == b'\'')?;
    let after_q1 = &rest[q1 + 1..];
    let q2 = after_q1.iter().position(|&b| b == b'\'')?;
    let raw = &after_q1[..q2];
    let s = std::str::from_utf8(raw).ok()?;
    is_global_id_shaped(s).then(|| s.to_string())
}

/// Replace a line's first quoted attribute (the GlobalId) with `new_guid`.
/// `new_guid` is always 22 charset characters (no quote in that charset), so
/// a straightforward byte replace between the first two apostrophes after
/// `(` is safe -- same shape as `replaceGlobalId` in `merged-exporter.ts`.
fn replace_leading_guid(line: &str, new_guid: &str) -> String {
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
fn mint_unique_guid(
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

/// Options for merged export.
pub struct MergedOptions {
    pub schema: Option<String>,
    pub description: String,
    pub application: String,
    /// Per-model visibility filter, index-aligned with the `models` slice
    /// passed to [`export_merged_with_stats`]. `None` (the whole field) ⇒ no
    /// filtering: every model is included in full, unchanged from before
    /// this option existed.
    ///
    /// `Some(per_model)` may be shorter than `models`; a missing or `None`
    /// entry for model `i` includes that model in full. `Some(filter)`
    /// keeps only `filter.roots` plus their forward-reference closure, minus
    /// anything the closure refuses to walk into or dedangle — see
    /// [`VisibilityFilter`] and [`compute_keep_set`] for the exact contract,
    /// including why an explicitly empty filter (`roots: vec![]`) means
    /// "nothing from this model", a different outcome from omitting the
    /// entry (or the whole field) entirely.
    pub included: Option<Vec<Option<VisibilityFilter>>>,
}

impl Default for MergedOptions {
    fn default() -> Self {
        Self {
            schema: None,
            description: "ViewDefinition [CoordinationView]".to_string(),
            application: "ifc-lite".to_string(),
            included: None,
        }
    }
}

/// Coverage stats for a merged export.
pub struct MergedStats {
    pub models: usize,
    pub written: usize,
}

/// First `IfcProject` express id in a model, if any.
fn find_project(content: &[u8]) -> Option<u32> {
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, _s, _e)) = scanner.next_entity() {
        if type_name == "IFCPROJECT" {
            return Some(id);
        }
    }
    None
}

/// Rewrite every `#N` in a STEP entity line. `remap(n)` returns `Some(absolute_id)` to
/// redirect a reference (no offset), or `None` to apply `offset`. Single-quoted strings
/// are left untouched (a `#` there is literal text) -- and, crucially, passed through as
/// raw bytes: `#`-ref scanning only needs to track in/out-of-string state (via the same
/// doubled-apostrophe toggle the STEP escape rule guarantees nets to a no-op), never to
/// decode string content. Everything outside a `#`-ref match is copied byte-for-byte, so a
/// multi-byte UTF-8 sequence (or any other non-ASCII byte run) in a DATA-section literal
/// survives unchanged instead of being Latin-1-expanded one byte at a time.
fn rewrite_refs(line: &[u8], offset: u32, remap: &impl Fn(u32) -> Option<u32>) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(line.len() + 8);
    let mut i = 0;
    let mut in_string = false;
    while i < line.len() {
        let b = line[i];
        if b == b'\'' {
            in_string = !in_string;
            out.push(b'\'');
            i += 1;
            continue;
        }
        if !in_string && b == b'#' {
            let mut j = i + 1;
            let mut n: u32 = 0;
            let mut any = false;
            while j < line.len() && line[j].is_ascii_digit() {
                n = n.wrapping_mul(10).wrapping_add((line[j] - b'0') as u32);
                j += 1;
                any = true;
            }
            if any {
                let target = remap(n).unwrap_or(n.wrapping_add(offset));
                out.push(b'#');
                out.extend_from_slice(target.to_string().as_bytes());
                i = j;
                continue;
            }
        }
        out.push(b);
        i += 1;
    }
    // `line` is a byte slice straight out of the source model with no
    // guarantee of valid UTF-8 (e.g. a Latin-1-encoded IFC file); fall back
    // to lossy replacement only for genuinely invalid sequences, matching
    // `step.rs`'s `String::from_utf8_lossy` treatment of raw entity lines.
    String::from_utf8_lossy(&out).into_owned()
}

/// Merge `models` (raw IFC byte slices) into one STEP/IFC string.
pub fn export_merged(models: &[&[u8]], opts: &MergedOptions) -> String {
    export_merged_with_stats(models, opts).0
}

/// Like [`export_merged`] but also returns coverage stats.
pub fn export_merged_with_stats(models: &[&[u8]], opts: &MergedOptions) -> (String, MergedStats) {
    let schema = opts
        .schema
        .clone()
        .or_else(|| models.first().map(|m| detect_schema(m)))
        .unwrap_or_else(|| "IFC4".to_string());

    // Mutable: a visibility filter on model 0 that excludes its own
    // `IfcProject` invalidates this below (see the `is_first` branch in the
    // loop) -- there is then nothing valid to redirect later models' project
    // references onto, so their own project must NOT be dropped either.
    let mut canonical_project = models.first().and_then(|m| find_project(m));

    let mut out = String::new();
    out.push_str("ISO-10303-21;\nHEADER;\n");
    out.push_str(&format!("FILE_DESCRIPTION(('{}'),'2;1');\n", escape(&opts.description)));
    out.push_str(&format!(
        "FILE_NAME('','',(''),(''),'{}','ifc-lite-export','');\n",
        escape(&opts.application)
    ));
    out.push_str(&format!("FILE_SCHEMA(('{}'));\n", escape(&schema)));
    out.push_str("ENDSEC;\nDATA;\n");

    // GlobalId → seen, across every model emitted so far. A `IfcRoot` entity
    // (by type + GlobalId-shaped first attribute) that repeats a GlobalId
    // already in this set gets a fresh deterministic id minted for it before
    // being written (see `leading_guid`/`mint_unique_guid`) -- ID-offsetting
    // `#`-refs, done above, never touches this attribute, so without this
    // step two models sharing an element (or the same file merged twice)
    // would emit the same 22-char GlobalId twice, an IFC spec violation.
    let mut emitted_guids: HashSet<String> = HashSet::new();

    let mut offset: u32 = 0;
    let mut written = 0usize;
    for (i, content) in models.iter().enumerate() {
        let model_project = find_project(content);
        let mut local_max = 0u32;
        let mut scanner = EntityScanner::new(content);
        let mut lines: Vec<(u32, &str, &[u8])> = Vec::new();
        while let Some((id, t, s, e)) = scanner.next_entity() {
            local_max = local_max.max(id);
            lines.push((id, t, &content[s..e]));
        }

        // Visibility filter for this model: `None` ⇒ keep everything (no
        // per-entity check below), `Some(keep)` ⇒ only ids in `keep` survive.
        // Computed on the model-LOCAL (pre-offset) ids `lines` already holds.
        let keep_set: Option<HashSet<u32>> = opts.included.as_ref().and_then(|per_model| {
            per_model.get(i).cloned().flatten().map(|filter| compute_keep_set(&lines, &filter))
        });

        let is_first = i == 0;
        // If model 0's own visibility filter excludes its `IfcProject`, there
        // is nothing to unify subsequent models onto: invalidate the
        // canonical project BEFORE it's captured by `remap` or checked by
        // the "drop this model's own project" test below.
        if is_first {
            if let (Some(cp), Some(keep)) = (canonical_project, &keep_set) {
                if !keep.contains(&cp) {
                    canonical_project = None;
                }
            }
        }
        let remap = |n: u32| -> Option<u32> {
            // Subsequent models: redirect their project reference to model 0's project.
            if !is_first {
                if let (Some(mp), Some(cp)) = (model_project, canonical_project) {
                    if n == mp {
                        return Some(cp);
                    }
                }
            }
            None
        };

        // GlobalIds minted for THIS model's collisions, so two collisions
        // within the same model can't mint the same fresh id as each other
        // (checked in addition to `emitted_guids`).
        let mut pending_minted: HashSet<String> = HashSet::new();

        for (id, type_name, line) in &lines {
            // Visibility filter: an id not in this model's kept set is
            // dropped before anything else (GlobalId bookkeeping included --
            // an excluded entity was never emitted, so it must not occupy or
            // reserve a GlobalId either).
            if let Some(keep) = &keep_set {
                if !keep.contains(id) {
                    continue;
                }
            }
            // Drop later models' IfcProject lines (the project is unified to
            // model 0's) -- only when model 0's project actually survived its
            // own visibility filter (see the `is_first` block above); if it
            // didn't, this model's project is kept, subject only to its own
            // filter, same as any other entity.
            if !is_first && canonical_project.is_some() && Some(*id) == model_project {
                continue;
            }
            // Narrow (not just gate on) a kept IFCREL* line -- see `narrow_for_emission`.
            let narrowed = keep_set.as_ref().map(|k| narrow_for_emission(type_name, line, k));
            let mut rewritten = rewrite_refs(narrowed.as_deref().unwrap_or(line), offset, &remap);

            if let Some(guid) = leading_guid(line, type_name) {
                if emitted_guids.contains(&guid) {
                    let fresh = mint_unique_guid(&guid, i, &emitted_guids, &mut pending_minted);
                    rewritten = replace_leading_guid(&rewritten, &fresh);
                    emitted_guids.insert(fresh);
                } else {
                    emitted_guids.insert(guid);
                }
            }

            out.push_str(&rewritten);
            out.push('\n');
            written += 1;
        }
        offset = offset.wrapping_add(local_max).wrapping_add(1);
    }

    out.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    (out, MergedStats { models: models.len(), written })
}

#[cfg(test)]
#[path = "merged_tests.rs"]
mod tests;
