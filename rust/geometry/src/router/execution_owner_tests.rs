// SPDX-License-Identifier: MPL-2.0
//! The router's execution lease: one product at a time, ordinary nested
//! routing inside that product, and configuration changes that invalidate
//! outstanding work without releasing the reservation.
use crate::{processors::BlockProcessor, GeometryProcessor, GeometryRouter, Mesh, TessellationQuality};
use ifc_lite_core::execution_owner::ExecutionLeaseError;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use std::rc::{Rc, Weak};

const SOURCE: &str = "#1=IFCBLOCK($,2.,3.,4.);#2=IFCSPHERE($,1.);";
struct NestedBlock {
    router: Weak<GeometryRouter>,
}
impl GeometryProcessor for NestedBlock {
    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcBlock]
    }
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> crate::Result<Mesh> {
        let router = self.router.upgrade().unwrap();
        assert!(
            matches!(router.try_execution_lease(), Err(ExecutionLeaseError::AlreadyLeased)),
            "a reentrant constructor cannot admit a second product"
        );
        let sphere = decoder.decode_by_id(2)?;
        let nested = router.process_representation_item(&sphere, decoder)?;
        assert!(!nested.is_empty(), "ordinary nested routing in this product remains legal");
        router.set_preserve_triangle_order(true);
        BlockProcessor::new().process(entity, decoder, schema, quality)
    }
}

#[test]
fn one_product_reserves_its_router_while_registered_processors_can_reenter_normal_geometry() {
    let router = Rc::new_cyclic(|weak: &Weak<GeometryRouter>| {
        let mut router = GeometryRouter::new();
        router.register(Box::new(NestedBlock { router: weak.clone() }));
        router
    });
    let lease = router.try_execution_lease().unwrap();
    let mut decoder = EntityDecoder::new(SOURCE);
    let block = decoder.decode_by_id(1).unwrap();
    let mesh = router.process_representation_item(&block, &mut decoder).unwrap();
    assert_eq!(mesh.triangle_count(), 12);
    assert!((crate::kernel::mesh_volume::mesh_volume(&mesh) - 24.).abs() < 1e-6);
    // Scoped triangle order is not configuration: the lease stays valid.
    lease.validate(router.execution_identity()).unwrap();
    assert_eq!(
        lease.validate(GeometryRouter::new().execution_identity()),
        Err(ExecutionLeaseError::WrongOwner)
    );
    drop(lease);
    router.try_execution_lease().expect("completed product releases router");
}

#[test]
fn configuration_and_registration_changes_invalidate_work_but_keep_exclusive_admission() {
    let changes: [fn(&mut GeometryRouter); 5] = [
        |router| router.set_tessellation_quality(TessellationQuality::High),
        |router| router.set_skip_small_cuts(true),
        |router| router.set_rtc_offset((10., 20., 30.)),
        |router| router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache()),
        |router| router.register(Box::new(BlockProcessor::new())),
    ];
    for change in changes {
        let mut router = GeometryRouter::new();
        let lease = router.try_execution_lease().unwrap();
        let mut decoder = EntityDecoder::new(SOURCE);
        let block = decoder.decode_by_id(1).unwrap();
        assert!(!router.process_representation_item(&block, &mut decoder).unwrap().is_empty());
        change(&mut router);
        assert_eq!(
            lease.validate(router.execution_identity()),
            Err(ExecutionLeaseError::ConfigurationChanged)
        );
        assert!(matches!(router.try_execution_lease(), Err(ExecutionLeaseError::AlreadyLeased)));
        drop(lease);
        let next = router.try_execution_lease().unwrap();
        next.validate(router.execution_identity()).unwrap();
    }
}
