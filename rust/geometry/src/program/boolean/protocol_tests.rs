// SPDX-License-Identifier: MPL-2.0
//! Real work at suspended source/effect boundaries, with rejected linear replies.
use super::*;
use super::super::state::Steps;
use crate::{BoolFailureReason, BoolOp, Mesh, Point3, Vector3};
use crate::kernel::mesh_volume::mesh_volume;
use crate::processors::{BlockProcessor, boolean::half_space_plan::HalfSpacePlan};

fn host() -> Mesh {
    let mut decoder = EntityDecoder::new("#1=IFCBLOCK($,2.,2.,2.);");
    let entity = decoder.decode_by_id(1).unwrap();
    BlockProcessor::new().lower(&entity, &mut decoder).unwrap().evaluate()
}
fn step(entity: DecodedEntity) -> BooleanProgram {
    BooleanProgram::with_path(Default::default(), TessellationQuality::Medium,
        Frame::Steps(Steps { nodes: vec![entity], depth: 0, solo_step: true,
            mesh: host(), retained:None, empty_recorded: false }))
}
fn source(program: &mut BooleanProgram, recorder: &BooleanClippingProcessor,
    decoder: &mut EntityDecoder,
) {
    let BooleanPoll::Source(ticket) = program.request().unwrap() else { panic!("expected source") };
    let reply = program.execute_source(ticket, recorder, decoder).unwrap();
    program.accept_source(reply, recorder).unwrap_or_else(|_| panic!("own source rejected")).unwrap();
}

#[test]
fn inner_boolean_source_rejection_preserves_reply_and_defers_reached_effects() {
    let mut decoder = EntityDecoder::new("#9=IFCBOOLEANRESULT(.UNRECOGNIZED.,$,$);");
    let root = decoder.decode_by_id(9).unwrap();
    let recorder = BooleanClippingProcessor::new();
    recorder.record_failure(BoolOp::Difference, BoolFailureReason::EmptyOperand);
    let mut program = step(root.clone());
    let mut foreign = step(root);
    let BooleanPoll::Source(ticket) = program.request().unwrap() else { panic!("source") };
    let reply = program.execute_source(ticket, &recorder, &mut decoder).unwrap();
    assert_eq!(recorder.failure_mark(), 1, "source execution cannot publish its effect");
    assert!(program.execute_source(ticket, &recorder, &mut decoder).is_err(), "identity cannot reexecute");
    let reply = *foreign.accept_source(reply, &recorder).err().expect("wrong program returns reply");
    assert_eq!(recorder.failure_mark(), 1);
    program.accept_source(reply, &recorder).unwrap_or_else(|_| panic!("valid reply")).unwrap();
    assert_eq!(recorder.failure_mark(), 2);
    let (mesh, lost) = program.drain(&recorder, &mut decoder).unwrap();
    assert!(!lost);
    assert!((mesh_volume(&mesh).abs() - 8.).abs() < 1e-6);
    assert_eq!(recorder.take_failures().len(), 2, "one source acceptance publishes once");
}

#[test]
fn inner_boolean_wrong_sequence_and_kind_numerical_replies_publish_no_effects() {
    let recorder = BooleanClippingProcessor::new();
    let steps = Steps { nodes: Vec::new(), depth: 0, solo_step: true,
        mesh: Mesh::new(), retained:None, empty_recorded: false };
    let plane = HalfSpacePlan { point: Point3::new(0., 0., 1.),
        normal: Vector3::new(0., 0., 1.), agreement: false };
    let mut program = BooleanProgram::with_path(Default::default(), TessellationQuality::Medium,
        Frame::Numerical(work::Ready::Plane(work::Plane { host: host(), plane, fallback: true }),
            work::Continuation::Step(steps)));
    program.bind_test_emitter(&recorder);
    let BooleanPoll::Ready(ready) = program.request().unwrap() else { panic!("ready plane") };
    let mut reply = ready.execute();
    assert_eq!(recorder.failure_mark(), 0, "numerical execution owns its reached fallback record");
    reply.ticket.sequence += 1;
    let mut reply = *program.accept_numerical(reply, &recorder).err().expect("wrong sequence");
    assert_eq!(recorder.failure_mark(), 0);
    reply.ticket.sequence -= 1;
    reply.kind = work::Kind::Solid;
    let mut reply = *program.accept_numerical(reply, &recorder).err().expect("wrong kind");
    assert_eq!(recorder.failure_mark(), 0);
    reply.kind = work::Kind::Plane;
    program.accept_numerical(reply, &recorder).unwrap_or_else(|_| panic!("valid numeric reply")).unwrap();
    assert_eq!(recorder.failure_mark(), 1);
    let (mesh, lost) = program.drain(&recorder, &mut EntityDecoder::new("")).unwrap();
    assert!(!lost);
    assert!((mesh_volume(&mesh).abs() - 4.).abs() < 1e-6);
}

#[test]
fn inner_pbhs_kept_side_pause_precedes_unreadable_position_and_contour() {
    let mut decoder = EntityDecoder::new("#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCAXIS2PLACEMENT3D(#1,$,$);#3=IFCPLANE(#2);
#4=IFCPOLYGONALBOUNDEDHALFSPACE(#3,.T.,#90,#91);
#9=IFCBOOLEANRESULT(.DIFFERENCE.,$,#4);
#90=IFCCARTESIANPOINT((1.E400,0.,0.));#91=IFCPOLYLINE((#90));").with_strict_reals();
    let root = decoder.decode_by_id(9).unwrap();
    let recorder = BooleanClippingProcessor::new();
    let mut program = step(root);
    source(&mut program, &recorder, &mut decoder); // SecondOperand only.
    source(&mut program, &recorder, &mut decoder); // Plane only.
    let cached = decoder.cache_size();
    let BooleanPoll::Ready(ready) = program.request().unwrap() else { panic!("kept-side numerical test") };
    let reply = ready.execute();
    assert_eq!(decoder.cache_size(), cached);
    assert!(decoder.refused_record_ids().is_empty());
    program.accept_numerical(reply, &recorder).unwrap_or_else(|_| panic!("kept reply")).unwrap();
    let (mesh, lost) = program.drain(&recorder, &mut decoder).unwrap();
    assert!(!lost);
    assert!((mesh_volume(&mesh).abs() - 8.).abs() < 1e-6);
    assert!(decoder.refused_record_ids().is_empty(), "kept-side child never admits contour/Position");
    assert!(decoder.decode_by_id(90).is_err(), "dormant source was actually unreadable");
}

#[test]
fn inner_source_request_can_execute_once_and_cancel_never_releases_an_ancestor() {
    let mut decoder = EntityDecoder::new("#1=IFCBLOCK($,2.,2.,2.);#2=IFCBOOLEANRESULT(.UNION.,#1,#1);");
    let root = decoder.decode_by_id(2).unwrap();
    let recorder = BooleanClippingProcessor::new();
    let mut path = OperandPath::default();
    assert!(path.insert(900));
    let mut program = BooleanProgram::with_path(path, TessellationQuality::Medium, Frame::Boolean(root, 0));
    source(&mut program, &recorder, &mut decoder);
    assert!(matches!(program.cancel(), Err(Error::ProgramStopped(crate::resource::ProgramStop::Cancelled))));
    let mut path = program.take_path();
    assert_eq!(path.len(), 1);
    assert!(!path.insert(900));
    for _ in 1..crate::processors::boolean::MAX_OPERAND_VISITS { assert!(path.charge()); }
    assert!(!path.charge(), "cancel preserves spent visits");
}

#[test]
fn dormant_inner_boolean_state_is_send() {
    fn assert_send<T: Send>() {}
    assert_send::<BooleanProgram>();
    assert_send::<BooleanSourceReply>();
    assert_send::<ReadyBoolean>();
    assert_send::<BooleanNumericalReply>();
}

#[test]
fn inner_advanced_face_refusal_is_owned_between_polls_and_delivered_once() {
    let _ = crate::processors::take_face_refused();
    let mut decoder = EntityDecoder::new("#1=IFCADVANCEDBREP(#2);#2=IFCCLOSEDSHELL((#30));
#30=IFCADVANCEDFACE((),#31,.T.);
#31=IFCBSPLINESURFACEWITHKNOTS(1000000,1,((#999)),.UNSPECIFIED.,.F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.);");
    let operand = decoder.decode_by_id(1).unwrap();
    let recorder = BooleanClippingProcessor::new();
    let mut program = BooleanProgram::with_path(Default::default(), TessellationQuality::Medium,
        Frame::Operand { entity: operand, operator: BoolOp::Unknown, depth: 0 });
    let BooleanPoll::Source(ticket) = program.request().unwrap() else { panic!("constructor source") };
    let reply = program.execute_source(ticket, &recorder, &mut decoder).unwrap();
    assert!(crate::processors::take_face_refused().is_empty(), "source receipt owns the real face refusal");
    program.accept_source(reply, &recorder).unwrap_or_else(|_| panic!("source accepted")).unwrap();
    assert!(crate::processors::take_face_refused().is_empty(), "acceptance retains reports without ambient TLS");
    let BooleanPoll::Ready(ready) = program.request().unwrap() else { panic!("admitted constructor") };
    drop(decoder);
    let reply = ready.execute();
    assert!(crate::processors::take_face_refused().is_empty());
    program.accept_numerical(reply, &recorder).unwrap_or_else(|_| panic!("numeric accepted")).unwrap();
    let BooleanPoll::Complete((mesh, lost)) = program.request().unwrap() else { panic!("completed constructor") };
    assert!(mesh.is_empty());
    assert!(!lost);
    let reports = program.take_reports();
    assert_eq!(reports.face_refused, [ifc_lite_core::IfcType::IfcAdvancedFace]);
    assert!(program.take_reports().face_refused.is_empty(), "owned final delivery consumes reports");
    assert!(crate::processors::take_face_refused().is_empty());
}

#[test]
fn abandoning_a_ready_constructor_keeps_already_accepted_real_face_source_evidence() {
    let mut decoder=EntityDecoder::new("#1=IFCADVANCEDBREP(#2);#2=IFCCLOSEDSHELL((#30));
#30=IFCADVANCEDFACE((),#31,.T.);
#31=IFCBSPLINESURFACEWITHKNOTS(1000000,1,((#999)),.UNSPECIFIED.,.F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.);");
    let entity=decoder.decode_by_id(1).unwrap();let recorder=BooleanClippingProcessor::new();
    let mut program=BooleanProgram::with_path(Default::default(),TessellationQuality::Medium,
        Frame::Operand{entity,operator:BoolOp::Unknown,depth:0});
    source(&mut program,&recorder,&mut decoder);
    let BooleanPoll::Ready(ready)=program.request().unwrap()else{panic!("actual admitted advanced constructor")};
    drop(ready);
    assert_eq!(program.take_reports().face_refused,[ifc_lite_core::IfcType::IfcAdvancedFace]);
    assert!(program.take_reports().face_refused.is_empty());
    assert!(program.cancel().is_err());
    assert!(recorder.take_failures().is_empty(),"abandonment never executes geometry");
}

#[test]
fn completed_boolean_occurrences_release_active_paths_in_release_builds() {
    // Inner-program review: ExitPath must mutate state even without debug assertions.
    // Repeated nested DAG operands are real occurrences, not a cycle.
    let mut decoder = EntityDecoder::new("#1=IFCBLOCK($,2.,2.,2.);
#2=IFCBOOLEANRESULT(.UNION.,#1,#1);
#3=IFCBOOLEANRESULT(.UNION.,#2,#2);");
    let root = decoder.decode_by_id(3).unwrap();
    let recorder = BooleanClippingProcessor::new();
    let mut path = OperandPath::default();
    assert!(path.insert(900));
    let mut program = BooleanProgram::with_path(path, TessellationQuality::Medium,
        Frame::Boolean(root, 0));
    let (mesh, _) = program.drain(&recorder, &mut decoder).unwrap();
    assert!((mesh_volume(&mesh).abs() - 8.).abs() < 1e-6);
    let state = program.state.as_ref().unwrap();
    assert!(state.active.is_empty(), "completed occurrences retain no active cleanup entries");
    let mut path = program.take_path();
    assert_eq!(path.len(), 1, "the caller's ancestor is the only remaining membership");
    assert!(!path.insert(900));
    assert!(path.insert(2), "the repeated child is available to later occurrences");
    assert!(path.insert(3), "the completed root is available to later occurrences");
}

#[test]
fn p2_detached_retained_reply_keeps_prior_reports_available_to_cancellation() {
    // A reached source diagnostic is owned by the continuation until either
    // acceptance or cancellation consumes it. Detaching a logical reply must
    // not move that diagnostic into an unaccepted external packet.
    let mut decoder=EntityDecoder::new("#1=IFCCARTESIANPOINT((0.,0.,0.));
        #2=IFCAXIS2PLACEMENT3D(#1,$,$);#3=IFCDIRECTION((0.,0.,1.));
        #4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);
        #5=IFCEXTRUDEDAREASOLID(#4,#2,#3,3.);");
    let entity=decoder.decode_by_id(5).unwrap();
    let operation=crate::program::retained::capture(&entity,&mut decoder,1.,
        crate::program::RetainedContract {source_epoch:7,source_revision:11},900).unwrap();
    let mut state=BooleanState::new(Default::default(),TessellationQuality::Medium,
        Frame::Numerical(work::Ready::Retained(operation),work::Continuation::RetainedOperand));
    state.reports.face_refused.push(ifc_lite_core::IfcType::IfcAdvancedFace);
    let recorder=BooleanClippingProcessor::new();
    let mut program=BooleanProgram::from_test_state(state);
    program.bind_test_emitter(&recorder);
    let BooleanPoll::Ready(ready)=program.request().unwrap() else {panic!("retained numerical request")};
    let (reply,operations)=ready.admit_retained().unwrap();
    assert_eq!(operations.len(),1);
    assert!(program.cancel().is_err());
    assert_eq!(program.take_reports().face_refused,[ifc_lite_core::IfcType::IfcAdvancedFace]);
    assert!(program.take_reports().face_refused.is_empty());
    assert!(program.accept_numerical(reply,&recorder).is_err(),"cancellation also prevents late reply acceptance");
}
