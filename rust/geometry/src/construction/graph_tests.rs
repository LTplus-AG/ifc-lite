// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::{GeometryProcessor, GeometryRouter, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

const SOURCE: &str = "#1=IFCBLOCK($,2.,2.,2.);\n\
    #2=IFCCARTESIANPOINT((1.,1.,1.));#3=IFCAXIS2PLACEMENT3D(#2,$,$);\n\
    #4=IFCBLOCK(#3,2.,2.,2.);\n\
    #5=IFCBOOLEANRESULT(.DIFFERENCE.,#1,#4);\n\
    #6=IFCBOOLEANRESULT(.UNION.,#1,#4);\n\
    #7=IFCBOOLEANRESULT(.INTERSECTION.,#1,#4);\n\
    #8=IFCCSGSOLID(#5);";

fn volume(mesh: &Mesh) -> f64 {
    mesh.indices.chunks_exact(3).map(|triangle| {
        let p = |index: u32| {
            let start = index as usize * 3;
            nalgebra::Vector3::new(mesh.positions[start] as f64,
                mesh.positions[start + 1] as f64, mesh.positions[start + 2] as f64)
        };
        p(triangle[0]).dot(&p(triangle[1]).cross(&p(triangle[2]))) / 6.
    }).sum::<f64>().abs()
}

#[test]
fn ordered_exact_operations_and_csg_replay_after_source_disposal() {
    let batch = {
        let bytes = SOURCE.to_owned();
        GeometryRouter::new().plan_construction_items(&mut EntityDecoder::new(&bytes), &[5, 6, 7, 8, 5], 5).unwrap()
    };
    let result = batch.evaluate().unwrap();
    assert_eq!(result.occurrences, [0, 1, 2, 3, 0]);
    for (mesh, expected) in result.definitions.iter().zip([7., 15., 1., 7.]) {
        assert!((volume(mesh) - expected).abs() < 1e-6);
    }
    assert!(result.diagnostics.iter().all(Vec::is_empty));
}

#[test]
fn graph_reuses_definitions_without_erasing_operand_edges_or_root_occurrences() {
    let source = format!("{SOURCE}#9=IFCBOOLEANRESULT(.DIFFERENCE.,#6,#6);");
    let batch = GeometryRouter::new().plan_construction_items(
        &mut EntityDecoder::new(&source), &[9, 6, 9], 3).unwrap();
    assert_eq!(batch.nodes.len(), 2);
    // Operand roles preserve contextual dispatch and void-shell policy;
    // base, operation and root uses can own distinct definitions.
    assert_eq!(batch.program.len(), 6);
    let result = batch.evaluate().unwrap();
    assert!(result.definitions[0].is_empty(), "A minus A consumes the host");
    assert!((volume(&result.definitions[1]) - 15.).abs() < 1e-6);
    assert_eq!(result.occurrences, [0, 1, 0]);
}

struct DoubleBlock;
impl GeometryProcessor for DoubleBlock {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcBlock] }
    fn process(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        schema: &IfcSchema, quality: TessellationQuality) -> Result<Mesh> {
        let mut mesh = crate::processors::BlockProcessor::new().process(entity, decoder, schema, quality)?;
        for coordinate in &mut mesh.positions { *coordinate *= 2.; }
        Ok(mesh)
    }
}

#[test]
fn boolean_operands_keep_builtin_dispatch_independent_of_a_public_override() {
    let mut router = GeometryRouter::new();
    router.register(Box::new(DoubleBlock));
    let result = router.plan_construction_items(&mut EntityDecoder::new(SOURCE), &[5], 1).unwrap()
        .evaluate().unwrap();
    assert!((volume(&result.definitions[0]) - 7.).abs() < 1e-6);
    let direct = router.plan_construction_items(&mut EntityDecoder::new(SOURCE), &[1], 1).unwrap();
    assert_eq!(direct.nodes()[0].requirement(), Some(&ConstructionRequirement::CustomProcessor));
}

#[test]
fn graph_cycles_and_incomplete_operation_policies_are_explicit_refusals() {
    let source = format!("{SOURCE}#10=IFCBOOLEANRESULT(.UNION.,#10,#1);\n\
        #11=IFCBOOLEANRESULT(.XOR.,#1,$);\n#12=IFCCSGSOLID(#8);");
    let batch = GeometryRouter::new().plan_construction_items(&mut EntityDecoder::new(&source), &[10, 11, 12, 1], 4).unwrap();
    assert!(matches!(batch.nodes()[0].requirement(), Some(ConstructionRequirement::CyclicDependency(10))));
    assert!(matches!(batch.nodes()[1].requirement(), Some(ConstructionRequirement::OperationPolicyNotLowered(_))));
    assert!(matches!(batch.nodes()[2].requirement(), Some(ConstructionRequirement::SourceAdmission(_))));
    assert!(batch.nodes()[3].requirement().is_none(), "a refused path cannot poison another root");
    assert!(batch.evaluate().is_err());
}

#[test]
fn deep_acyclic_and_shared_dag_planning_and_drop_are_iterative() {
    let mut source = "#1=IFCBLOCK($,2.,2.,2.);".to_owned();
    for id in 2..=2000 {
        source.push_str(&format!("#{id}=IFCBOOLEANRESULT(.UNION.,#{},#{});", id - 1, id - 1));
    }
    let batch = GeometryRouter::new().plan_construction_items(&mut EntityDecoder::new(&source), &[2000], 1).unwrap();
    assert!(batch.nodes()[0].requirement().is_none());
    assert_eq!(batch.program.len(), 3999, "shared DAG is memoized; both edges remain in each operation");
    drop(batch); // Flat ownership must not recurse through the source chain.
    for id in 2001..=17000 {
        source.push_str(&format!("#{id}=IFCBOOLEANRESULT(.UNION.,#{},#1);", id - 1));
    }
    let refused = GeometryRouter::new().plan_construction_items(&mut EntityDecoder::new(&source), &[17000], 1).unwrap();
    assert_eq!(refused.nodes()[0].requirement(), Some(&ConstructionRequirement::GraphBudgetExhausted));
    assert!(refused.evaluate().is_err());
}

#[test]
fn shared_empty_dag_preserves_loss_multiplicity_and_bounds_diagnostic_expansion() {
    let mut source = "#1=IFCPOLYLINE(());#2=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#1);\n\
        #3=IFCEXTRUDEDAREASOLID(#2,$,$,$);".to_owned();
    for id in 4..=40 {
        source.push_str(&format!("#{id}=IFCBOOLEANRESULT(.UNION.,#{},#{});", id - 1, id - 1));
    }
    let small = GeometryRouter::new().plan_construction_items(&mut EntityDecoder::new(&source), &[7], 1).unwrap()
        .evaluate().unwrap();
    assert!(small.definitions[0].is_empty());
    assert_eq!(small.diagnostics[0].len(), 16, "both semantic edges retain their losses");
    let large = GeometryRouter::new().plan_construction_items(&mut EntityDecoder::new(&source), &[40], 1).unwrap();
    assert!(large.nodes()[0].requirement().is_none(), "the graph itself is small and acyclic");
    let failure = large.evaluate().err().expect("diagnostic fan-out must refuse before allocation explodes");
    assert!(failure.to_string().contains("diagnostic work budget exhausted"));
}

#[test]
fn explicit_router_unit_refusal_cannot_publish_raw_construction_geometry() {
    for mut router in [GeometryRouter::with_scale(f64::NAN), GeometryRouter::new()] {
        router.refuse_length_unit();
        let batch = router.plan_construction_items(&mut EntityDecoder::new(SOURCE), &[1, 5], 2).unwrap();
        assert!(batch.nodes().iter().all(|node|
            node.requirement() == Some(&ConstructionRequirement::LengthUnitRefused)));
        assert!(batch.evaluate().is_err());
    }
}

#[test]
fn committed_csg_fixture_matches_raw_production_buffers_and_diagnostics() {
    use crate::processors::{BlockProcessor, BooleanClippingProcessor, CsgSolidProcessor, ExtrudedAreaSolidProcessor};
    let source = include_str!("../../tests/fixtures/bath_csg_solid.ifc");
    let block = BlockProcessor::new();
    let extrusion = ExtrudedAreaSolidProcessor::new(IfcSchema::new());
    let boolean = BooleanClippingProcessor::new();
    let csg = CsgSolidProcessor::new();
    let cases: [(&dyn GeometryProcessor, u32); 4] = [(&block, 200), (&extrusion, 206), (&boolean, 207), (&csg, 208)];
    for (processor, id) in cases {
        let mut decoder = EntityDecoder::new(source);
        let entity = decoder.decode_by_id(id).unwrap();
        let expected = processor.process(&entity, &mut decoder, &IfcSchema::new(), TessellationQuality::Medium).unwrap();
        let diagnostics = processor.take_bool_failures();
        let batch = {
            let owned_bytes = source.to_owned();
            GeometryRouter::new().plan_construction_items(&mut EntityDecoder::new(&owned_bytes), &[id, id], 2).unwrap()
        };
        let result = batch.evaluate().unwrap();
        let actual = &result.definitions[0];
        assert!(!expected.is_empty(), "real item #{id} must exercise geometry");
        assert_eq!(actual.positions, expected.positions, "positions #{id}");
        assert_eq!(actual.normals, expected.normals, "normals #{id}");
        assert_eq!(actual.indices, expected.indices, "indices #{id}");
        assert_eq!(actual.origin, expected.origin);
        assert_eq!(actual.rtc_applied, expected.rtc_applied);
        assert_eq!(result.diagnostics[0], diagnostics);
        assert_eq!(result.occurrences, [0, 0]);
    }
}

#[test]
fn empty_first_operations_skip_numeric_second_without_orphaning_later_roots() {
    let mut source = "#1=IFCPOLYLINE(());#2=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#1);\
        #3=IFCEXTRUDEDAREASOLID(#2,$,$,$);".to_owned();
    for id in 4..=40 {
        source.push_str(&format!("#{id}=IFCBOOLEANRESULT(.UNION.,#{},#{});", id - 1, id - 1));
    }
    source.push_str("#41=IFCBOOLEANRESULT(.DIFFERENCE.,#3,#40);\
        #42=IFCBOOLEANRESULT(.INTERSECTION.,#3,#40);#43=IFCBLOCK($,2.,2.,2.);\
        #44=IFCBOOLEANRESULT(.UNION.,#3,#40);");
    let result = GeometryRouter::new().plan_construction_items(
        &mut EntityDecoder::new(&source), &[41, 42, 43], 3).unwrap().evaluate().unwrap();
    assert!(result.definitions[0].is_empty());
    assert!(result.definitions[1].is_empty());
    assert!((volume(&result.definitions[2]) - 8.).abs() < 1e-6);
    assert!(result.observed_diagnostics.is_empty(), "skipped numerical branches emit no losses");
    let error = GeometryRouter::new().plan_construction_items(
        &mut EntityDecoder::new(&source), &[41, 40], 2).unwrap().evaluate().err().unwrap();
    assert_eq!(error.root_source_id, Some(40));
    assert!(error.failed_source_id.is_some());
    assert!(!error.diagnostics.is_empty(), "budget refusal owns prior execution evidence");
    assert!(error.diagnostics.iter().all(|record| (4..=40).contains(&record.source_id)));
    assert!(error.to_string().contains("diagnostic work budget exhausted"));
    let error = GeometryRouter::new().plan_construction_items(
        &mut EntityDecoder::new(&source), &[44], 1).unwrap().evaluate().err().unwrap();
    assert_eq!(error.diagnostics.first().unwrap().source_id, 44,
        "empty first UNION loss precedes second-operand execution, even on error");
}

#[test]
fn source_reports_survive_thread_transfer_without_stealing_caller_reports() {
    use crate::processors::diagnostic_capture::{capture, restore};
    let ((batch, caller), _) = capture(|| {
        restore(&ConstructionReports { curve_capped: true,
            face_refused: vec![IfcType::IfcAdvancedFace], ..Default::default() });
        let source = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCCARTESIANPOINT((4.,0.,0.));\
            #3=IFCCARTESIANPOINT((4.,4.,0.));#4=IFCPOLYLOOP((#1,#2,#3));\
            #5=IFCFACEOUTERBOUND(#4,.T.);#6=IFCFACEBOUND(#999,.T.);\
            #7=IFCFACE((#5,#6));#8=IFCCLOSEDSHELL((#7));#9=IFCFACETEDBREP(#8);".to_owned();
        let batch = GeometryRouter::new().plan_construction_items(
            &mut EntityDecoder::new(&source), &[9], 1).unwrap();
        assert_eq!(batch.reports().face_refused, [IfcType::IfcFace]);
        assert!(!batch.reports().curve_capped);
        let caller = ConstructionReports {
            curve_capped: crate::processors::take_curve_capped(),
            face_refused: crate::processors::take_face_refused(), ..Default::default()
        };
        (batch, caller)
    });
    assert!(caller.curve_capped);
    assert_eq!(caller.face_refused, [IfcType::IfcAdvancedFace]);
    let result = std::thread::spawn(move || batch.evaluate().unwrap()).join().unwrap();
    assert!(result.definitions[0].is_empty());
    assert_eq!(result.reports.face_refused, [IfcType::IfcFace]);
    assert!(!result.reports.curve_capped);
}
