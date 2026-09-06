// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Included by the existing test module, never the new production registry:
// a production-only revert must still collect and run every assertion.
use crate::processors::*;
use crate::{BoolFailure, GeometryProcessor, GeometryRouter, Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use std::cell::Cell;
use std::rc::Rc;

const UNSUPPORTED_BOOLEAN: &str = "#1=IFCBOOLEANRESULT(.DIFFERENCE.,#2,#3);\n\
    #2=IFCSECTIONEDSPINE($,(),());\n#3=IFCEXTRUDEDAREASOLID($,$,$,1.);";

fn mesh_unsupported_boolean(router: &GeometryRouter) {
    let mut decoder = EntityDecoder::new(UNSUPPORTED_BOOLEAN);
    let entity = decoder.decode_by_id(1).unwrap();
    let mesh = router.process_representation_item(&entity, &mut decoder).unwrap();
    assert!(mesh.is_empty(), "unsupported base operands must not invent geometry");
}

fn failure_count(router: &GeometryRouter) -> usize {
    router.take_csg_failures().values().map(Vec::len).sum()
}

// Delegate real meshing and diagnostics; observe ownership through Drop only.
struct RegisteredBoolean {
    processor: BooleanClippingProcessor,
    types: Vec<IfcType>,
    drops: Rc<Cell<usize>>,
}

impl Drop for RegisteredBoolean {
    fn drop(&mut self) { self.drops.set(self.drops.get() + 1); }
}

impl GeometryProcessor for RegisteredBoolean {
    fn process(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        schema: &IfcSchema, quality: TessellationQuality) -> Result<Mesh> {
        self.processor.process(entity, decoder, schema, quality)
    }
    fn supported_types(&self) -> Vec<IfcType> { self.types.clone() }
    fn take_bool_failures(&self) -> Vec<BoolFailure> { self.processor.take_bool_failures() }
}

fn register_boolean(router: &mut GeometryRouter, types: Vec<IfcType>, drops: &Rc<Cell<usize>>) {
    router.register(Box::new(RegisteredBoolean {
        processor: BooleanClippingProcessor::new(), types, drops: drops.clone(),
    }));
}

#[test]
fn issue_3987_default_dispatch_preserves_every_advertised_subtype() {
    let schema = IfcSchema::new();
    let references: Vec<Box<dyn GeometryProcessor>> = vec![
        Box::new(ExtrudedAreaSolidProcessor::new(schema.clone())),
        Box::new(ExtrudedAreaSolidTaperedProcessor::new(schema.clone())),
        Box::new(TriangulatedFaceSetProcessor::new()), Box::new(PolygonalFaceSetProcessor::new()),
        Box::new(FacetedBrepProcessor::new()), Box::new(BooleanClippingProcessor::new()),
        Box::new(SweptDiskSolidProcessor::new(schema.clone())),
        Box::new(RevolvedAreaSolidProcessor::new(schema.clone())),
        Box::new(SurfaceCurveSweptAreaSolidProcessor::new(schema.clone())),
        Box::new(SectionedSolidHorizontalProcessor::new(schema.clone())),
        Box::new(AdvancedBrepProcessor::new()), Box::new(BSplineSurfaceProcessor::new()),
        Box::new(ShellBasedSurfaceModelProcessor::new()), Box::new(FaceBasedSurfaceModelProcessor::new()),
        Box::new(BlockProcessor::new()), Box::new(SphereProcessor::new()),
        Box::new(CsgSolidProcessor::new()), Box::new(IfcAlignmentProcessor::new()),
    ];
    let router = GeometryRouter::new();
    for processor in references {
        for ifc_type in processor.supported_types() {
            // Missing attributes are a bounded decoder fixture. The actual
            // processor's error/empty mesh must survive dispatch, rather than
            // becoming the router's unsupported-type error for a missed alias.
            let source = format!("#1={}();", ifc_type.to_string().to_uppercase());
            let mut direct_decoder = EntityDecoder::new(&source);
            let mut routed_decoder = EntityDecoder::new(&source);
            let direct_entity = direct_decoder.decode_by_id(1).unwrap();
            let routed_entity = routed_decoder.decode_by_id(1).unwrap();
            let expected = processor.process(&direct_entity, &mut direct_decoder, &schema, TessellationQuality::Medium);
            let actual = router.process_representation_item(&routed_entity, &mut routed_decoder);
            match (expected, actual) {
                (Err(expected), Err(actual)) => assert_eq!(actual.to_string(), expected.to_string(), "{ifc_type:?}"),
                (Ok(expected), Ok(actual)) => {
                    assert_eq!(actual.positions, expected.positions, "{ifc_type:?}");
                    assert_eq!(actual.indices, expected.indices, "{ifc_type:?}");
                    assert_eq!(actual.normals, expected.normals, "{ifc_type:?}");
                }
                (expected, actual) => panic!("{ifc_type:?}: direct={expected:?}, routed={actual:?}"),
            }
        }
    }
}

#[test]
fn issue_3987_partial_override_preserves_the_remaining_alias_diagnostics() {
    let mut router = GeometryRouter::new();
    mesh_unsupported_boolean(&router);
    let drops = Rc::new(Cell::new(0));
    register_boolean(&mut router, vec![IfcType::IfcBooleanResult], &drops);
    assert_eq!(failure_count(&router), 1, "the clipping alias still owns the original log");
    mesh_unsupported_boolean(&router);
    assert_eq!(failure_count(&router), 1, "the replacement reports its own meshing failure");
    assert_eq!(failure_count(&router), 0, "aliases drain a shared log only once");
}

#[test]
fn issue_3987_full_override_releases_the_replaced_processor_and_its_log() {
    let mut router = GeometryRouter::new();
    mesh_unsupported_boolean(&router);
    router.register(Box::new(BooleanClippingProcessor::new()));
    assert_eq!(failure_count(&router), 0, "last-alias override must discard the old built-in log");
    let drops = Rc::new(Cell::new(0));
    register_boolean(&mut router, vec![IfcType::IfcBooleanResult, IfcType::IfcBooleanClippingResult], &drops);
    mesh_unsupported_boolean(&router);
    let replacements = Rc::new(Cell::new(0));
    register_boolean(&mut router, vec![IfcType::IfcBooleanResult], &replacements);
    assert_eq!(drops.get(), 0, "one remaining alias still owns the processor");
    register_boolean(&mut router, vec![IfcType::IfcBooleanClippingResult], &replacements);
    assert_eq!(drops.get(), 1, "the final alias releases the processor immediately");
    assert_eq!(failure_count(&router), 0, "orphaned processors cannot report stale failures");
    mesh_unsupported_boolean(&router);
    assert_eq!(failure_count(&router), 1);
}

#[test]
fn issue_3987_two_routers_cannot_share_failure_state() {
    let first = GeometryRouter::new();
    let second = GeometryRouter::new();
    mesh_unsupported_boolean(&first);
    assert_eq!(failure_count(&second), 0);
    mesh_unsupported_boolean(&second);
    assert_eq!(failure_count(&first), 1);
    assert_eq!(failure_count(&second), 1);
}
