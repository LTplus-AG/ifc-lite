// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::{GeometryProcessor, GeometryRouter, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

const SOURCE: &str = "\
#1=IFCBLOCK($,2.,3.,4.);\n\
#2=IFCSPHERE($,2.);\n\
#3=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));\n\
#4=IFCTRIANGULATEDFACESET(#3,$,.F.,((1,2,3)),$);\n\
#5=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,3.);\n\
#6=IFCDIRECTION((0.,0.,1.));\n\
#7=IFCEXTRUDEDAREASOLID(#5,$,#6,4.);\n\
#8=IFCBOOLEANRESULT(.DIFFERENCE.,#1,#2);\n\
#9=IFCBLOCK($,-1.,3.,4.);\n\
#10=IFCBOOLEANRESULT(.DIFFERENCE.,#1,#11);\n\
#11=IFCHALFSPACESOLID($,.T.);";

fn bounds(mesh: &Mesh) -> ([f32; 3], [f32; 3]) {
    let mut lower = [f32::INFINITY; 3];
    let mut upper = [f32::NEG_INFINITY; 3];
    for point in mesh.positions.chunks_exact(3) {
        for axis in 0..3 {
            lower[axis] = lower[axis].min(point[axis]);
            upper[axis] = upper[axis].max(point[axis]);
        }
    }
    (lower, upper)
}

#[test]
fn batch_replays_after_source_disposal_without_losing_repeated_occurrences() {
    let batch = {
        let bytes = SOURCE.to_owned();
        let router = GeometryRouter::new();
        router.plan_construction_items(&mut EntityDecoder::new(&bytes), &[1, 2, 4, 7, 1], 5).unwrap()
    };
    assert_eq!(batch.nodes().len(), 4);
    assert_eq!(batch.occurrences(), &[0, 1, 2, 3, 0]);
    assert_eq!(batch.nodes()[0].source_id(), 1);
    assert_eq!(batch.nodes()[0].family(), Some(ConstructionFamily::Block));
    let replay = batch.clone().evaluate().unwrap();
    let result = batch.evaluate().unwrap();
    assert_eq!(result.occurrences, [0, 1, 2, 3, 0]);
    assert_eq!(bounds(&result.definitions[0]), ([0., 0., 0.], [2., 3., 4.]));
    assert_eq!(bounds(&result.definitions[1]), ([-2.; 3], [2.; 3]));
    assert_eq!(bounds(&result.definitions[2]), ([0.; 3], [1., 1., 0.]));
    assert_eq!(bounds(&result.definitions[3]), ([-1., -1.5, 0.], [1., 1.5, 4.]));
    for (original, replay) in result.definitions.iter().zip(&replay.definitions) {
        assert_eq!(original.positions, replay.positions);
        assert_eq!(original.indices, replay.indices);
        assert_eq!(original.normals, replay.normals);
    }
}

#[test]
fn unsupported_operator_is_a_requirement_and_blocks_the_whole_batch() {
    let router = GeometryRouter::new();
    let batch = router.plan_construction_items(&mut EntityDecoder::new(SOURCE), &[1, 10, 1], 3).unwrap();
    assert_eq!(batch.nodes()[1].family(), Some(ConstructionFamily::Boolean));
    assert_eq!(batch.nodes()[1].requirement(), Some(&ConstructionRequirement::ConstructorNotLowered));
    assert!(batch.evaluate().is_err(), "never return the surviving block as a complete result");
}

#[test]
fn malformed_and_absent_items_preserve_admission_failure() {
    let router = GeometryRouter::new();
    let batch = router.plan_construction_items(&mut EntityDecoder::new(SOURCE), &[9, 999], 2).unwrap();
    for node in batch.nodes() {
        let Some(ConstructionRequirement::SourceAdmission(message)) = node.requirement()
            else { panic!("expected an admission diagnostic") };
        assert!(!message.is_empty());
    }
    assert!(batch.evaluate().is_err());
}

#[test]
fn root_budget_refuses_before_source_admission_and_zero_root_batch_is_valid() {
    let router = GeometryRouter::new();
    let error = router.plan_construction_items(&mut EntityDecoder::new(""), &[999], 0).unwrap_err();
    assert!(error.to_string().contains("budget exceeded"));
    let empty = router.plan_construction_items(&mut EntityDecoder::new(""), &[], 0).unwrap()
        .evaluate().unwrap();
    assert!(empty.definitions.is_empty());
    assert!(empty.occurrences.is_empty());
}

#[test]
fn raw_construction_applies_position_once_independently_of_router_scale_and_rtc() {
    let source = "#1=IFCCARTESIANPOINT((1000.,2000.,3000.));\n\
        #2=IFCAXIS2PLACEMENT3D(#1,$,$);\n#3=IFCBLOCK(#2,2000.,3000.,4000.);";
    let router = GeometryRouter::with_scale_and_rtc(0.001, (5000., 6000., 7000.));
    let mesh = router.plan_construction_items(&mut EntityDecoder::new(source), &[3], 1).unwrap()
        .evaluate().unwrap().definitions.remove(0);
    assert_eq!(bounds(&mesh), ([1000., 2000., 3000.], [3000., 5000., 7000.]));
    assert!(!mesh.rtc_applied);
}

struct DoubleBlock;
impl GeometryProcessor for DoubleBlock {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcBlock] }
    fn process(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        schema: &IfcSchema, quality: TessellationQuality) -> Result<Mesh> {
        let mut mesh = crate::processors::BlockProcessor::new().process(entity, decoder, schema, quality)?;
        for position in &mut mesh.positions { *position *= 2.; }
        Ok(mesh)
    }
}

#[test]
fn custom_constructor_is_not_replaced_with_builtin_parameters() {
    let mut router = GeometryRouter::new();
    router.register(Box::new(DoubleBlock));
    let mut decoder = EntityDecoder::new(SOURCE);
    let entity = decoder.decode_by_id(1).unwrap();
    let custom = router.process_representation_item(&entity, &mut decoder).unwrap();
    assert_eq!(bounds(&custom), ([0.; 3], [4., 6., 8.]));
    let batch = router.plan_construction_items(&mut EntityDecoder::new(SOURCE), &[1], 1).unwrap();
    assert_eq!(batch.nodes()[0].family(), Some(ConstructionFamily::Block));
    assert_eq!(batch.nodes()[0].requirement(), Some(&ConstructionRequirement::CustomProcessor));
    assert!(batch.evaluate().is_err());
}
