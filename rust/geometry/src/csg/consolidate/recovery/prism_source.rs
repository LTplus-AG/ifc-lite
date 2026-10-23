// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Prepare analytic source hygiene only for an already-eligible remote retry.
use super::closure;
use super::super::{buckets, plane_merge, plans, supported_cells};
use crate::Mesh;

pub(super) struct Prepared {
    pub(super) signature: closure::Signature,
    pub(super) buckets: buckets::Buckets,
    pub(super) planned: plans::Planned,
}

pub(super) fn prepare(
    input: &Mesh,
    host: &Mesh,
    original_buckets: &buckets::Buckets,
    supported: &supported_cells::Supported,
    length_unit_scale: f64,
) -> Option<Prepared> {
    // The analytic emitter has no kernel plane tags. Refuse another producer
    // rather than letting index cleanup silently misalign per-triangle tags.
    if input.plane_tags.is_some() { return None; }
    // This prepares the existing finalizer's hygienic-source contract, not
    // identity with the raw finite surface: generated subgrid remnants still
    // follow that established cleanup policy. Decline sources with authored
    // thin faces rather than guessing fragment ancestry after subdivision.
    if host.needs_degenerate_cleanup() { return None; }
    let mut cleaned = input.clone();
    cleaned.clean_degenerate();
    if cleaned.indices.len() >= input.indices.len() { return None; }
    let signature = closure::closed_signature(&cleaned).ok()?;
    let mut buckets = buckets::build(&cleaned);
    let merged = plane_merge::merge_rounding_split_buckets(&mut buckets);
    if !protected_faces_preserved(original_buckets, &buckets, supported) { return None; }
    // Preserve the original retention policy, including recursive callers'
    // disabled protections. Never discover extra rescue policy during a retry.
    let planned = plans::build(&buckets, &merged, supported, length_unit_scale);
    Some(Prepared { signature, buckets, planned })
}

/// Every protected bucket keeps the exact ordered-coordinate face multiset.
/// Bounds and volume alone would not prove retention of a thin cell or fold.
fn protected_faces_preserved(
    original: &buckets::Buckets,
    cleaned: &buckets::Buckets,
    supported: &supported_cells::Supported,
) -> bool {
    supported.buckets.iter().all(|key| {
        let (Some(before), Some(after)) = (original.get(key), cleaned.get(key)) else {
            return false;
        };
        let mut counts = rustc_hash::FxHashMap::<_, usize>::default();
        for face in before {
            *counts.entry(supported_cells::cell_key(&face.v)).or_default() += 1;
        }
        for face in after {
            let Some(count) = counts.get_mut(&supported_cells::cell_key(&face.v)) else {
                return false;
            };
            if *count == 0 { return false; }
            *count -= 1;
        }
        counts.values().all(|&count| count == 0)
    })
}
