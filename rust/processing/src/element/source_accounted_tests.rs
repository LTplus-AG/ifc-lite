// SPDX-License-Identifier: MPL-2.0
//! Coherent source rejection precedes real accounted geometry and owner effects.
use super::*;
use super::accounted_session_tests::admitted_router;
use super::session_tests::{SOURCE, assert_same, canonical, job, metadata, options};
use ifc_lite_core::{IfcSchema, SourceBundle};
use ifc_lite_geometry::{ExtrudedAreaSolidProcessor, GeometryProcessor, TessellationQuality};
use ifc_lite_geometry::resource::{self, ExecutionAccount, ExecutionPolicy, ResourceLimits};
use std::{cell::Cell, rc::Rc};

struct ObservedExtrusion(Rc<Cell<usize>>);
impl GeometryProcessor for ObservedExtrusion {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcExtrudedAreaSolid] }
    fn process(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        schema: &IfcSchema, quality: TessellationQuality) -> ifc_lite_geometry::Result<Mesh> {
        self.0.set(self.0.get() + 1);
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity, decoder, schema, quality)
    }
}

#[test]
fn accounted_source_mismatch_is_typed_before_geometry_and_leases_then_correct_source_succeeds() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let foreign = SourceBundle::new(SOURCE.replace("IFCWALL", "IFCBEAM").into_bytes());
    assert_eq!(source.bytes().len(), foreign.bytes().len());
    let context = ProductionModel::from_source(source.clone()).snapshot(OwnedMeshProductionData::default());
    let entity = source.decoder().decode_by_id(10).unwrap();
    let meta = metadata(10);
    let input = job(&entity, &meta);
    for revoked in [false, true] {
        let mut decoder = if revoked { source.decoder() } else { foreign.decoder() };
        if revoked {
            decoder.inject_shared_cache(&FxHashMap::default());
            assert!(!source.owns_decoder(&decoder), "even an empty raw import revokes authority");
        }
        let calls = Rc::new(Cell::new(0));
        let mut router = admitted_router(&mut decoder);
        router.register(Box::new(ObservedExtrusion(calls.clone())));
        let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
        let result = produce_element_meshes_owned_accounted(&input, &context, &options(),
            &mut decoder, &router, &account);
        assert_eq!(result.err(), Some(AccountedProductionError::Context(
            ProductionContextError::MismatchedSource)));
        assert_eq!(calls.get(), 0, "foreign/revoked source must not reach geometry callbacks");
        assert_eq!(account.usage(), resource::Usage::default());
        assert!(decoder.try_execution_lease().is_ok());
        assert!(router.try_execution_lease().is_ok());
        assert!(resource::current_account().is_none());
        let mut correct = source.decoder();
        let output = produce_element_meshes_owned_accounted(&input, &context, &options(),
            &mut correct, &router, &account).unwrap();
        assert_same(output.output(), &canonical(10, false));
        assert_eq!(calls.get(), 1, "correct source must produce the real extrusion after rejection");
        assert!(correct.try_execution_lease().is_ok());
        assert!(router.try_execution_lease().is_ok());
    }
}
