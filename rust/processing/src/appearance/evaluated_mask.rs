// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Face masks: reviewable surface targeting bound to a canonical surface
//! fingerprint (#4404). A mask never reuses triangle ordinals by position; the
//! fingerprint must match the surface the plan is about to author.
use super::{types::FaceMask, AppearanceRequest, RepresentationPolicy};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub(super) const STALE: &str = "Face selection is stale: the evaluated surface geometry changed";
pub(super) const DIRECT_BODY: &str =
    "Face masks currently apply to converted occurrence bodies only; this object already has a direct tessellated Body";
/// Coordinates are quantised to one micrometre before hashing so that
/// sub-micrometre noise between two plans of the same file cannot drop a mask.
/// The points come from the canonical f32 world evaluation, so the fingerprint
/// binds to the surface at its current placement: a renumbered export keeps a
/// mask, while a placement edit generally reports it stale (f32 spacing exceeds
/// one micrometre beyond a few metres from the origin) unless the move is
/// exactly representable. Stale is the safe direction; a mask is never reused.
const QUANTUM_PER_METRE: f64 = 1e6;
/// Equals the plan geometry budget's triangle capacity (1 500 000 corners).
const MASK_ORDINAL_BUDGET: usize = 500_000;

/// Request-shape validation before any source work. Masks are meaningful only
/// when conversion is permitted; a mask outside the scope is a caller error.
pub(super) fn validate(request: &AppearanceRequest) -> Result<BTreeMap<u32, &FaceMask>, String> {
    let mut masks = BTreeMap::new();
    if request.face_masks.is_empty() { return Ok(masks); }
    if request.representation_policy != RepresentationPolicy::EvaluatedOccurrence {
        return Err("Face masks require the evaluatedOccurrence representation policy".into());
    }
    if request.face_masks.len() > request.product_ids.len() {
        return Err("Face masks exceed the appearance scope".into());
    }
    let scope: BTreeSet<u32> = request.product_ids.iter().copied().collect();
    // The plan's corner budget admits at most MASK_ORDINAL_BUDGET triangles in
    // total, so more raw ordinals than that across the request can never be a
    // valid selection; refuse before any of them is cloned or sorted.
    let mut ordinals = 0usize;
    for mask in &request.face_masks {
        if !scope.contains(&mask.product_id) {
            return Err("Face mask targets a product outside the appearance scope".into());
        }
        if mask.surface_fingerprint.len() != 64 || !mask.surface_fingerprint.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Face mask fingerprint must be a hex SHA-256 digest".into());
        }
        ordinals = ordinals.saturating_add(mask.triangles.len());
        if ordinals > MASK_ORDINAL_BUDGET { return Err("Face masks exceed their triangle budget".into()); }
        if masks.insert(mask.product_id, mask).is_some() {
            return Err("Duplicate face mask for one product".into());
        }
    }
    Ok(masks)
}

/// `points` are the authored product-local coordinates in source length units;
/// `scale` converts them to metres. Only the surface identity enters the hash.
pub(super) fn fingerprint(global_id: &str, points: &[[f64; 3]], scale: f64, indices: &[u32]) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hasher.update(b"ifc-lite evaluated surface v1\0");
    hasher.update(global_id.as_bytes());
    hasher.update([0u8]);
    hasher.update((points.len() as u64).to_le_bytes());
    for point in points {
        for &value in point {
            let quantised = value * scale * QUANTUM_PER_METRE;
            if !quantised.is_finite() || quantised.abs() > 9.0e18 {
                return Err("Evaluated surface coordinate exceeds the fingerprint range".into());
            }
            hasher.update((quantised.round() as i64).to_le_bytes());
        }
    }
    hasher.update((indices.len() as u64).to_le_bytes());
    for &index in indices { hasher.update(index.to_le_bytes()); }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Source triangle corners split by the accepted mask, in source order.
pub(super) struct Partition {
    pub masked: Vec<u32>,
    pub retained: Vec<u32>,
    pub triangles: Vec<u32>,
}

/// A mask covering every triangle is an ordinary whole-surface conversion.
pub(super) fn partition(mask: &FaceMask, fingerprint: &str, indices: &[u32]) -> Result<Option<Partition>, String> {
    if mask.surface_fingerprint != fingerprint { return Err(STALE.into()); }
    let count = indices.len() / 3;
    let mut triangles = mask.triangles.clone();
    triangles.sort_unstable();
    triangles.dedup();
    if triangles.is_empty() { return Err("Face selection contains no triangles".into()); }
    if triangles.last().is_some_and(|&last| last as usize >= count) {
        return Err("Face selection references a triangle outside the evaluated surface".into());
    }
    if triangles.len() == count { return Ok(None); }
    let mut masked = Vec::with_capacity(triangles.len() * 3);
    let mut retained = Vec::with_capacity((count - triangles.len()) * 3);
    let mut next = triangles.iter().peekable();
    for (ordinal, corners) in indices.chunks_exact(3).enumerate() {
        if next.peek().is_some_and(|&&selected| selected as usize == ordinal) {
            masked.extend_from_slice(corners);
            next.next();
        } else {
            retained.extend_from_slice(corners);
        }
    }
    Ok(Some(Partition { masked, retained, triangles }))
}

#[cfg(test)]
#[path = "evaluated_mask_tests.rs"]
mod tests;
