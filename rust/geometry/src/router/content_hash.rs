// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Structural content hash of an IFC representation ITEM subtree, for geometry
//! deduplication of the meshing + CSG compute.
//!
//! Repeated shapes reuse a local mesh after a structural signature match.
//! Only completed fast BREP signatures may be shared between model routers.
//!
//! This hashes the FULLY RESOLVED item subtree (entity references followed to
//! their values), so two geometrically identical items with different entity
//! numbers normally share a key; warped BREPs keep source identity (#7714).
//! It deliberately covers ONLY geometry-defining
//! structure: colour/style (`IfcStyledItem` points INTO the item from outside,
//! so it is never in the closure), the per-instance `geometry_id`, voids and
//! placement all live OUTSIDE the item and stay per-instance — the cache holds a
//! colour-free local mesh that every instance reuses with its own attributes.
//!
//! Full 128-bit structural hashes avoid the sampled-hash collisions of #833.
//! Integer splitmix64 and float bit patterns produce target-independent keys.

use crate::geom_hash::mix64;
use ifc_lite_core::{
    express_id::parse_express_id, parser::StepRecord, step_encoding::step_string_literal_end, EntityDecoder,
};
use rustc_hash::FxHashMap;

/// Defensive recursion bound. IFC geometry is a DAG (item → solids → profiles →
/// points); deeply NESTED `IfcBooleanResult` chains are the realistic deep case,
/// so this is set well above any plausible cut chain. Beyond it the hash falls
/// back to an entity-id-distinct value (see `sig_entity`) so over-depth subtrees
/// can never COLLIDE — they simply stop deduping rather than risk a false merge.
const MAX_DEPTH: u32 = 256;

/// Sentinel written into the memo while an entity's hash is being computed, so a
/// (malformed) cycle resolves to a fixed value instead of recursing forever.
const CYCLE_SENTINEL: u128 = 0xC1C1_C1C1_C1C1_C1C1_C1C1_C1C1_C1C1_C1C1;

/// Seed for the cheap byte-level `IfcFacetedBrep` signature (see
/// [`try_faceted_brep_signature`]). Distinct from the generic `0x5EED_5EED` type
/// seed so a brep hashed via the fast path and one hashed via the recursive
/// fallback occupy disjoint key space and never false-merge.
const FACETED_BREP_TAG: u64 = 0xFACE_7B16_5160_0001;

/// Fold a 64-bit value into a 128-bit running state across two independent lanes.
#[inline]
fn fold(state: u128, v: u64) -> u128 {
    let lo = state as u64;
    let hi = (state >> 64) as u64;
    let lo2 = mix64(lo.wrapping_add(v).wrapping_mul(0x9E37_79B9_7F4A_7C15));
    let hi2 = mix64(
        hi.rotate_left(23) ^ v.wrapping_mul(0xC2B2_AE3D_27D4_EB4F).wrapping_add(0x1656_67B1),
    );
    ((hi2 as u128) << 64) | (lo2 as u128)
}

#[inline]
fn fold_bytes(mut state: u128, bytes: &[u8]) -> u128 {
    state = fold(state, bytes.len() as u64);
    let mut chunks = bytes.chunks_exact(8);
    for c in &mut chunks {
        state = fold(state, u64::from_le_bytes(c.try_into().unwrap()));
    }
    let rem = chunks.remainder();
    if !rem.is_empty() {
        let mut buf = [0u8; 8];
        buf[..rem.len()].copy_from_slice(rem);
        state = fold(state, u64::from_le_bytes(buf));
    }
    state
}

/// Whether the raw STEP record `bytes` (`#<id>=IFCTYPE(...)`) names IFC type
/// `name` (upper case), compared case-insensitively as a whole identifier.
/// Cheap, with no attribute decode: this runs once per entity of every item
/// subtree the dedup hashes, so the head every exporter writes
/// (`#<digits>=KEYWORD(`, no trivia) is settled by a forward scan, and only a
/// head with trivia in it (`#1= /*c*/ KEYWORD (`) goes to core's
/// [`StepRecord`] (F4 M-geom, CORE-10).
#[inline]
fn type_token_is(bytes: &[u8], name: &[u8]) -> bool {
    let mut i = 1;
    if bytes.first() == Some(&b'#') {
        while bytes.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if bytes.get(i) == Some(&b'=') {
            i += 1;
            // ArchiCAD writes `#1= IFCPERSON(`: plain blanks are not trivia
            // worth the slow path.
            while bytes.get(i).is_some_and(|&b| ifc_lite_core::parser::is_step_space(b)) {
                i += 1;
            }
            let keyword = &bytes[i..];
            // Anything but a keyword byte now (a `/*` comment) goes the slow way.
            if keyword.first().is_some_and(|&b| b.is_ascii_alphabetic()) {
                let Some(head) = keyword.get(..name.len()) else { return false };
                if !head.eq_ignore_ascii_case(name) {
                    return false;
                }
                match keyword.get(name.len()) {
                    Some(b'(') => return true,
                    Some(b) if b.is_ascii_alphanumeric() || *b == b'_' => return false,
                    _ => {}
                }
            }
        }
    }
    // `keyword_bytes`, not `keyword_is`: a second call site makes the compiler
    // stop inlining `keyword_is` into the per-bound reader, which costs more
    // than this whole slow path.
    StepRecord::parse(bytes)
        .and_then(|record| record.keyword_bytes())
        .is_some_and(|keyword| keyword.eq_ignore_ascii_case(name))
}

/// The record's first attribute when it is exactly one `#<digits>` reference
/// — e.g. the single shell ref of `#5=IFCFACETEDBREP(#137924)`. Read through
/// [`StepRecord::ref_at`], so a `#` in a comment (`(/*#9*/#5)`) is not the
/// reference, and a ref above `u32::MAX` refuses (`None`) rather than wrapping
/// onto a real low-numbered entity (issue #3421).
#[inline]
fn parse_first_ref(bytes: &[u8]) -> Option<u32> {
    // The shape every exporter writes, `...(#<digits>)` with no trivia before
    // the reference, is settled in place; anything else (a comment ahead of
    // the `(`, a space or comment inside it, a list) is core's to read.
    if let Some(open) = bytes.iter().take(64).position(|&b| b == b'(' || b == b'/') {
        if bytes[open] == b'(' && bytes.get(open + 1) == Some(&b'#') {
            let digits = &bytes[open + 2..];
            let len = digits.iter().take_while(|b| b.is_ascii_digit()).count();
            if len > 0 && matches!(digits.get(len), Some(b')' | b',')) {
                return parse_express_id(&digits[..len]);
            }
        }
    }
    StepRecord::parse(bytes)?.ref_at(ifc_lite_core::slot::IfcFacetedBrep::OUTER.index())
}

/// `true` when the entity at `id` is an `IfcFacetedBrep`, peeked from its raw STEP
/// bytes without decoding attributes.
#[inline]
pub(super) fn is_faceted_brep(decoder: &mut EntityDecoder, id: u32) -> bool {
    decoder
        .get_raw_bytes(id)
        .is_some_and(|b| type_token_is(b, b"IFCFACETEDBREP"))
}

#[path = "carrier_signature.rs"]
mod carrier_signature;
pub(super) use carrier_signature::try_faceted_brep_signature;

/// Face-count threshold above which [`faceted_brep_face_count`] tells the
/// caller to skip the structural signature walk entirely (#1909). The walk in
/// [`try_faceted_brep_signature`] mirrors the mesher's own traversal
/// face-by-face, bound-by-bound, point-by-point — for dedup to pay off there
/// must be at least one OTHER item sharing this exact signature. Tekla-style
/// duplication (thousands of connection plates/bolts, the case this cache
/// exists for) tops out at low hundreds of faces per part; a SINGLE huge
/// faceted import — a terrain, a scanned mesh, one big BREP with no sibling —
/// has none, so hashing every point is pure loss that DOUBLES the traversal
/// cost of an already-expensive mesh with no possible payback. Set well above
/// any plausible detail-part face count and well below the scale where a
/// single giant mesh becomes measurably worse — a 2.5 M-triangle model
/// reported ~30 s where web-ifc took ~2.85 s, traced to this hash.
///
/// `pub` (re-exported through `router` and the crate root — see `lib.rs`,
/// same pattern as `GEOMETRY_DIAGNOSTICS_SCHEMA_VERSION`) rather than
/// `pub(super)`/`pub(crate)`, specifically so the #1909 regression test
/// (`tests/issue_1909_large_single_brep_dedup.rs`, an external integration
/// test crate that only sees this crate's public API) reads the real
/// threshold instead of hard-coding `20_000` a second time (PR #1977
/// review: that duplication is exactly the shape of the 341/88 checklist
/// drift on #1963 — assertion and constant silently disagreeing).
pub const FACETED_BREP_DEDUP_FACE_LIMIT: usize = 20_000;

/// Cheap pre-check for [`FACETED_BREP_DEDUP_FACE_LIMIT`]: the face count of the
/// `IfcFacetedBrep` at `brep_id`, read via the SAME fast ref-list path
/// [`try_faceted_brep_signature`] uses for its first two hops (shell ref, face
/// list) — no per-point decode, so this stays O(faces) even when the full
/// signature would be O(faces × points). `None` on any structural surprise
/// (missing shell ref, malformed list): the caller then falls through to
/// computing the full signature as before, so a surprise never silently skips
/// a legitimately dedupable item — only a confirmed large brep does.
pub(super) fn faceted_brep_face_count(decoder: &mut EntityDecoder, brep_id: u32) -> Option<usize> {
    let bytes = decoder.get_raw_bytes(brep_id)?;
    let shell_id = parse_first_ref(bytes)?;
    decoder.get_entity_ref_list_fast(shell_id).map(|v| v.len())
}

/// 128-bit structural hash of the representation item rooted at `root_id`. `memo`
/// caches per-entity hashes so shared sub-entities (a profile reused by many
/// solids, the representation context) are visited once; it keys on entity ids,
/// so it must belong to ONE model (the `GeometryRouter` owns one per loaded
/// file).
/// `refused` accumulates one count per `#<digits>` child reference this walk
/// could not parse because it exceeded `u32::MAX` (issue #3421/#3752) — the
/// caller (a [`super::GeometryRouter`] method) folds it into
/// [`super::GeometryRouter::take_content_hash_oversized_ref_drops`] so a
/// maintainer can tell "this model has an unrepresentable reference" apart
/// from "this subtree happens to hash like a genuinely missing one". The
/// refusal itself is harmless to the DEDUP KEY (folded as the same fixed
/// sentinel an unresolvable reference already uses, so renumbering-invariance
/// holds), it is only the diagnostic that was missing.
pub fn item_signature(
    decoder: &mut EntityDecoder,
    root_id: u32,
    memo: &mut FxHashMap<u32, u128>,
    refused: &mut usize,
) -> u128 {
    sig_entity(decoder, root_id, memo, 0, refused, false)
}

/// Continue a root whose fast BREP traversal already failed, without repeating it.
pub(super) fn item_signature_after_failed_brep(
    decoder: &mut EntityDecoder, root_id: u32, memo: &mut FxHashMap<u32, u128>, refused: &mut usize,
) -> u128 {
    sig_entity(decoder, root_id, memo, 0, refused, true)
}

/// Combine the pure structural item hash with the router parameters that change
/// the MESHED output but live outside the IFC structure — tessellation quality
/// (curved profiles tessellate finer at higher quality), unit scale, and RTC
/// offset. Without this, a cache shared across routers — or one that outlives a
/// `setTessellationQuality` change on the same worker — would serve a mesh built
/// under different parameters (e.g. #976: every quality level returns the
/// first-cached triangle count).
pub fn key_with_params(structural: u128, quality_index: u8, unit_scale: f64, rtc: (f64, f64, f64)) -> u128 {
    let mut s = fold(structural, quality_index as u64);
    s = fold(s, unit_scale.to_bits());
    s = fold(s, rtc.0.to_bits());
    s = fold(s, rtc.1.to_bits());
    fold(s, rtc.2.to_bits())
}

fn sig_entity(
    decoder: &mut EntityDecoder,
    id: u32,
    memo: &mut FxHashMap<u32, u128>,
    depth: u32,
    refused: &mut usize,
    skip_fast_brep: bool,
) -> u128 {
    if let Some(&s) = memo.get(&id) {
        return s;
    }
    if depth > MAX_DEPTH {
        // Fold the entity id so two DIFFERENT over-depth subtrees get DIFFERENT
        // values — they stop deduping (id breaks renumbering-invariance) but can
        // never false-merge, which matters far more than deduping a pathological
        // boolean chain.
        return fold(0xDEAD_BEEF_DEAD_BEEF, id as u64);
    }
    // Cheap byte-level fast path for the dominant geometry type: Tekla and other
    // steel detailers export thousands of IfcFacetedBrep, and the generic
    // recursive walk below `decode_by_id`s every IfcCartesianPoint (hundreds per
    // part) — that is the measured ~8 s hash cost that made dedup a net loss. The
    // fast path mirrors the mesher's traversal with no decode; on any structural
    // surprise it falls through to the generic walk (correctness preserved).
    let source_brep = is_faceted_brep(decoder, id);
    if !skip_fast_brep && source_brep {
        if let Some(s) = try_faceted_brep_signature(decoder, id) {
            memo.insert(id, s);
            return s;
        }
    }
    memo.insert(id, CYCLE_SENTINEL); // break cycles (DAG ⇒ unreachable in practice)
    // Cheap structural hash from the RAW STEP bytes — no `decode_by_id`, so no
    // per-attribute `AttributeValue` allocation. That decode cost (every
    // IfcCartesianPoint of every extrusion/boolean operand) is what made dedup a
    // net loss on procedural geometry (#1177) and kept the gate brep-only. Walk
    // the record bytes folding literals, and on each `#ref` recurse so the hash
    // stays structural + renumbering-invariant (the entity's own id is skipped).
    let raw = match decoder.get_raw_bytes(id) { // #3988: borrows source, not decoder state.
        Some(b) => b,
        None => {
            // Unresolvable reference: a fixed sentinel (NOT the id, so structurally
            // identical-but-renumbered files still collide).
            let s = fold(0, 0x00BA_D0BA_D0BA_D000);
            memo.insert(id, s);
            return s;
        }
    };
    let source_brep = source_brep || StepRecord::parse(raw)
        .is_some_and(|record| record.keyword_is(b"IFCFACETEDBREP"));
    let acc = sig_walk_bytes(decoder, raw, memo, depth, refused);
    // Preserve identity on generic fallback and Boolean parents too (#7714).
    let acc = if source_brep { fold(acc, id as u64) } else { acc };
    memo.insert(id, acc);
    acc
}

/// Structural signature of a single STEP record from its raw bytes, recursing on
/// every `#ref`. Folds literal runs verbatim and replaces each ref with its
/// child signature, so the result is identical regardless of entity-id numbering.
/// `#` inside a single-quoted string (STEP escapes a literal quote as `''`, and
/// the PAGE directive `\S\` may take an apostrophe operand) is NOT treated as a
/// ref. The record's own leading `#<id>=` is skipped.
fn sig_walk_bytes(
    decoder: &mut EntityDecoder,
    bytes: &[u8],
    memo: &mut FxHashMap<u32, u128>,
    depth: u32,
    refused: &mut usize,
) -> u128 {
    let len = bytes.len();
    // Skip a leading `#<id>=` (only when the `=` precedes the first `(`).
    let mut i = 0;
    {
        let mut k = 0;
        while k < len && bytes[k] != b'(' && bytes[k] != b'=' {
            k += 1;
        }
        if k < len && bytes[k] == b'=' {
            i = k + 1;
        }
    }
    let mut acc = fold(0, 0x5EED_5EED);
    let mut lit_start = i;
    while i < len {
        let c = bytes[i];
        if c == b'\'' {
            // One rule for where a literal ends: `''` and a PAGE directive's
            // apostrophe operand (`'Para \S\' 5'`) stay inside it (#7589). A
            // string that never closes swallows the rest as literal bytes.
            match step_string_literal_end(bytes, i) {
                Some(end) => {
                    i = end;
                    continue;
                }
                None => break,
            }
        }
        if c == b'#' && i + 1 < len && bytes[i + 1].is_ascii_digit() {
            acc = fold_bytes(acc, &bytes[lit_start..i]);
            let mut j = i + 1;
            while j < len && bytes[j].is_ascii_digit() {
                j += 1;
            }
            let child = match parse_express_id(&bytes[i + 1..j]) {
                Some(rid) => sig_entity(decoder, rid, memo, depth + 1, refused, false),
                // A ref above `u32::MAX` refuses rather than wrapping onto a
                // real low-numbered entity (issue #3421) — treated the same
                // as an unresolvable reference: the fixed sentinel above,
                // not the id, so structurally identical-but-renumbered files
                // still collide. Counted (issue #3752): the hash stays
                // correct, but a refusal here used to leave no trace at all.
                None => {
                    *refused += 1;
                    fold(0, 0x00BA_D0BA_D0BA_D000)
                }
            };
            acc = fold(fold(fold(acc, 1), child as u64), (child >> 64) as u64);
            i = j;
            lit_start = i;
            continue;
        }
        i += 1;
    }
    fold_bytes(acc, &bytes[lit_start..len])
}

#[cfg(test)]
#[path = "content_hash_tests.rs"]
mod tests;
