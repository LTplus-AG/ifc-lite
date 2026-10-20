// SPDX-License-Identifier: MPL-2.0
use super::*;

// Representation limits are tested without constructing infeasible buffers.
#[test]
fn impossible_mesh_lengths_refuse_before_allocating() {
    let impossible = MeshLengths {
        positions: usize::MAX,
        ..MeshLengths::default()
    };
    assert_eq!(impossible.bytes(), Err(MeshAdmissionError::Representation));
    let portable_limit = MeshLengths {
        indices: i32::MAX as usize / 4 + 1,
        ..MeshLengths::default()
    };
    assert_eq!(
        portable_limit.bytes_with_limit(i32::MAX as usize),
        Err(MeshAdmissionError::Representation)
    );
    assert!(preflight_merge(impossible, MeshLengths::default(), None).is_err());
    assert!(preflight_merge_with_limit(
        MeshLengths::default(),
        portable_limit,
        None,
        i32::MAX as usize
    )
    .is_err());
    if let Some(positions) = (u32::MAX as usize)
        .checked_add(1)
        .and_then(|n| n.checked_mul(3))
    {
        let too_many_vertices = MeshLengths {
            positions,
            ..MeshLengths::default()
        };
        assert_eq!(
            too_many_vertices.bytes(),
            Err(MeshAdmissionError::Representation)
        );
    }
    if usize::BITS > 32 {
        assert_eq!(portable_limit.bytes(), Ok((i32::MAX as u64 / 4 + 1) * 4));
    }
    let offset = MeshLengths {
        positions: 3,
        ..MeshLengths::default()
    };
    assert!(preflight_merge(offset, MeshLengths::default(), Some(u32::MAX)).is_err());
    // The portable representation cap applies per backing vector; independent
    // valid vectors are not silently given an extra combined representation cap.
    let independent = MeshLengths {
        positions: 400_000_000,
        normals: 400_000_000,
        ..MeshLengths::default()
    };
    assert_eq!(
        independent.bytes_with_limit(i32::MAX as usize),
        Ok(3_200_000_000)
    );
}

fn triangle(origin: [f64; 3]) -> Mesh {
    let mut mesh = Mesh::new();
    mesh.positions = vec![0., 0., 0., 1., 0., 0., 0., 1., 0.];
    mesh.normals = vec![0., 0., 1., 0., 0., 1., 0., 0., 1.];
    mesh.indices = vec![0, 1, 2];
    mesh.origin = origin;
    mesh
}

// Checked preparation delegates to the canonical merge, retaining frame and
// index ordering instead of introducing a second numerical implementation.
#[test]
fn small_reserved_merge_keeps_ordered_geometry_and_frame() {
    let incoming = triangle([11., 20., 30.]);
    let mut actual = triangle([10., 20., 30.]);
    let mut expected = actual.clone();
    expected.merge(&incoming);
    reserve_merge(&mut actual, &incoming).unwrap();
    actual.merge(&incoming);
    assert_eq!(actual.positions, expected.positions);
    assert_eq!(actual.normals, expected.normals);
    assert_eq!(actual.indices, vec![0, 1, 2, 3, 4, 5]);
    assert_eq!(actual.origin, expected.origin);
}

#[test]
fn failed_index_preflight_does_not_touch_small_destination() {
    let mut target = triangle([10., 20., 30.]);
    let mut incoming = triangle([40., 50., 60.]);
    incoming.indices[0] = u32::MAX;
    let before = target.clone();
    assert_eq!(
        reserve_merge(&mut target, &incoming),
        Err(MeshAdmissionError::Representation)
    );
    assert_eq!(target.positions, before.positions);
    assert_eq!(target.normals, before.normals);
    assert_eq!(target.indices, before.indices);
    assert_eq!(target.origin, before.origin);
    assert_eq!(target.positions.capacity(), before.positions.capacity());
}

#[test]
fn reserved_clone_retains_all_mesh_metadata_and_planes() {
    let mut source = triangle([10., 20., 30.]);
    source.rtc_applied = true;
    source.local_bounds = Some([0., 0., 0., 1., 1., 0.]);
    source.local_to_world = Some([2.; 16]);
    source.welded_in_object_frame = true;
    source.plane_tags = Some(vec![PlaneTag {
        n: [0., 0., 1.],
        d: 3.,
    }]);
    let cloned = clone_reserved(&source).unwrap();
    assert_eq!(cloned.positions, source.positions);
    assert_eq!(cloned.normals, source.normals);
    assert_eq!(cloned.indices, source.indices);
    assert_eq!(cloned.plane_tags, source.plane_tags);
    assert_eq!(cloned.local_bounds, source.local_bounds);
    assert_eq!(cloned.local_to_world, source.local_to_world);
    assert_eq!(cloned.origin, source.origin);
    assert!(cloned.rtc_applied && cloned.welded_in_object_frame);
    assert_eq!(
        MeshLengths::of(&source).bytes().unwrap(),
        84 + std::mem::size_of::<PlaneTag>() as u64
    );
}

// Probe is at the actual fallible reservation boundary, before destination
// buffers exist. Refused quota must not reach it, even after a caught error.
#[test]
fn bounded_copy_and_merge_refuse_before_reserving_or_copying() {
    use crate::resource::{Dimension, ExecutionAccount, ExecutionPolicy, ResourceLimits};
    for dimension in [
        Dimension::CopyBytes,
        Dimension::OutputBytes,
        Dimension::Work,
    ] {
        for merge in [false, true] {
            let mut limits = ResourceLimits::default();
            match dimension {
                Dimension::CopyBytes => limits.copy_bytes = Some(0),
                Dimension::OutputBytes => limits.output_bytes = Some(0),
                Dimension::Work => limits.work = Some(0),
                _ => unreachable!(),
            }
            let account = ExecutionAccount::new(ExecutionPolicy::Bounded(limits));
            let source = triangle([0.; 3]);
            let mut destination = Mesh::new();
            RESERVE_EVENTS.with(|events| events.set(0));
            account.scope(|| {
                let failure = if merge {
                    merge_mesh(&mut destination, &source).unwrap_err()
                } else {
                    clone_mesh(&source).unwrap_err()
                };
                assert!(matches!(failure, ProgramStop::ResourceRefused(ref refusal)
                    if refusal.dimension == dimension));
                assert_eq!(super::super::check_current(), Err(failure));
            });
            RESERVE_EVENTS.with(|events| assert_eq!(events.get(), 0));
            assert!(destination.positions.is_empty());
            assert_eq!(destination.positions.capacity(), 0);
        }
    }
}

#[test]
fn admitted_merge_and_clone_residency_tracks_payload_drop_without_refunding_copy() {
    use crate::resource::{ExecutionAccount, ExecutionPolicy, ResourceLimits};
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let source = triangle([0.; 3]);
    account.scope(|| {
        let (cloned, clone_permit) = clone_mesh(&source).unwrap();
        assert_eq!(cloned.indices, source.indices);
        assert_eq!(account.usage().copy_bytes, 84);
        assert_eq!(account.usage().live_bytes, 84);
        let mut target = Mesh::new();
        let merge_permit = merge_mesh(&mut target, &source).unwrap();
        assert_eq!(target.positions, source.positions);
        assert_eq!(account.usage().live_bytes, 168);
        drop((cloned, clone_permit));
        assert_eq!(account.usage().live_bytes, 84);
        drop((target, merge_permit));
        assert_eq!(account.usage().live_bytes, 0);
        assert_eq!(account.usage().copy_bytes, 168);
    });
}

// Mesh::merge ignores a geometry-empty instance placeholder, including any
// unused normals/indices it might carry. Only its caller charges occurrence.
#[test]
fn empty_merge_never_reserves_or_charges_ignored_payload() {
    use crate::resource::{ExecutionAccount, ExecutionPolicy, ResourceLimits};
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        work: Some(0),
        copy_bytes: Some(0),
        output_bytes: Some(0),
        live_bytes: Some(0),
        ..ResourceLimits::default()
    }));
    let mut placeholder = Mesh::new();
    placeholder.indices.push(u32::MAX);
    placeholder.normals = vec![1.; 3];
    let mut target = triangle([10., 20., 30.]);
    let original = target.clone();
    RESERVE_EVENTS.with(|events| events.set(0));
    account.scope(|| drop(merge_mesh(&mut target, &placeholder).unwrap()));
    assert_eq!(target.positions, original.positions);
    assert_eq!(target.indices, original.indices);
    assert_eq!(account.usage().copy_bytes, 0);
    RESERVE_EVENTS.with(|events| assert_eq!(events.get(), 0));
}
