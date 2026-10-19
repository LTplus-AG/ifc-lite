// SPDX-License-Identifier: MPL-2.0
//! The consuming finish stage observes terminal state before mesh hygiene.
use super::*;
use crate::resource::{ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};

fn finish() -> ReadyFinish {
    let mut decoder = EntityDecoder::new("#1=IFCBLOCK($,2.,3.,4.);");
    let block = decoder.decode_by_id(1).unwrap();
    let mut mesh = crate::processors::BlockProcessor::new()
        .lower(&block, &mut decoder).unwrap().evaluate();
    mesh.indices.extend_from_slice(&[0, 0, 0]);
    ReadyFinish { part: HostPart { mesh, id: None }, output: Output::Parts(Vec::new()) }
}

#[test]
fn stopped_void_finish_preserves_degenerate_mesh_before_cleanup() {
    // Inner-program review: an issued finish must stop before degenerate work.
    let mut stopped = finish();
    let original = stopped.part.mesh.indices.clone();
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    account.cancel();
    let result = account.scope(|| stopped.clean_part());
    assert!(matches!(result, Err(crate::Error::ProgramStopped(ProgramStop::Cancelled))));
    assert_eq!(stopped.part.mesh.indices, original, "terminal cleanup does no mesh work");

    // Positive control: this actual mesh contains a triangle the stage removes.
    let mut admitted = finish();
    admitted.clean_part().unwrap();
    assert_eq!(admitted.part.mesh.indices.len() + 3, original.len());
    let Output::Parts(parts) = admitted.execute().unwrap() else { panic!("parts output") };
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0].triangle_count(), 12);
}

#[test]
fn void_finish_retains_each_closed_subgrid_component() {
    // The common finish must preserve every represented closed boundary.
    use crate::kernel::{arrangement::box_mesh, mesh_bridge::tris_to_mesh};
    let edge = crate::kernel::mesh_bridge::SNAP_GRID / 4.;
    let mut mesh = tris_to_mesh(&box_mesh([0.; 3], [1.; 3]));
    mesh.merge(&tris_to_mesh(&box_mesh([2., 0., 0.], [2. + edge, edge, edge])));
    assert!(crate::exact_topology::strict_closed_mesh(&mesh));
    assert_eq!(mesh.triangle_count(), 24);
    let mut ordinary = mesh.clone();
    ordinary.clean_degenerate_watertight();
    assert_eq!(ordinary.triangle_count(), 12, "ordinary cleanup loses the closed small component");
    let Output::Parts(parts) = (ReadyFinish {
        part: HostPart { mesh, id: None }, output: Output::Parts(Vec::new()),
    }).execute().unwrap() else { panic!("parts output") };
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0].triangle_count(), 24);
    assert!(crate::exact_topology::strict_closed_mesh(&parts[0]));
}
