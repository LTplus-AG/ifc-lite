// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#![cfg(feature = "csg_capture")]

//! #6940: capture the real kernel hooks and replay both weld policies. Keep
//! this in its own test process: enabling global capture in a library test
//! would also clone unrelated cuts being exercised by concurrent tests.

use ifc_lite_geometry::csg::{ClippingProcessor, GroupCut};
use ifc_lite_geometry::csg_capture::{self, CapturedCsgJob};
use ifc_lite_geometry::kernel::mesh_bridge::{subtract_many, BatchSubtract};
use ifc_lite_geometry::{extrude_profile, Mesh, Point2, Profile2D};

struct Recording;
impl Recording {
    fn start() -> Self {
        drop(csg_capture::drain());
        csg_capture::set_enabled(true);
        Self
    }
}
impl Drop for Recording {
    fn drop(&mut self) {
        csg_capture::set_enabled(false);
    }
}

fn payload(result: GroupCut) -> Option<(Vec<f32>, Vec<u32>)> {
    result.into_mesh().map(|m| (m.positions, m.indices))
}

/// The opening fills one profile hole; another hole's wall is two kernel
/// steps off collinear. Plain welding drags the extended cutter off its own
/// wall, while opening welding preserves it. This is the fixture-free #6940
/// witness, shared in shape with the public subtraction policy regressions.
fn operands() -> (Mesh, Mesh) {
    let pt = |x, y| Point2::new(x, y);
    let mut profile = Profile2D::new(vec![pt(0., 0.), pt(8., 0.), pt(8., 8.), pt(0., 8.)]);
    profile.add_hole(vec![pt(1., 1.), pt(1., 2.), pt(2., 2.), pt(2., 1.)]);
    profile.add_hole(vec![
        pt(1., 3.),
        pt(1. + 2. / 65536., 5.),
        pt(2., 5.),
        pt(2., 3.),
    ]);
    let host = extrude_profile(&profile, 0.25, None).unwrap();
    let cutter_profile = Profile2D::new(vec![pt(1., 1.), pt(2., 1.), pt(2., 2.), pt(1., 2.)]);
    let mut cutter = extrude_profile(&cutter_profile, 0.45, None).unwrap();
    for p in cutter.positions.chunks_exact_mut(3) {
        p[2] -= 0.1;
    }
    (host, cutter)
}

#[test]
fn issue_6940_capture_and_serialized_replay_preserve_single_and_batch_weld_policies() {
    let (host, cutter) = operands();
    let csg = ClippingProcessor::new();
    let recording = Recording::start();
    let plain_single = payload(csg.subtract_operand(&host, &cutter));
    let opening_single = payload(csg.subtract_mesh(&host, &cutter));
    let plain_batch = subtract_many(&host, &[&cutter]);
    let opening_batch = payload(csg.subtract_mesh_many(&host, &[&cutter]));
    drop(recording);
    let captured = csg_capture::drain();
    assert_eq!(captured.len(), 4, "one captured job per kernel call");
    assert!(matches!(
        &captured[0],
        CapturedCsgJob::Single { opening: false, .. }
    ));
    assert!(matches!(
        &captured[1],
        CapturedCsgJob::Single { opening: true, .. }
    ));
    assert!(matches!(
        &captured[2],
        CapturedCsgJob::Many { opening: false, retain_miss: false, .. }
    ));
    assert!(matches!(
        &captured[3],
        CapturedCsgJob::Many { opening: true, retain_miss: false, .. }
    ));

    let blob = csg_capture::serialize(&captured);
    let decoded = csg_capture::deserialize(&blob).unwrap();
    assert_ne!(
        plain_single, opening_single,
        "witness must distinguish single policies"
    );
    assert_eq!(payload(decoded[0].replay(&csg)), plain_single);
    assert_eq!(payload(decoded[1].replay(&csg)), opening_single);
    let replayed_plain_batch = payload(decoded[2].replay(&csg));
    assert_eq!(
        replayed_plain_batch.is_some(),
        matches!(plain_batch, BatchSubtract::Cut(_)),
        "ordinary batch replay must retain the kernel's cut classification"
    );
    assert_eq!(payload(decoded[3].replay(&csg)), opening_batch);
    assert_ne!(
        replayed_plain_batch, opening_batch,
        "witness must distinguish batch policies after validation/consolidation"
    );

    // Unversioned captures may contain either policy with identical tags.
    // Refuse them instead of silently interpreting every cut as an opening.
    assert!(csg_capture::deserialize(&blob[4..]).is_err());
    let mut old_policy_blob = blob.clone();
    old_policy_blob[..4].copy_from_slice(b"CSG2");
    assert!(csg_capture::deserialize(&old_policy_blob).is_err(),
        "CSG2 did not record whether a conforming miss was retained");
    assert!(csg_capture::deserialize(&blob[..blob.len() - 1]).is_err());
    let mut trailing = blob;
    trailing.push(0);
    assert!(csg_capture::deserialize(&trailing).is_err());
}
