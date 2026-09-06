// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use crate::{BoolFailure, Mesh, Result, TessellationQuality};

const UNSUPPORTED_BOOLEAN: &str = "#1=IFCBOOLEANRESULT(.DIFFERENCE.,#2,#3);\n\
    #2=IFCSECTIONEDSPINE($,(),());\n#3=IFCEXTRUDEDAREASOLID($,$,$,1.);";

fn mesh_unsupported_boolean(registry: &ProcessorRegistry) {
    let mut decoder = EntityDecoder::new(UNSUPPORTED_BOOLEAN);
    let entity = decoder.decode_by_id(1).unwrap();
    let mesh = registry.get(&entity.ifc_type, &IfcSchema::new()).unwrap()
        .process(&entity, &mut decoder, &IfcSchema::new(), TessellationQuality::Medium)
        .unwrap();
    assert!(mesh.is_empty(), "unsupported base operands must not invent geometry");
}

fn failure_count(registry: &ProcessorRegistry) -> usize {
    registry.values().map(|p| p.take_bool_failures().len()).sum()
}

// A consumer can replace only one of a processor's supported IFC types. Use
// the real boolean mesher to exercise its diagnostic state across that boundary.
struct SingleTypeBoolean(BooleanClippingProcessor);

impl GeometryProcessor for SingleTypeBoolean {
    fn process(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        schema: &IfcSchema, quality: TessellationQuality) -> Result<Mesh> {
        self.0.process(entity, decoder, schema, quality)
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcBooleanResult]
    }

    fn take_bool_failures(&self) -> Vec<BoolFailure> {
        self.0.take_bool_failures()
    }
}

#[test]
fn issue_3987_default_dispatch_preserves_every_advertised_subtype() {
    // Dispatch must cover each processor's own compatibility contract, including
    // less-common subtypes such as IfcTriangulatedIrregularNetwork. Aliases must
    // share an instance so processing and destructive diagnostics share state.
    let registry = ProcessorRegistry::new();
    for index in 0..TYPES.len() {
        let reference = create(index, &IfcSchema::new());
        let supported = reference.supported_types();
        assert_eq!(TYPES[index], supported.as_slice());
        let first = registry.get(&supported[0], &IfcSchema::new()).unwrap();
        for ifc_type in supported {
            let processor = registry.get(&ifc_type, &IfcSchema::new()).expect("advertised IFC subtype must route");
            assert!(processor.supported_types().contains(&ifc_type));
            assert!(Rc::ptr_eq(first, processor), "aliases must retain one failure log");
        }
    }
}

#[test]
fn issue_3987_partial_override_preserves_the_remaining_alias_diagnostics() {
    let mut registry = ProcessorRegistry::new();
    mesh_unsupported_boolean(&registry);
    registry.insert(IfcType::IfcBooleanResult,
        Rc::new(SingleTypeBoolean(BooleanClippingProcessor::new())));
    assert_eq!(failure_count(&registry), 1, "the clipping alias still owns the original log");
    mesh_unsupported_boolean(&registry);
    assert_eq!(failure_count(&registry), 1, "the replacement must report its own meshing failure");
    assert_eq!(failure_count(&registry), 0, "diagnostics are drained once");
}

#[test]
fn issue_3987_full_override_releases_the_replaced_processor_and_its_log() {
    let mut registry = ProcessorRegistry::new();
    mesh_unsupported_boolean(&registry);
    let original = Rc::downgrade(registry.get(&IfcType::IfcBooleanResult, &IfcSchema::new()).unwrap());
    let replacement: Rc<dyn GeometryProcessor> = Rc::new(BooleanClippingProcessor::new());
    for ifc_type in replacement.supported_types() {
        registry.insert(ifc_type, replacement.clone());
    }
    assert!(original.upgrade().is_none(), "last-alias replacement must release retained state");
    assert_eq!(failure_count(&registry), 0, "an orphaned old processor cannot report failures");
    mesh_unsupported_boolean(&registry);
    assert_eq!(failure_count(&registry), 1);
}

#[test]
fn issue_3987_two_routers_cannot_share_failure_state() {
    let first = ProcessorRegistry::new();
    let second = ProcessorRegistry::new();
    mesh_unsupported_boolean(&first);
    assert_eq!(failure_count(&second), 0);
    mesh_unsupported_boolean(&second);
    assert_eq!(failure_count(&first), 1);
    assert_eq!(failure_count(&second), 1);
}
