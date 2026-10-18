// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::resource::{Dimension, ModelResourcePool, RequestAdmission, ResourceLimits};
use ifc_lite_core::EntityDecoder;

const SOURCE: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\
    #3=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)),$);\
    #4=IFCTRIANGULATEDFACESET(#3,$,.F.,((1,2,3)),$);\
    #5=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#4));#6=IFCREPRESENTATIONMAP(#2,#5);\
    #7=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);#8=IFCMAPPEDITEM(#6,#7);";

fn request(pool: &ModelResourcePool) -> ExecutionAccount {
    match pool
        .admit(ResourceLimits {
            live_bytes: Some(1_000_000),
            ..ResourceLimits::default()
        })
        .unwrap()
    {
        RequestAdmission::Ready(account) => account,
        RequestAdmission::WaitingForCapacity => panic!("independent fixture request should fit"),
    }
}

// A real canonical mapped-source cache outlives the router and failed request;
// its owning handle, rather than a dormant callback scope, retains residency.
#[test]
fn completed_canonical_cache_owns_residency_after_later_stop_and_router_drop() {
    let pool = ModelResourcePool::new(1_000_000);
    let cache = AccountedMappedItemCache::new();
    let mut router = GeometryRouter::with_scale_and_local_frame(1., false);
    router.enable_accounted_mapped_item_cache(cache.clone());
    let account = request(&pool);
    let mut decoder = EntityDecoder::new(SOURCE);
    let item = decoder.decode_by_id(8).unwrap();
    account.scope(|| {
        let meshes = router
            .process_mapped_item_parts(&item, &mut decoder)
            .unwrap();
        assert_eq!(
            meshes.iter().map(|mesh| mesh.indices.len()).sum::<usize>(),
            3
        );
        assert_eq!(router.mapped_shared_unique_count(), 1);
        resource::stop(ProgramStop::Cancelled);
    });
    drop((account, router));
    assert_eq!(pool.resident_bytes(), 1_000_000);
    let stored = cache.cache.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(stored.get(&6).unwrap().indices, [0, 1, 2]);
    drop(stored);
    drop(cache);
    assert_eq!(pool.resident_bytes(), 0);
    drop(request(&pool));
}

#[test]
fn ordinary_shared_cache_cannot_publish_bounded_storage_without_owner() {
    let pool = ModelResourcePool::new(1_000_000);
    let account = request(&pool);
    let mut router = GeometryRouter::with_scale_and_local_frame(1., false);
    router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
    let mut decoder = EntityDecoder::new(SOURCE);
    let item = decoder.decode_by_id(8).unwrap();
    account.scope(|| {
        assert!(router
            .process_mapped_item_parts(&item, &mut decoder)
            .is_err());
        assert!(
            matches!(account.check(), Err(ProgramStop::ResourceRefused(failure))
            if failure.dimension == Dimension::Coverage)
        );
        assert_eq!(router.mapped_shared_unique_count(), 0);
    });
}

#[test]
fn retained_local_hash_cache_keeps_residency_across_quality_invalidation() {
    let pool=ModelResourcePool::new(1_000_000);
    let account=request(&pool);
    let mut router=GeometryRouter::with_scale_and_local_frame(1.,false);
    let mut decoder=EntityDecoder::new(SOURCE);
    let item=decoder.decode_by_id(4).unwrap();
    account.scope(|| {
        let mesh=router.process_representation_item(&item,&mut decoder).unwrap();
        assert_eq!(mesh.indices.len(),3);
    });
    assert!(!router.geometry_hash_cache.borrow().is_empty());
    drop(account);
    router.set_tessellation_quality(crate::TessellationQuality::High);
    assert!(!router.geometry_hash_cache.borrow().is_empty(),"historical hash-cache scope is preserved");
    assert_eq!(pool.resident_bytes(),1_000_000,"quality only clears mapped entries, not retained hash geometry");
    drop(router);
    assert_eq!(pool.resident_bytes(),0);
}

// An extrusion producer retains spare backing; moving it into the local hash
// cache must admit those capacities before publishing, while cloning still
// charges only the logical payload copied into the returned mesh.
#[test]
fn canonical_extrusion_cache_miss_refuses_unadmitted_spare_backing_before_publication() {
    use crate::resource::{ExecutionPolicy, RefusalReason};
    let source = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\
        #3=IFCDIRECTION((0.,0.,1.));#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,3.);\
        #5=IFCEXTRUDEDAREASOLID(#4,#2,#3,4.);";
    let producer = GeometryRouter::with_scale_and_local_frame(1., false);
    let mut decoder = EntityDecoder::new(source);
    let item = decoder.decode_by_id(5).unwrap();
    let raw = producer.process_item_in_rtc_frame(
        producer.processor_for(&item.ifc_type).unwrap().as_ref(),
        &item, &mut decoder, producer.rtc_offset,
    ).unwrap();
    let logical = resource::mesh::MeshLengths::of(&raw).bytes().unwrap();
    let backing = resource::mesh::resident_bytes(&raw).unwrap();
    assert!(backing > logical, "real extrusion fixture must exercise spare backing");
    let limited = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        live_bytes: Some(backing - 1), ..ResourceLimits::default()
    }));
    let router = GeometryRouter::with_scale_and_local_frame(1., false);
    limited.scope(|| {
        assert!(router.process_representation_item(&item, &mut decoder).is_err());
        assert!(matches!(limited.check(), Err(ProgramStop::ResourceRefused(failure))
            if failure.dimension == Dimension::LiveBytes && failure.reason == RefusalReason::Limit
                && failure.requested == backing));
        assert!(router.geometry_hash_cache.borrow().is_empty(), "refused backing must not be published");
    });
    let admitted = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    admitted.scope(|| {
        let output = router.process_representation_item(&item, &mut decoder).unwrap();
        assert_eq!(output.positions, raw.positions);
        assert_eq!(output.normals, raw.normals);
        assert_eq!(output.indices, raw.indices);
        assert_eq!(admitted.usage().copy_bytes, logical, "only initialized payload is deep-copied");
        assert_eq!(admitted.usage().output_bytes, logical);
        assert!(admitted.usage().live_bytes >= backing + logical);
        let cache = router.geometry_hash_cache.borrow();
        assert_eq!(cache.len(), 1);
        assert_eq!(resource::mesh::resident_bytes(cache.values().next().unwrap()).unwrap(), backing);
    });
}
