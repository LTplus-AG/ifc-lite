// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Structural content hash of an IFC representation ITEM subtree, for geometry
//! deduplication of the meshing + CSG compute.
//!
//! Tekla (and other steel detailers) export thousands of geometrically identical
//! parts — connection plates, bolts — each with its OWN representation item
//! rather than sharing one via `IfcMappedItem`. The Manifold kernel chewed
//! through the redundant booleans fast; the exact pure-Rust kernel (#1024) is
//! ~20-40× slower per cut, so re-meshing+re-CSG'ing the duplicates dominates load
//! time (a 19.5 MB Tekla model: 83% of 15k items are byte-duplicates).
//!
//! This hashes the FULLY RESOLVED item subtree (entity references followed to
//! their values), so two geometrically identical items with different entity
//! numbers map to the SAME key. It deliberately covers ONLY geometry-defining
//! structure: colour/style (`IfcStyledItem` points INTO the item from outside,
//! so it is never in the closure), the per-instance `geometry_id`, voids and
//! placement all live OUTSIDE the item and stay per-instance — the cache holds a
//! colour-free local mesh that every instance reuses with its own attributes.
//!
//! The hash is 128-bit over the COMPLETE structure (every attribute value,
//! recursively), unlike the sampled 64-bit mesh hash that collided in #833. The
//! collision probability across a model's items is ~1e-30, so no post-mesh
//! equality fallback is needed. Deterministic (integer splitmix64, no float
//! ordering beyond the bit pattern), so native x86_64/aarch64 and wasm32 produce
//! identical keys.

use ifc_lite_core::{AttributeValue, EntityDecoder};
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

#[inline]
fn mix64(mut x: u64) -> u64 {
    // splitmix64 finalizer — strong avalanche, same as `geom_hash::mix64`.
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    x ^ (x >> 31)
}

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

/// Whether the raw STEP record `bytes` (`#<id>=IFCTYPE(...)`, possibly with a
/// leading id or whitespace) names IFC type `name`, compared case-insensitively
/// up to the opening `(`. Cheap: a byte-prefix scan, no attribute decode.
#[inline]
fn type_token_is(bytes: &[u8], name: &[u8]) -> bool {
    let len = bytes.len();
    let mut i = 0;
    while i < len && matches!(bytes[i], b' ' | b'\r' | b'\n' | b'\t') {
        i += 1;
    }
    // Skip an optional leading "#<digits>" entity id and its '=' separator.
    if i < len && bytes[i] == b'#' {
        i += 1;
        while i < len && bytes[i].is_ascii_digit() {
            i += 1;
        }
        while i < len && bytes[i] != b'=' && bytes[i] != b'(' {
            i += 1;
        }
        if i < len && bytes[i] == b'=' {
            i += 1;
        }
        while i < len && matches!(bytes[i], b' ' | b'\r' | b'\n' | b'\t') {
            i += 1;
        }
    }
    let ty = &bytes[i..];
    ty.len() >= name.len()
        && ty[..name.len()].eq_ignore_ascii_case(name)
        // The type token must END here (next byte is '(' or whitespace), so
        // "IFCFACETEDBREP" never matches a longer "IFCFACETEDBREPX".
        && ty.get(name.len()).map_or(true, |&c| matches!(c, b'(' | b' ' | b'\r' | b'\n' | b'\t'))
}

/// Parse the first `#<digits>` entity reference inside a STEP record's attribute
/// list — e.g. the single shell ref of `#5=IFCFACETEDBREP(#137924)`. Skips past
/// the opening `(` first so the record's own `#id` prefix is never matched.
#[inline]
fn parse_first_ref(bytes: &[u8]) -> Option<u32> {
    let len = bytes.len();
    let mut i = 0;
    while i < len && bytes[i] != b'(' {
        i += 1;
    }
    while i < len && bytes[i] != b'#' {
        i += 1;
    }
    if i >= len {
        return None;
    }
    i += 1; // skip '#'
    let start = i;
    let mut id = 0u32;
    while i < len && bytes[i].is_ascii_digit() {
        id = id.wrapping_mul(10).wrapping_add((bytes[i] - b'0') as u32);
        i += 1;
    }
    if i > start {
        Some(id)
    } else {
        None
    }
}

/// `true` when the entity at `id` is an `IfcFacetedBrep`, peeked from its raw STEP
/// bytes without decoding attributes.
#[inline]
fn is_faceted_brep(decoder: &mut EntityDecoder, id: u32) -> bool {
    decoder
        .get_raw_bytes(id)
        .is_some_and(|b| type_token_is(b, b"IFCFACETEDBREP"))
}

/// Cheap byte-level structural signature of an `IfcFacetedBrep`, mirroring the
/// mesher's traversal (shell → faces → bounds → loops → point coords) through the
/// SAME fast byte paths it uses — zero `decode_by_id`, so no per-point
/// `AttributeValue` allocation (the ~8 s/model hot path on Tekla steel). Every bit
/// the mesh depends on is folded in: face/bound counts, each bound's orientation
/// and outer flag, and every loop's point coordinates in order. Two breps share a
/// signature iff they mesh identically; any difference diverges the hash.
///
/// Returns `None` on any structural surprise (missing ref, malformed loop) so the
/// caller falls back to the generic recursive signature — correctness preserved,
/// only the fast dedup is skipped for that one item.
fn try_faceted_brep_signature(decoder: &mut EntityDecoder, brep_id: u32) -> Option<u128> {
    // IfcFacetedBrep(#shell): a SINGLE bare ref, not a `((...))` list — so
    // `get_entity_ref_list_fast` (which expects a nested list) can't read it.
    // Parse the one shell ref straight from the brep's bytes. The shell, faces,
    // and bounds below ARE ref lists, so the fast list reader handles them.
    let shell_id = {
        let bytes = decoder.get_raw_bytes(brep_id)?;
        parse_first_ref(bytes)?
    };
    let face_ids = decoder.get_entity_ref_list_fast(shell_id)?;

    let mut acc = fold(0, FACETED_BREP_TAG);
    acc = fold(acc, face_ids.len() as u64);
    for face_id in face_ids {
        let bound_ids = decoder.get_entity_ref_list_fast(face_id)?;
        acc = fold(acc, bound_ids.len() as u64);
        for bound_id in bound_ids {
            let (loop_id, orientation, is_outer) = decoder.get_face_bound_fast(bound_id)?;
            acc = fold(acc, orientation as u64);
            acc = fold(acc, is_outer as u64);
            let coords = decoder.get_polyloop_coords_cached(loop_id)?;
            acc = fold(acc, coords.len() as u64);
            for (x, y, z) in coords {
                acc = fold(acc, x.to_bits());
                acc = fold(acc, y.to_bits());
                acc = fold(acc, z.to_bits());
            }
        }
    }
    Some(acc)
}

/// 128-bit structural hash of the representation item rooted at `root_id`. `memo`
/// caches per-entity hashes so shared sub-entities (a profile reused by many
/// solids, the representation context) are visited once; it keys on entity ids,
/// so it must belong to ONE model (the `GeometryRouter` owns one per loaded
/// file).
pub fn item_signature(decoder: &mut EntityDecoder, root_id: u32, memo: &mut FxHashMap<u32, u128>) -> u128 {
    sig_entity(decoder, root_id, memo, 0)
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

fn sig_entity(decoder: &mut EntityDecoder, id: u32, memo: &mut FxHashMap<u32, u128>, depth: u32) -> u128 {
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
    if is_faceted_brep(decoder, id) {
        if let Some(s) = try_faceted_brep_signature(decoder, id) {
            memo.insert(id, s);
            return s;
        }
    }
    memo.insert(id, CYCLE_SENTINEL); // break cycles (DAG ⇒ unreachable in practice)
    let entity = match decoder.decode_by_id(id) {
        Ok(e) => e,
        Err(_) => {
            // Unresolvable reference: a fixed sentinel (NOT the id, so structurally
            // identical-but-renumbered files still collide).
            let s = fold(0, 0x00BA_D0BA_D0BA_D000);
            memo.insert(id, s);
            return s;
        }
    };
    // Hash the stable type NAME (IfcType isn't a primitive-castable enum).
    let mut acc = fold_bytes(fold(0, 0x5EED_5EED), entity.ifc_type.as_str().as_bytes());
    for attr in &entity.attributes {
        acc = hash_attr(decoder, attr, acc, memo, depth);
    }
    memo.insert(id, acc);
    acc
}

fn hash_attr(
    decoder: &mut EntityDecoder,
    attr: &AttributeValue,
    acc: u128,
    memo: &mut FxHashMap<u32, u128>,
    depth: u32,
) -> u128 {
    match attr {
        AttributeValue::EntityRef(r) => {
            let child = sig_entity(decoder, *r, memo, depth + 1);
            // Fold both lanes of the child hash, tagged.
            fold(fold(fold(acc, 1), child as u64), (child >> 64) as u64)
        }
        AttributeValue::String(s) => fold_bytes(fold(acc, 2), s.as_bytes()),
        AttributeValue::Integer(i) => fold(fold(acc, 3), *i as u64),
        AttributeValue::Float(f) => fold(fold(acc, 4), f.to_bits()),
        AttributeValue::Enum(e) => fold_bytes(fold(acc, 5), e.as_bytes()),
        AttributeValue::List(items) => {
            let mut a = fold(fold(acc, 6), items.len() as u64);
            for it in items {
                a = hash_attr(decoder, it, a, memo, depth);
            }
            a
        }
        AttributeValue::Null => fold(acc, 8),
        AttributeValue::Derived => fold(acc, 9),
    }
}
