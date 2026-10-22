// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::resource::{
    Dimension, ExecutionPolicy, ModelResourcePool, RefusalReason, RequestAdmission,
    ResourceLimits,
};
use ifc_lite_core::EntityDecoder;

const SOURCE: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\
    #3=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)),$);\
    #4=IFCTRIANGULATEDFACESET(#3,$,.F.,((1,2,3)),$);\
    #5=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#4));#6=IFCREPRESENTATIONMAP(#2,#5);\
    #7=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);#8=IFCMAPPEDITEM(#6,#7);\
    #9=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(2.,0.,0.),(0.,2.,0.)),$);\
    #10=IFCTRIANGULATEDFACESET(#9,$,.F.,((1,2,3)),$);\
    #11=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#10));#12=IFCREPRESENTATIONMAP(#2,#11);\
    #13=IFCMAPPEDITEM(#12,#7);\
    #14=IFCPOLYLINE((#1,#1));\
    #15=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#14,#4));#16=IFCREPRESENTATIONMAP(#2,#15);\
    #17=IFCMAPPEDITEM(#16,#7);";

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

fn bounded(limits: ResourceLimits) -> ExecutionAccount {
    ExecutionAccount::new(ExecutionPolicy::Bounded(limits))
}

// The mapped-source cache outlives the router and the failed request; its
// owning handle, not the caller's account, retains the pooled residency, and
// releases it exactly once when the last cache handle drops.
#[test]
fn completed_cache_owns_residency_after_later_stop_and_router_drop() {
    let pool = ModelResourcePool::new(1_000_000);
    let cache = AccountedMappedItemCache::new();
    let mut router = GeometryRouter::with_scale_and_local_frame(1., false);
    router.enable_accounted_mapped_item_cache(cache.clone());
    let account = request(&pool);
    let mut decoder = EntityDecoder::new(SOURCE);
    let item = decoder.decode_by_id(8).unwrap();
    account.scope(|| {
        let meshes = router.process_mapped_item_parts(&item, &mut decoder).unwrap();
        assert_eq!(meshes.iter().map(|mesh| mesh.indices.len()).sum::<usize>(), 3);
        assert_eq!(router.mapped_shared_unique_count(), 1);
        resource::stop(ProgramStop::Cancelled);
    });
    drop((account, router));
    assert_eq!(pool.resident_bytes(), 1_000_000, "cache retains the publishing request");
    let stored = cache.cache.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(stored.get(&6).unwrap().indices, [0, 1, 2]);
    drop(stored);
    let clone = cache.clone();
    drop(cache);
    assert_eq!(pool.resident_bytes(), 1_000_000, "a live cache handle still owns it");
    drop(clone);
    assert_eq!(pool.resident_bytes(), 0, "released once with the last cache handle");
    drop(request(&pool));
    assert_eq!(pool.resident_bytes(), 0, "no double release or leaked permit");
}

#[test]
fn ordinary_shared_cache_refuses_bounded_publication_as_unsupported_coverage() {
    let pool = ModelResourcePool::new(1_000_000);
    let account = request(&pool);
    let mut router = GeometryRouter::with_scale_and_local_frame(1., false);
    router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
    let mut decoder = EntityDecoder::new(SOURCE);
    let item = decoder.decode_by_id(8).unwrap();
    account.scope(|| {
        assert!(router.process_mapped_item_parts(&item, &mut decoder).is_err());
        assert!(matches!(account.check(), Err(ProgramStop::ResourceRefused(failure))
            if failure.dimension == Dimension::Coverage
                && failure.reason == RefusalReason::UnsupportedCoverage));
        assert_eq!(router.mapped_shared_unique_count(), 0, "nothing was published");
    });
}

// A hit is coverage too: an ordinary shared cache warmed without an account
// must not serve a bounded request silently.
#[test]
fn ordinary_shared_cache_refuses_bounded_hit_as_unsupported_coverage() {
    let pool = ModelResourcePool::new(1_000_000);
    let mut router = GeometryRouter::with_scale_and_local_frame(1., false);
    router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
    let mut decoder = EntityDecoder::new(SOURCE);
    let item = decoder.decode_by_id(8).unwrap();
    let warm = router.process_mapped_item_parts(&item, &mut decoder).unwrap();
    assert_eq!(warm.iter().map(|mesh| mesh.indices.len()).sum::<usize>(), 3);
    assert_eq!(router.mapped_shared_unique_count(), 1, "unaccounted run warmed the cache");
    let account = request(&pool);
    account.scope(|| {
        assert!(router.process_mapped_item_parts(&item, &mut decoder).is_err());
        assert!(matches!(account.check(), Err(ProgramStop::ResourceRefused(failure))
            if failure.dimension == Dimension::Coverage
                && failure.reason == RefusalReason::UnsupportedCoverage));
    });
    let again = router.process_mapped_item_parts(&item, &mut decoder).unwrap();
    assert_eq!(again[0].indices, warm[0].indices, "the default path still hits unchanged");
}

// The don't-bake shared-source walk applies the same hit rule.
#[test]
fn ordinary_shared_cache_refuses_bounded_dont_bake_hit() {
    let pool = ModelResourcePool::new(1_000_000);
    let mut router = GeometryRouter::with_scale_and_local_frame(1., false);
    router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
    let mut decoder = EntityDecoder::new(SOURCE);
    let item = decoder.decode_by_id(8).unwrap();
    router.process_mapped_item_parts(&item, &mut decoder).unwrap();
    assert_eq!(router.mapped_shared_unique_count(), 1, "unaccounted run warmed the cache");
    let rep = decoder.decode_by_id(5).unwrap();
    router.ensure_shared_mapped_source(&rep, 6, &mut decoder).unwrap();
    let account = request(&pool);
    account.scope(|| {
        assert!(router.ensure_shared_mapped_source(&rep, 6, &mut decoder).is_err());
        assert!(matches!(account.check(), Err(ProgramStop::ResourceRefused(failure))
            if failure.dimension == Dimension::Coverage
                && failure.reason == RefusalReason::UnsupportedCoverage));
    });
}

// A refused later publication leaves the earlier entry, its bytes and its
// retained owner exactly as they were.
#[test]
fn refused_publication_preserves_prior_cache_effects_exactly() {
    let cache = AccountedMappedItemCache::new();
    let mut router = GeometryRouter::with_scale_and_local_frame(1., false);
    router.enable_accounted_mapped_item_cache(cache.clone());
    let mut decoder = EntityDecoder::new(SOURCE);
    let (first, second) = (decoder.decode_by_id(8).unwrap(), decoder.decode_by_id(13).unwrap());
    let publisher = bounded(ResourceLimits::default());
    publisher.scope(|| router.process_mapped_item_parts(&first, &mut decoder)).unwrap();
    let published = publisher.usage();
    let before = Arc::clone(cache.cache.lock().unwrap().get(&6).unwrap());
    assert_eq!(cache.accounts.lock().unwrap().len(), 1);

    for limits in [
        ResourceLimits { copy_bytes: Some(0), ..Default::default() },
        ResourceLimits { live_bytes: Some(0), ..Default::default() },
        ResourceLimits { copy_bytes: Some(u64::MAX), live_bytes: Some(u64::MAX), ..Default::default() },
    ] {
        let refused = bounded(limits);
        if limits.copy_bytes == Some(u64::MAX) {
            // Saturate the ledger so the next admission overflows.
            refused
                .prepare(Cost { live_bytes: u64::MAX, ..Cost::default() })
                .unwrap()
                .retain();
        }
        let result = refused.scope(|| router.process_mapped_item_parts(&second, &mut decoder));
        assert!(matches!(result, Err(crate::Error::ProgramStopped(ProgramStop::ResourceRefused(_)))),
            "{limits:?}");
        let stored = cache.cache.lock().unwrap();
        assert_eq!(stored.len(), 1, "{limits:?}: no partial publication");
        assert!(Arc::ptr_eq(stored.get(&6).unwrap(), &before), "{limits:?}: prior entry untouched");
        drop(stored);
        assert_eq!(cache.accounts.lock().unwrap().len(), 1, "{limits:?}: no owner retained");
    }
    assert_eq!(publisher.usage(), published, "prior request ledger unchanged");
}

#[test]
fn local_hash_cache_residency_outlives_the_request_until_router_drop() {
    let pool = ModelResourcePool::new(1_000_000);
    let account = request(&pool);
    let mut router = GeometryRouter::with_scale_and_local_frame(1., false);
    let mut decoder = EntityDecoder::new(SOURCE);
    let item = decoder.decode_by_id(4).unwrap();
    account.scope(|| {
        let mesh = router.process_representation_item(&item, &mut decoder).unwrap();
        assert_eq!(mesh.indices.len(), 3);
    });
    assert!(!router.geometry_hash_cache.borrow().is_empty());
    drop(account);
    router.set_tessellation_quality(crate::TessellationQuality::High);
    assert_eq!(pool.resident_bytes(), 1_000_000, "retained hash geometry keeps its owner");
    drop(router);
    assert_eq!(pool.resident_bytes(), 0);
}

// An extrusion producer retains spare backing; moving it into the local hash
// cache must admit that capacity before publishing, while the returned copy is
// charged only for its logical payload.
#[test]
fn hash_cache_miss_refuses_unadmitted_spare_backing_before_publication() {
    let source = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\
        #3=IFCDIRECTION((0.,0.,1.));#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,3.);\
        #5=IFCEXTRUDEDAREASOLID(#4,#2,#3,4.);";
    let producer = GeometryRouter::with_scale_and_local_frame(1., false);
    let mut decoder = EntityDecoder::new(source);
    let item = decoder.decode_by_id(5).unwrap();
    let mut raw = producer
        .processor_for(&item.ifc_type)
        .unwrap()
        .lower_owned(&item, &mut decoder, producer.tessellation_quality(), None)
        .unwrap()
        .unwrap()
        .evaluate()
        .unwrap();
    crate::router::item::finish_item_mesh(&mut raw, producer.unit_scale(), None);
    let logical = resource::mesh::MeshLengths::of(&raw).bytes().unwrap();
    let backing = resource::mesh::resident_bytes(&raw).unwrap();
    assert!(backing >= logical);
    let limited = bounded(ResourceLimits {
        live_bytes: Some(backing - 1),
        ..ResourceLimits::default()
    });
    let router = GeometryRouter::with_scale_and_local_frame(1., false);
    limited.scope(|| {
        assert!(router.process_representation_item(&item, &mut decoder).is_err());
        assert!(matches!(limited.check(), Err(ProgramStop::ResourceRefused(failure))
            if failure.dimension == Dimension::LiveBytes && failure.reason == RefusalReason::Limit
                && failure.requested == backing));
        assert!(router.geometry_hash_cache.borrow().is_empty(), "refused backing is not published");
    });
    let admitted = bounded(ResourceLimits::default());
    admitted.scope(|| {
        let output = router.process_representation_item(&item, &mut decoder).unwrap();
        assert_eq!((&output.positions, &output.normals, &output.indices),
            (&raw.positions, &raw.normals, &raw.indices));
        assert_eq!(admitted.usage().copy_bytes, logical, "only initialized payload is copied");
        assert!(admitted.usage().live_bytes >= backing + logical);
        assert_eq!(router.geometry_hash_cache.borrow().len(), 1);
    });
}

#[test]
fn shared_content_dedup_cache_is_refused_rather_than_claimed_covered() {
    let mut router = GeometryRouter::with_scale_and_local_frame(1., false);
    router.enable_content_dedup_shared(GeometryRouter::new_dedup_cache());
    let mut decoder = EntityDecoder::new(SOURCE);
    let item = decoder.decode_by_id(4).unwrap();
    let account = bounded(ResourceLimits::default());
    let result = account.scope(|| router.process_representation_item(&item, &mut decoder));
    assert!(matches!(result, Err(crate::Error::ProgramStopped(ProgramStop::ResourceRefused(failure)))
        if failure.dimension == Dimension::Coverage));
    // Compatibility is unchanged: the same router still meshes without an account.
    assert_eq!(router.process_representation_item(&item, &mut decoder).unwrap().indices.len(), 3);
}

// A stop reached while walking a source is a typed terminal: the failing item
// is not recorded as an unsupported drop and no mesh is returned.
#[test]
fn program_stop_in_a_source_walk_is_terminal_not_an_unsupported_item() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let item = decoder.decode_by_id(17).unwrap();
    let plain = GeometryRouter::with_scale_and_local_frame(1., false);
    assert_eq!(plain.process_mapped_item_parts(&item, &mut decoder).unwrap()[0].indices.len(), 3);
    assert_eq!(plain.take_unsupported_items().values().sum::<u64>(), 1, "compatibility drop");

    let router = GeometryRouter::with_scale_and_local_frame(1., false);
    let account = bounded(ResourceLimits::default());
    let result = account.scope(|| {
        account.cancel();
        router.process_mapped_item_parts(&item, &mut decoder)
    });
    assert!(matches!(result, Err(crate::Error::ProgramStopped(ProgramStop::Cancelled))));
    assert!(router.take_unsupported_items().is_empty(), "a stop is not a dropped item");
    assert!(router.mapped_item_cache.borrow().is_empty());
}

// #7873: migrating each source visitor must preserve real quota refusals and
// avoid publishing a partial cache entry or counting a terminal as a drop.
#[test]
fn issue_7873_canonical_source_controllers_preserve_zero_work_refusal() {
    fn run(router: &GeometryRouter, decoder: &mut EntityDecoder, mode: u8) -> crate::Result<usize> {
        let item = decoder.decode_by_id(8).unwrap();
        let rep = decoder.decode_by_id(5).unwrap();
        match mode {
            0 => router.process_mapped_item_parts(&item, decoder)
                .map(|parts| parts.iter().map(|mesh| mesh.indices.len()).sum()),
            1 => crate::program::GeometryProgram::styled_item(
                &item, crate::SubMeshCollection::new(), false, None, router.rtc_offset())
                .drain_styled(router, decoder)
                .map(|parts| parts.sub_meshes.iter().map(|part| part.mesh.indices.len()).sum()),
            2 => {
                let map = decoder.decode_by_id(6).unwrap();
                router.process_representation_map_with_texture(&map, decoder, &rustc_hash::FxHashMap::default())
                    .map(|parts| parts.iter().map(|part| part.0.indices.len()).sum())
            }
            _ => router.ensure_shared_mapped_source(&rep, 6, decoder)
                .map(|()| router.mapped_shared_unique_count()),
        }
    }
    // Current styled controller also preserves sticky resource stops.
    for mode in [0, 1, 2, 3] {
        let mut control = GeometryRouter::with_scale_and_local_frame(1., false);
        control.enable_accounted_mapped_item_cache(AccountedMappedItemCache::new());
        assert_eq!(run(&control, &mut EntityDecoder::new(SOURCE), mode).unwrap(),
            if mode == 3 { 1 } else { 3 }, "mode {mode}: real mesh control");
        let mut router = GeometryRouter::with_scale_and_local_frame(1., false);
        router.enable_accounted_mapped_item_cache(AccountedMappedItemCache::new());
        let account = bounded(ResourceLimits { work: Some(0), ..Default::default() });
        let result = account.scope(|| run(&router, &mut EntityDecoder::new(SOURCE), mode));
        assert!(matches!(&result, Err(crate::Error::ProgramStopped(ProgramStop::ResourceRefused(failure)))
            if failure.dimension == Dimension::Work), "mode {mode}: {result:?}");
        assert!(router.take_unsupported_items().is_empty(), "mode {mode}: stop is not a drop");
        assert_eq!(router.mapped_shared_unique_count(), 0, "mode {mode}: no partial source publication");
    }
}
