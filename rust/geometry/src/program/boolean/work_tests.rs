// SPDX-License-Identifier: MPL-2.0
//! Round-one common boolean program: actual numeric work survives source disposal.
use super::work::{self, Execute};
use crate::processors::{BlockProcessor, BooleanClippingProcessor};
use crate::processors::boolean::{half_space_plan::HalfSpacePlan, OperandPath, MAX_OPERAND_VISITS};
use crate::{BoolFailure, BoolFailureReason, BoolOp, GeometryProcessor, Mesh, TessellationQuality};
use ifc_lite_core::{EntityDecoder, IfcSchema};
use crate::kernel::mesh_volume::mesh_volume;
use crate::resource::{ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};

fn block(decoder: &mut EntityDecoder, id: u32) -> Mesh {
    let entity = decoder.decode_by_id(id).unwrap();
    BlockProcessor::new().lower(&entity, decoder).unwrap().evaluate()
}

#[test]
fn plane_prism_and_single_cutter_use_only_admitted_inputs_after_source_disposal() {
    let recorder = BooleanClippingProcessor::new();
    let (host, plane, prism) = {
        let source = "#1=IFCBLOCK($,2.,2.,2.);
#2=IFCCARTESIANPOINT((0.,0.,1.));#3=IFCAXIS2PLACEMENT3D(#2,$,$);
#4=IFCPLANE(#3);#5=IFCPOLYGONALBOUNDEDHALFSPACE(#4,.F.,#3,#10);
#6=IFCCARTESIANPOINT((-1.,-1.));#7=IFCCARTESIANPOINT((3.,-1.));
#8=IFCCARTESIANPOINT((3.,3.));#9=IFCCARTESIANPOINT((-1.,3.));
#10=IFCPOLYLINE((#6,#7,#8,#9,#6));".to_owned();
        let mut decoder = EntityDecoder::new(&source);
        let cutter = decoder.decode_by_id(5).unwrap();
        let plane = HalfSpacePlan::lower(&cutter, &mut decoder).unwrap();
        let prism = recorder.lower_bounded_prism(&cutter, &mut decoder,
            TessellationQuality::Medium).unwrap().unwrap();
        (block(&mut decoder, 1), plane, prism)
    };
    let (plane_cut, _) = work::Plane { host: host.clone(), plane, fallback: false }
        .execute(&recorder.effects).assemble(&recorder).unwrap();
    assert!((mesh_volume(&plane_cut).abs() - 4.).abs() < 1e-6);
    let (host, cutter) = work::Prism { host, plane, plan: prism }.execute(&recorder.effects).assemble(&recorder);
    let cutter = cutter.unwrap();
    assert!(!cutter.is_empty());
    let work::SingleResult::Done((cut, lost)) = work::Single { host, cutter, plane,
        solo_step: true, length_unit_scale: 1. }.execute(&recorder.effects).assemble_single(&recorder).unwrap()
        else { panic!("a valid full-cross-section prism must cut") };
    assert!(!lost);
    assert!((mesh_volume(&cut).abs() - 4.).abs() < 1e-5);
    assert_eq!(cut.bounds().1.z, 1.);
    assert!(recorder.take_failures().is_empty());
}

#[test]
fn grouped_completion_rolls_back_only_provisional_records_and_publishes_unique_loss() {
    let host = block(&mut EntityDecoder::new("#1=IFCBLOCK($,2.,2.,2.);"), 1);
    let recorder = BooleanClippingProcessor::new();
    let prior = BoolFailure::new(BoolOp::Unknown, BoolFailureReason::EmptyOperand);
    recorder.absorb_failures(vec![prior.clone()]);
    let mark = recorder.failure_mark();
    recorder.record_failure(BoolOp::Difference, BoolFailureReason::EmptyOperand);
    let completed = work::Group { base: host, prisms: vec![Mesh::new()], length_unit_scale: 1. }.execute(&recorder.effects);
    assert_eq!(recorder.failure_mark(), 2, "execution cannot publish or rewind the actual sink");
    assert!(completed.assemble_group(&recorder, mark).unwrap().is_none());
    assert_eq!(recorder.take_failures(), vec![prior,
        BoolFailure::new(BoolOp::Union, BoolFailureReason::CutterUnionUnavailable)]);
}

#[test]
fn successful_group_completion_preserves_prior_records_and_exact_union_volume() {
    let (host, prisms) = {
        let mut decoder = EntityDecoder::new("#1=IFCBLOCK($,2.,2.,2.);#2=IFCBLOCK($,1.,1.,2.);
#3=IFCCARTESIANPOINT((0.5,0.,0.));#4=IFCAXIS2PLACEMENT3D(#3,$,$);#5=IFCBLOCK(#4,1.,1.,2.);");
        (block(&mut decoder, 1), vec![block(&mut decoder, 2), block(&mut decoder, 5)])
    };
    let recorder = BooleanClippingProcessor::new();
    recorder.record_failure(BoolOp::Unknown, BoolFailureReason::EmptyOperand);
    let mark = recorder.failure_mark();
    let (cut, lost) = work::Group { base: host, prisms, length_unit_scale: 1. }
        .execute(&recorder.effects).assemble_group(&recorder, mark).unwrap().unwrap();
    assert!(!lost);
    assert!((mesh_volume(&cut).abs() - 5.).abs() < 1e-5);
    assert_eq!(recorder.failure_mark(), mark);
}

#[test]
fn terminal_group_acceptance_keeps_provisional_and_reached_numerical_records() {
    // Full-removal geometry really defers. The empty-cutter variant also
    // produces the actual unique union failure that acceptance must retain.
    for empty_cutter in [false, true] {
        let host = block(&mut EntityDecoder::new("#1=IFCBLOCK($,2.,2.,2.);"), 1);
        assert!((mesh_volume(&host).abs() - 8.).abs() < 1e-6);
        let cutter = if empty_cutter { Mesh::new() } else { host.clone() };
        if !empty_cutter { assert!((mesh_volume(&cutter).abs() - 8.).abs() < 1e-6); }
        let control = BooleanClippingProcessor::new();
        assert!(work::Group { base: host.clone(), prisms: vec![cutter.clone(), cutter.clone()],
            length_unit_scale: 1. }.execute(&control.effects)
            .assemble_group(&control, 0).unwrap().is_none());
        let numerical = control.take_failures();
        assert_eq!(numerical, if empty_cutter {
            vec![BoolFailure::new(BoolOp::Union, BoolFailureReason::CutterUnionUnavailable)]
        } else { Vec::new() });

        let recorder = BooleanClippingProcessor::new();
        let prior = BoolFailure::new(BoolOp::Unknown, BoolFailureReason::EmptyOperand);
        let provisional = BoolFailure::new(BoolOp::Difference, BoolFailureReason::EmptyOperand);
        recorder.absorb_failures(vec![prior.clone()]);
        let mark = recorder.failure_mark();
        recorder.absorb_failures(vec![provisional.clone()]);
        let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
        let result = account.scope(|| {
            let completed = work::Group { base: host, prisms: vec![cutter.clone(), cutter],
                length_unit_scale: 1. }.execute(&recorder.effects);
            assert_eq!(recorder.failure_mark(), 2, "numerics have not published or rewound");
            crate::resource::stop(ProgramStop::Cancelled);
            completed.assemble_group(&recorder, mark)
        });
        assert!(matches!(result, Err(crate::Error::ProgramStopped(ProgramStop::Cancelled))));
        let mut expected = vec![prior, provisional];
        expected.extend(numerical);
        assert_eq!(recorder.take_failures(), expected,
            "terminal acceptance cannot apply ordinary deferral rollback");
    }
}

#[test]
fn terminal_single_acceptance_cannot_publish_fallback_or_drop_reached_records() {
    let host = block(&mut EntityDecoder::new("#1=IFCBLOCK($,2.,2.,2.);"), 1);
    assert!((mesh_volume(&host).abs() - 8.).abs() < 1e-6);
    let plane = HalfSpacePlan { point: crate::Point3::new(0., 0., 1.),
        normal: crate::Vector3::new(0., 0., 1.), agreement: false };
    let control = BooleanClippingProcessor::new();
    // Subtracting the complete real host produces an empty bounded result,
    // which genuinely requests the plane fallback in the unstopped case.
    let work::SingleResult::Fallback(uncut) = work::Single {
        host: host.clone(), cutter: host.clone(), plane, solo_step: true,
        length_unit_scale: 1. }.execute(&control.effects).assemble_single(&control).unwrap()
        else { panic!("full bounded removal must request recovery") };
    assert!((mesh_volume(&uncut).abs() - 8.).abs() < 1e-6);
    let numerical = control.take_failures();
    let recorder = BooleanClippingProcessor::new();
    let prior = BoolFailure::new(BoolOp::Unknown, BoolFailureReason::EmptyOperand);
    let provisional = BoolFailure::new(BoolOp::Difference, BoolFailureReason::EmptyOperand);
    recorder.absorb_failures(vec![prior.clone(), provisional.clone()]);
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let result = account.scope(|| {
        let completed = work::Single { cutter: host.clone(), host, plane,
            solo_step: true, length_unit_scale: 1. }.execute(&recorder.effects);
        assert_eq!(recorder.failure_mark(), 2, "numerics have not published effects");
        crate::resource::stop(ProgramStop::Cancelled);
        completed.assemble_single(&recorder)
    });
    assert!(matches!(result, Err(crate::Error::ProgramStopped(ProgramStop::Cancelled))));
    let mut expected = vec![prior, provisional];
    expected.extend(numerical);
    let actual = recorder.take_failures();
    assert_eq!(actual, expected);
    assert!(!actual.iter().any(|record| matches!(&record.reason,
        BoolFailureReason::PolygonalBoundedHalfSpaceFallback)),
        "a terminal cannot admit the recovery plane operation");
}

#[test]
fn shared_csg_dag_reenters_each_occurrence_and_spends_each_boolean_visit() {
    let source = "#1=IFCBLOCK($,2.,2.,2.);
#3=IFCCARTESIANPOINT((2.,0.,0.));#4=IFCAXIS2PLACEMENT3D(#3,$,$);#2=IFCBLOCK(#4,1.,1.,1.);
#21=IFCBOOLEANRESULT(.UNION.,#1,#2);#20=IFCCSGSOLID(#21);
#30=IFCBOOLEANRESULT(.UNION.,#1,#20);#31=IFCBOOLEANRESULT(.UNION.,#30,#20);";
    let mut decoder = EntityDecoder::new(source);
    let entity = decoder.decode_by_id(31).unwrap();
    let recorder = BooleanClippingProcessor::new();
    let mut path = OperandPath::default();
    let (mesh, lost) = recorder.process_with_depth(&entity, &mut decoder, &IfcSchema::new(),
        0, TessellationQuality::Medium, &mut path).unwrap();
    assert!(!lost);
    assert!((mesh_volume(&mesh).abs() - 9.).abs() < 1e-6);
    assert_eq!(path.len(), 0, "shared CSG occurrence memberships must exit");
    // Root #31 plus two entered #21 occurrences. #30 is a spine node.
    for _ in 0..MAX_OPERAND_VISITS - 3 { assert!(path.charge()); }
    assert!(!path.charge(), "each shared occurrence spends a visit");
    assert!(recorder.take_bool_failures().is_empty());
}

#[test]
fn round_two_common_path_preserves_ordered_losses_and_host_geometry() {
    let mut decoder = EntityDecoder::new("#1=IFCBLOCK($,2.,2.,2.);
#2=IFCCARTESIANPOINT((0.,0.,0.));
#10=IFCBOOLEANRESULT(.MYSTERY.,#1,$);
#11=IFCBOOLEANRESULT(.UNION.,#10,#2);
#12=IFCBOOLEANRESULT(.DIFFERENCE.,#11,$);");
    let root = decoder.decode_by_id(12).unwrap();
    let recorder = BooleanClippingProcessor::new();
    let mut path = OperandPath::default();
    let (mesh, lost) = recorder.execute_boolean(&root, &mut decoder, 0,
        TessellationQuality::Medium, &mut path).unwrap();
    assert!(!lost);
    assert!((mesh_volume(&mesh).abs() - 8.).abs() < 1e-6);
    assert_eq!(recorder.take_failures(), vec![
        BoolFailure::new(BoolOp::Unknown,
            BoolFailureReason::UnknownBooleanOperator("MYSTERY".into())),
        BoolFailure::new(BoolOp::Union,
            BoolFailureReason::UnsupportedOperand("IfcCartesianPoint".into())),
        BoolFailure::new(BoolOp::Difference, BoolFailureReason::EmptyOperand),
    ]);
    assert_eq!(path.len(), 0);
}

#[test]
fn numerical_unwind_keeps_prior_and_reached_plane_losses_in_order() {
    // Preservation invariant: an unwind after real clipping cannot erase a
    // diagnostic the same operation already produced in the direct recorder.
    struct UnwindAfterPlane(work::Plane);
    impl Execute for UnwindAfterPlane {
        type Output = ();
        fn evaluate(self, effects: &crate::processors::boolean::NumericalEffects) {
            let (cut, lost) = self.0.evaluate(effects).unwrap();
            assert!(!lost);
            assert!((mesh_volume(&cut).abs() - 4.).abs() < 1e-6);
            std::panic::panic_any("after real plane clipping");
        }
    }
    let host = block(&mut EntityDecoder::new("#1=IFCBLOCK($,2.,2.,2.);"), 1);
    let plane = HalfSpacePlan {
        point: crate::Point3::new(0., 0., 1.),
        normal: crate::Vector3::new(0., 0., 1.),
        agreement: false,
    };
    let recorder = BooleanClippingProcessor::new();
    let prior = BoolFailure::new(BoolOp::Unknown, BoolFailureReason::EmptyOperand);
    recorder.absorb_failures(vec![prior.clone()]);
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        UnwindAfterPlane(work::Plane { host, plane, fallback: true })
            .execute(&recorder.effects);
    })).unwrap_err();
    assert_eq!(panic.downcast_ref::<&str>(), Some(&"after real plane clipping"));
    assert_eq!(recorder.take_failures(), vec![prior,
        BoolFailure::new(BoolOp::Difference,
            BoolFailureReason::PolygonalBoundedHalfSpaceFallback)]);
}
