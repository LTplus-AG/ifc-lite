// SPDX-License-Identifier: MPL-2.0
//! Owned control flow and conditional source admission, without mesh execution.
use super::*;

fn lower_owned(source: String, root: u32) -> BooleanSpinePlan {
    let mut decoder = EntityDecoder::new(&source).with_strict_reals();
    let entity = decoder.decode_by_id(root).unwrap();
    lower(&entity, &mut decoder, 100, 400)
}
fn resolved_id(admission: &Admission) -> u32 {
    let Admission::Resolved(entity) = admission else { panic!("expected source entity, got {admission:?}") };
    entity.id
}

#[test]
fn source_spine_survives_disposal_and_preserves_application_and_candidate_order() {
    let plan = lower_owned("#1=IFCBLOCK($,2.,3.,4.);
#20=IFCPOLYGONALBOUNDEDHALFSPACE($,.T.,$,$);
#21=IFCPOLYGONALBOUNDEDHALFSPACE($,.F.,$,$);
#22=IFCPOLYGONALBOUNDEDHALFSPACE($,.T.,$,$);
#100=IFCBOOLEANRESULT(.DIFFERENCE.,#101,#20);
#101=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#102,#21);
#102=IFCBOOLEANRESULT(.DIFFERENCE.,#1,#22);".into(), 100);
    assert_eq!(plan.nodes.iter().rev().map(|node| node.entity.id).collect::<Vec<_>>(), [102, 101, 100]);
    let SpineEnd::Base(base) = &plan.end else { panic!("expected block base") };
    assert_eq!(base.id, 1);
    let outer = plan.collect_candidate(plan.candidates[0], 100);
    assert_eq!(outer.cutters.iter().map(|index| resolved_id(&plan.nodes[*index].second.admission)).collect::<Vec<_>>(), [22, 21, 20]);
    assert_eq!(resolved_id(&outer.base), 1);
    let inner = plan.collect_candidate(plan.candidates[1], 100);
    assert_eq!(inner.cutters, [2, 1]);
}

#[test]
fn unknown_operator_keeps_its_host_source_and_never_resolves_unused_cutter() {
    let plan = lower_owned("#1=IFCBLOCK($,2.,3.,4.);
#2=IFCBOOLEANRESULT(.XOR.,#1,#999);".into(), 2);
    assert_eq!(plan.nodes[0].operator.as_ref().map_err(String::as_str), Err("XOR"));
    assert!(matches!(plan.nodes[0].second.admission, Admission::Unused));
    assert_eq!(resolved_id(&plan.nodes[0].first.admission), 1);
    assert!(plan.candidates.is_empty());
}

#[test]
fn unreadable_second_operand_is_owned_recoverable_data_not_a_root_failure() {
    let plan = lower_owned("#1=IFCBLOCK($,2.,3.,4.);
#2=IFCBOOLEANRESULT(.INTERSECTION.,#1,#999);".into(), 2);
    let Admission::Fault(error) = &plan.nodes[0].second.admission else { panic!("expected unresolved cutter") };
    assert!(matches!(error.as_ref(), Error::CoreError(ifc_lite_core::Error::ParseError { position: 0, message })
        if message == "Entity #999 not found"), "{error}");
    assert!(matches!(plan.end, SpineEnd::Base(_)));
    assert_eq!(OperandRole::Operation(BoolOp::Intersection).diagnostic_operator(), BoolOp::Intersection);
    assert_eq!(OperandRole::Base.diagnostic_operator(), BoolOp::Unknown);
    assert_eq!(OperandRole::Root.diagnostic_operator(), BoolOp::Unknown);
}

#[test]
fn candidate_retains_current_boolean_when_its_first_link_cannot_resolve() {
    let plan = lower_owned("#20=IFCPOLYGONALBOUNDEDHALFSPACE($,.T.,$,$);
#21=IFCPOLYGONALBOUNDEDHALFSPACE($,.T.,$,$);
#100=IFCBOOLEANRESULT(.DIFFERENCE.,#101,#20);
#101=IFCBOOLEANRESULT(.DIFFERENCE.,$,#21);".into(), 100);
    assert!(matches!(plan.end, SpineEnd::FirstFault(1)));
    let candidate = plan.collect_candidate(plan.candidates[0], 10);
    assert_eq!(candidate.cutters, [1, 0]);
    assert_eq!(resolved_id(&candidate.base), 101);
}

#[test]
fn cyclic_spine_is_bounded_but_batch_collector_keeps_its_repeated_base_snapshot() {
    let plan = lower_owned("#20=IFCPOLYGONALBOUNDEDHALFSPACE($,.T.,$,$);
#100=IFCBOOLEANRESULT(.DIFFERENCE.,#101,#20);
#101=IFCBOOLEANRESULT(.DIFFERENCE.,#100,#20);".into(), 100);
    assert!(matches!(plan.end, SpineEnd::Cycle(100)));
    let outer = plan.collect_candidate(plan.candidates[0], 10);
    assert_eq!(outer.cutters, [1, 0]);
    assert_eq!(resolved_id(&outer.base), 100);
    let inner = plan.collect_candidate(plan.candidates[1], 10);
    assert_eq!(inner.cutters, [0, 1]);
    assert_eq!(resolved_id(&inner.base), 101);
}

#[test]
fn source_and_candidate_budgets_report_limits_without_truncated_success() {
    let source = "#1=IFCBLOCK($,2.,3.,4.);#20=IFCPOLYGONALBOUNDEDHALFSPACE($,.T.,$,$);
#100=IFCBOOLEANRESULT(.DIFFERENCE.,#101,#20);
#101=IFCBOOLEANRESULT(.DIFFERENCE.,#1,#20);";
    for (nodes, work, reason) in [(0, 20, SourceLimit::Nodes), (20, 0, SourceLimit::Work), (20, 1, SourceLimit::Work)] {
        let mut decoder = EntityDecoder::new(source).with_strict_reals();
        let root = decoder.decode_by_id(100).unwrap();
        let plan = lower(&root, &mut decoder, nodes, work);
        assert!(matches!(plan.end, SpineEnd::Limited { reason: actual, .. } if actual == reason));
    }
    let plan = lower_owned(source.into(), 100);
    let candidate = plan.collect_candidate(plan.candidates[0], 1);
    assert!(matches!(candidate.base, Admission::Limited(SourceLimit::Work)));
}

#[test]
fn refused_source_reports_are_scoped_and_retained_for_repeated_reads() {
    let source = "#1=IFCBLOCK($,2.,3.,4.);#9=IFCCARTESIANPOINT((1.E400,0.,0.));
#100=IFCBOOLEANRESULT(.DIFFERENCE.,#101,#9);
#101=IFCBOOLEANRESULT(.DIFFERENCE.,#1,#9);";
    let plan = lower_owned(source.into(), 100);
    for node in &plan.nodes {
        assert_eq!(node.second.reports.decoder_refused_record_ids, [9]);
        assert!(node.first.reports.decoder_refused_record_ids.is_empty());
        assert!(!node.second.reports.curve_capped);
        assert!(node.second.reports.face_refused.is_empty());
    }
}


#[test]
fn source_read_reports_exclude_preexisting_refusals_from_the_same_decoder() {
    let source = "#1=IFCBLOCK($,2.,3.,4.);#8=IFCCARTESIANPOINT((1.E400,0.,0.));
#9=IFCCARTESIANPOINT((1.E400,0.,0.));
#100=IFCBOOLEANRESULT(.DIFFERENCE.,#101,#9);
#101=IFCBOOLEANRESULT(.DIFFERENCE.,#1,#9);";
    let mut decoder = EntityDecoder::new(source).with_strict_reals();
    assert!(matches!(decoder.decode_by_id(8), Err(ifc_lite_core::Error::UnrepresentableReal(8))));
    let root = decoder.decode_by_id(100).unwrap();
    let plan = lower(&root, &mut decoder, 100, 400);
    for node in &plan.nodes {
        assert_eq!(node.second.reports.decoder_refused_record_ids, [9]);
        assert!(node.first.reports.decoder_refused_record_ids.is_empty());
    }
    let mut cumulative = decoder.refused_record_ids();
    cumulative.sort_unstable();
    assert_eq!(cumulative, [8, 9], "scoping reports must not alter decoder policy");
}

fn exact_owned(source: &str, root: u32) -> BooleanSpinePlan {
    let mut decoder = EntityDecoder::new(source).with_strict_reals();
    let entity = decoder.decode_by_id(root).unwrap();
    lower_polygonal_candidate(&entity, &mut decoder, usize::MAX, usize::MAX)
}

#[test]
fn exact_candidate_stops_before_unused_first_and_second_source_reads() {
    let sources = [
        "#100=IFCBOOLEANRESULT(.UNION.,#9,#9);#9=IFCCARTESIANPOINT((1.E400,0.,0.));",
        "#100=IFCBOOLEANRESULT(.XOR.,#9,#9);#9=IFCCARTESIANPOINT((1.E400,0.,0.));",
        "#100=IFCBOOLEANRESULT(.DIFFERENCE.,#9,#1);#1=IFCBLOCK($,2.,3.,4.);#9=IFCCARTESIANPOINT((1.E400,0.,0.));",
        "#100=IFCBOOLEANRESULT(.DIFFERENCE.,#9,$);#9=IFCCARTESIANPOINT((1.E400,0.,0.));",
    ];
    for source in sources {
        let mut decoder = EntityDecoder::new(source).with_strict_reals();
        let entity = decoder.decode_by_id(100).unwrap();
        let plan = lower_polygonal_candidate(&entity, &mut decoder, usize::MAX, usize::MAX);
        assert!(decoder.refused_record_ids().is_empty(), "unused source reads must stay unread");
        let candidate = plan.collect_candidate(BatchCandidate { start_node: 0 }, usize::MAX);
        assert!(candidate.cutters.is_empty());
        assert_eq!(resolved_id(&candidate.base), 100);
        assert!(matches!(plan.nodes[0].first.admission, Admission::Unused));
    }
}

#[test]
fn exact_candidate_stops_at_unreadable_cutter_before_reading_first() {
    let source = "#100=IFCBOOLEANRESULT(.DIFFERENCE.,#8,#9);
#8=IFCCARTESIANPOINT((1.E400,0.,0.));#9=IFCCARTESIANPOINT((1.E400,0.,0.));";
    let mut decoder = EntityDecoder::new(source).with_strict_reals();
    let entity = decoder.decode_by_id(100).unwrap();
    let plan = lower_polygonal_candidate(&entity, &mut decoder, usize::MAX, usize::MAX);
    assert_eq!(decoder.refused_record_ids(), [9]);
    assert_eq!(plan.nodes[0].second.reports.decoder_refused_record_ids, [9]);
    assert!(matches!(plan.nodes[0].first.admission, Admission::Unused));
}

#[test]
fn exact_candidate_pushes_cutter_before_unreadable_first_and_stops_on_plain_base() {
    let plan = exact_owned("#100=IFCBOOLEANRESULT(.DIFFERENCE.,$,#20);
#20=IFCPOLYGONALBOUNDEDHALFSPACE($,.T.,$,$);", 100);
    let candidate = plan.collect_candidate(BatchCandidate { start_node: 0 }, usize::MAX);
    assert_eq!(candidate.cutters, [0]);
    assert_eq!(resolved_id(&candidate.base), 100);
    let block = exact_owned("#1=IFCBLOCK($,2.,3.,4.);", 1);
    let candidate = block.collect_candidate(BatchCandidate { start_node: 0 }, usize::MAX);
    assert!(candidate.cutters.is_empty());
    assert_eq!(resolved_id(&candidate.base), 1);
}


#[test]
fn source_snapshot_preserves_the_callers_lossless_real_admission_mode() {
    let source = "#1=IFCBLOCK($,2.,3.,4.);#9=IFCCARTESIANPOINT((1.E400,0.,0.));
#100=IFCBOOLEANRESULT(.DIFFERENCE.,#1,#9);";
    let mut decoder = EntityDecoder::new(source);
    let root = decoder.decode_by_id(100).unwrap();
    let plan = lower_polygonal_candidate(&root, &mut decoder, usize::MAX, usize::MAX);
    assert_eq!(resolved_id(&plan.nodes[0].second.admission), 9);
    assert!(plan.nodes[0].second.reports.decoder_refused_record_ids.is_empty());
    assert!(decoder.refused_record_ids().is_empty());
    assert!(!decoder.strict_reals());
}
