// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::processors::BlockProcessor;
use ifc_lite_core::EntityDecoder;

fn inputs() -> (Mesh, Vec<Mesh>) {
    let source = "#1=IFCBLOCK($,2.,2.,2.);#2=IFCBLOCK($,1.,1.,2.);\
        #3=IFCCARTESIANPOINT((0.5,0.,0.));#4=IFCAXIS2PLACEMENT3D(#3,$,$);\
        #5=IFCBLOCK(#4,1.,1.,2.);".to_owned();
    let mut decoder = EntityDecoder::new(&source);
    let meshes: Vec<_> = [1,2,5].into_iter().map(|id| {
        let entity = decoder.decode_by_id(id).unwrap();
        BlockProcessor::new().lower(&entity, &mut decoder).unwrap().evaluate()
    }).collect();
    let mut meshes = meshes.into_iter();
    (meshes.next().unwrap(), meshes.collect())
}

#[test]
fn decoder_free_group_cut_removes_overlapping_cutters_union_once() {
    let (host, prisms) = inputs();
    let recorder = NumericalEffects::default();
    let result = recorder.evaluate_polygonal_group(host, prisms, 1., 0).unwrap()
        .expect("two valid overlapping partial cuts form a usable group").0;
    // Host volume8; two volume2 cuts overlap by volume1, leaving volume5.
    assert!((crate::kernel::mesh_volume::mesh_volume(&result).abs() - 5.).abs() < 1e-5);
    assert!(recorder.take_failures().is_empty());
}

#[test]
fn unavailable_union_rewinds_provisional_records_and_retains_its_unique_failure() {
    let (host, _) = inputs();
    let recorder = NumericalEffects::default();
    recorder.record_failure(BoolOp::Unknown, BoolFailureReason::EmptyOperand);
    let prior = recorder.failure_mark();
    recorder.record_failure(BoolOp::Difference, BoolFailureReason::EmptyOperand);
    let result = recorder.evaluate_polygonal_group(host, vec![Mesh::new()], 1., prior).unwrap();
    assert!(result.is_none(), "an empty cutter cannot certify a grouped cut");
    let records = recorder.take_failures();
    assert_eq!(records.len(), 2, "sequential execution re-encounters provisional records, but never attempts this union");
    assert_eq!(records[0], crate::BoolFailure::new(BoolOp::Unknown, BoolFailureReason::EmptyOperand));
    assert_eq!(records[1], crate::BoolFailure::new(BoolOp::Union, BoolFailureReason::CutterUnionUnavailable));
}

#[test]
fn full_host_trial_defers_and_rewinds_only_the_provisional_range() {
    let (host, _) = inputs();
    let cutter = host.clone();
    let recorder = NumericalEffects::default();
    recorder.record_failure(BoolOp::Unknown, BoolFailureReason::EmptyOperand);
    let mark = recorder.failure_mark();
    recorder.record_failure(BoolOp::Difference, BoolFailureReason::EmptyOperand);
    let result = recorder.evaluate_polygonal_group(host, vec![cutter], 1., mark).unwrap();
    assert!(result.is_none(), "a full-removal trial requires sequential recovery");
    assert_eq!(recorder.take_failures(), vec![crate::BoolFailure::new(
        BoolOp::Unknown, BoolFailureReason::EmptyOperand)]);
}
