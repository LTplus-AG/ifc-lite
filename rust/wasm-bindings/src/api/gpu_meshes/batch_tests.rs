// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Output-record and routing invariants. Production/source adapters are exercised
//! by batch_adapter_tests.rs and the native/browser parity corpus; batch_host
//! supplies the native clock for those tests.

use super::ElementMeshOutput;

fn output(
    geometry_hash: Option<u64>,
    geometry_aabb: Option<[f64; 6]>,
    geometry_volume: Option<f64>,
    geometry_closure_bits: u8,
) -> ElementMeshOutput {
    ElementMeshOutput {
        id: 4242,
        meshes: Vec::new(),
        finishes: Vec::new(),
        geometry_hash,
        geometry_aabb,
        geometry_volume,
        geometry_closure_bits,
    }
}

/// The hash is the record's reason to exist: without one there is nothing for
/// the diff engine to compare, so no record must be emitted at all. An AABB
/// and a volume present alongside a missing hash is the case that separates
/// "gated on the hash" from "gated on anything being measured".
#[test]
fn no_hash_means_no_fingerprint_even_when_the_other_fields_are_present() {
    let out = output(None, Some([1.0; 6]), Some(2.0), 3);
    assert!(
        out.fingerprint().is_none(),
        "a fingerprint without a hash would push an id into the parallel \
         arrays with nothing to compare it against"
    );
}

/// Every field reaches its own slot. The fixture gives each one a value that
/// belongs to no other field and an AABB whose six components are all
/// different, so a transposed min/max or a volume read from the closure bits
/// lands somewhere visible.
#[test]
fn a_hashed_element_carries_every_measured_field_through() {
    let aabb = [-1.5, -2.5, -3.5, 4.5, 5.5, 6.5];
    let out = output(Some(0xDEAD_BEEF_0000_0001), Some(aabb), Some(7.25), 5);
    let fp = out.fingerprint().expect("hashed elements get a record");

    assert_eq!(fp.express_id, 4242, "the record is keyed by the element id");
    assert_eq!(fp.hash, 0xDEAD_BEEF_0000_0001);
    assert_eq!(fp.aabb, Some(aabb));
    assert_eq!(fp.volume, Some(7.25));
    assert_eq!(fp.closure_bits, 5);
}

/// A volume is `Some` only for a provably closed single solid, so `None` is
/// the normal case and must NOT suppress the record or collapse to `0.0` — a
/// zero volume is a real measurement and would read as a degenerate solid.
#[test]
fn an_unmeasured_volume_stays_absent_rather_than_becoming_zero() {
    let fp = output(Some(9), Some([0.0; 6]), None, 0)
        .fingerprint()
        .expect("a hash is present, so the record is emitted");
    assert_eq!(fp.volume, None, "absent is not 0.0 m³");
    assert_eq!(fp.closure_bits, 0, "nothing hashed closed ⇒ no closure bits");
}

/// A group the collator refuses (a #3666 reconstruction failure, a singular
/// placement, a shape mismatch) lands in `Collated::flat_indices`, and the IFNS
/// encoder turns each entry there into a ONE-INSTANCE template. That is the
/// orbit-FPS regression `INSTANCE_MIN_OCCURRENCES` exists to prevent, arriving
/// through a safety check instead of a tuning mistake. The partition takes those
/// members back for its flat MeshCollection; this pins which ones it takes.
#[test]
fn rejected_members_are_taken_back_for_the_flat_path_and_sorted() {
    use crate::api::gpu_meshes::batch_partition::rejected_to_flat;

    // `refs` is the 5 materialized meshes, then the pose-only placeholders at
    // 5.. . `flat_indices` arrives in per-GROUP order, not mesh order.
    assert_eq!(rejected_to_flat(&[3, 0, 4], 5), vec![0, 3, 4], "sorted for lookup");
    // A placeholder index (>= materialized) is not a mesh that can be drawn flat,
    // so it is never taken back. The collator does not put one in `flat_indices`;
    // the bound is what makes that a guarantee here rather than an assumption.
    assert_eq!(rejected_to_flat(&[6, 1, 5], 5), vec![1]);
    // Nothing refused: nothing leaves the shard.
    assert_eq!(rejected_to_flat(&[], 5), Vec::<usize>::new());
}

// #7782 / #8317: the canonical producer can compute a fingerprint while a
// scheduler adapter loses it. Check the actual public flat output, not only
// ElementMeshOutput::fingerprint or native/browser mesh payload parity.
#[test]
fn c4_10b_public_flat_batch_retains_diff_metadata_8317() {
    let source = include_bytes!("../../../../processing/tests/fixtures/c4_0_refusal_parity_7782.ifc");
    let api = crate::api::IfcAPI::new();
    let pre = api.build_prepass_once_data(source);
    api.set_compute_geometry_hashes(Some(1e-5));
    let mut jobs = vec![0; pre.total_jobs() * 3];
    pre.write_jobs(|i, v| jobs[i as usize] = v);
    let flat = api.process_geometry_batch(
        source, &jobs, 1.0, 10.0, 20.0, 30.0, true,
        &pre.void_keys, &pre.void_counts, &pre.void_values,
        &pre.style_ids, &pre.style_colors,
        Some(pre.meta.plane_angle_to_radians), None, None, None,
    );
    assert_eq!(flat.length(), 1, "valid neighbour survives refused leaves");
    assert!(flat.total_triangles() > 0);
    assert_eq!(flat.get(0).unwrap().express_id(), 300);
    assert_eq!(flat.geometry_hash_count(), 1, "diff metadata survives output routing");
}
