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
