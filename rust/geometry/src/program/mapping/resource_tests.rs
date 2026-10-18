// SPDX-License-Identifier: MPL-2.0
//! Accumulating mapping invariants: repeated paths are real geometry, not cycles.
use super::*;
use ifc_lite_core::IfcType;
use crate::{Mesh, SubMeshCollection, AccountedMappedItemCache, GeometryProcessor};
use crate::resource::{ExecutionAccount, ExecutionPolicy, ResourceLimits, Dimension, ProgramStop};
use std::sync::Arc;
const BASE: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\
#3=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);#10=IFCBLOCK(#2,1.,2.,3.);\
#11=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10));#12=IFCREPRESENTATIONMAP(#2,#11);\
#13=IFCMAPPEDITEM(#12,#3);#14=IFCMAPPEDITEM(#12,#3);\
#20=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#13,#14));\
#21=IFCREPRESENTATIONMAP(#2,#20);#22=IFCMAPPEDITEM(#21,#3);\
#23=IFCMAPPEDITEM(#21,#3);#30=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#22,#23));\
#31=IFCREPRESENTATIONMAP(#2,#30);#32=IFCMAPPEDITEM(#31,#3);";
fn account(limits: ResourceLimits) -> ExecutionAccount { ExecutionAccount::new(ExecutionPolicy::Bounded(limits)) }
fn router(shared: bool) -> GeometryRouter {
    let mut router = GeometryRouter::new();
    if shared { router.enable_accounted_mapped_item_cache(AccountedMappedItemCache::new()); }
    router
}
fn run(router: &GeometryRouter, source: &str, id: u32, styled: bool) -> crate::Result<Vec<Mesh>> {
    let mut decoder = EntityDecoder::new(source);
    let item = decoder.decode_by_id(id).unwrap();
    if styled {
        let mut output = SubMeshCollection::new();
        router.collect_submeshes_from_item(&item, &mut decoder, &mut output, false, None)?;
        Ok(output.sub_meshes.into_iter().map(|sub| { assert!(sub.uvs.is_none()); sub.mesh }).collect())
    } else { router.process_mapped_item_parts(&item, &mut decoder) }
}
fn same_meshes(actual: &[Mesh], expected: &[Mesh]) {
    assert_eq!(actual.len(), expected.len());
    for (a,b) in actual.iter().zip(expected) {
        assert_eq!(a.positions,b.positions); assert_eq!(a.normals,b.normals); assert_eq!(a.indices,b.indices);
        assert_eq!(a.origin,b.origin); assert_eq!(a.rtc_applied,b.rtc_applied);
        assert_eq!(a.local_bounds,b.local_bounds); assert_eq!(a.local_to_world,b.local_to_world);
        assert_eq!(a.welded_in_object_frame,b.welded_in_object_frame); assert_eq!(a.plane_tags,b.plane_tags);
        assert_eq!(format!("{:?}", a.instance_meta),format!("{:?}", b.instance_meta));
    }
}
#[test]
fn resource_accumulating_diamond_preserves_order_frames_and_instances_on_miss_and_hit() {
    for styled in [false,true] { for shared in [false,true] {
        let baseline = router(shared);
        let bounded = router(shared);
        let account = account(ResourceLimits::default());
        for _ in 0..2 {
            let expected = run(&baseline,BASE,32,styled).unwrap();
            let actual = account.scope(|| run(&bounded,BASE,32,styled)).unwrap();
            same_meshes(&actual,&expected);
            assert_eq!(actual.iter().map(|mesh|mesh.indices.len()).sum::<usize>(), 144);
        }
        assert!(account.usage().occurrences >= if styled { 22 } else { 2 });
        assert!(account.usage().copy_bytes > 0);
    }}
}
#[test]
fn resource_cache_hit_charges_copy_and_refuses_without_destroying_completed_source() {
    for shared in [false,true] {
        let router = router(shared);
        let expected = run(&router,BASE,13,false).unwrap();
        let account = account(ResourceLimits { copy_bytes: Some(0), ..ResourceLimits::default() });
        assert!(account.scope(|| run(&router,BASE,13,false)).is_err());
        assert!(matches!(account.check(),Err(ProgramStop::ResourceRefused(failure)) if failure.dimension==Dimension::CopyBytes));
        same_meshes(&run(&router,BASE,13,false).unwrap(),&expected);
    }
}
#[test]
fn resource_zero_geometry_occurrences_still_exhaust_the_occurrence_dimension() {
    let source = BASE.replace("(#10)","()");
    for styled in [false,true] {
        let router = router(false);
        let account = account(ResourceLimits { occurrences: Some(1), ..ResourceLimits::default() });
        assert!(account.scope(|| run(&router,&source,32,styled)).is_err());
        assert!(matches!(account.check(),Err(ProgramStop::ResourceRefused(failure)) if failure.dimension==Dimension::Occurrences));
    }
}
#[test]
fn resource_failed_dependent_template_rolls_back_materialized_identity() {
    let mut router = router(true);
    router.enable_output_instancing(Arc::new([(12,(2,13))].into_iter().collect()));
    router.set_instancing_batch_local(true);
    let limited = account(ResourceLimits { copy_bytes: Some(0), ..ResourceLimits::default() });
    let mut decoder = EntityDecoder::new(BASE);
    let item = decoder.decode_by_id(13).unwrap();
    let mut output = SubMeshCollection::new();
    assert!(limited.scope(|| router.collect_submeshes_from_item(&item,&mut decoder,&mut output,true,None)).is_err());
    assert!(output.is_empty());
    assert!(!router.materialized_source_handle().borrow().contains(&12));
    // A fresh request must materialize actual geometry rather than a placeholder.
    let retry = account(ResourceLimits::default());
    retry.scope(|| router.collect_submeshes_from_item(&item,&mut decoder,&mut output,true,None)).unwrap();
    assert_eq!(output.len(),1);
    assert!(!output.sub_meshes[0].mesh.positions.is_empty());
    assert!(router.materialized_source_handle().borrow().contains(&12));
}
struct StopAtLeaf;
impl GeometryProcessor for StopAtLeaf {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcBlock] }
    fn process(&self, entity:&DecodedEntity, decoder:&mut EntityDecoder,
        schema:&ifc_lite_core::IfcSchema, quality:crate::TessellationQuality) -> crate::Result<Mesh> {
        if entity.id==90 { return Err(crate::resource::stop(ProgramStop::Cancelled).into()) }
        crate::processors::BlockProcessor::new().process(entity,decoder,schema,quality)
    }
}
#[test]
fn resource_later_branch_stop_keeps_earlier_completed_source_cache() {
    let source=format!("{}#90=IFCBLOCK(#2,1.,1.,1.);",BASE.replace("(#13,#14)","(#13,#90)"));
    for shared in [false,true] {
        let mut router=router(shared);
        router.register(Box::new(StopAtLeaf));
        let geometry=run(&GeometryRouter::new(),BASE,13,false).unwrap();
        let limited=account(ResourceLimits::default());
        assert!(limited.scope(||run(&router,&source,22,false)).is_err());
        assert_eq!(limited.check(),Err(ProgramStop::Cancelled));
        assert!(router.cached_mapped_source(12).is_some());
        assert!(router.cached_mapped_source(21).is_none());
        let next=account(ResourceLimits::default());
        same_meshes(&next.scope(||run(&router,BASE,13,false)).unwrap(),&geometry);
    }
}

// A metadata-only occurrence is still admitted, even when it carries no payload
// vertices. Stopping before its Vec growth must not append a partial occurrence.
#[test]
fn resource_instance_placeholders_consume_occurrence_allowance() {
    let mut router = router(true);
    router.enable_output_instancing(Arc::new([(12,(2,13))].into_iter().collect()));
    let mut decoder = EntityDecoder::new(BASE);
    let item = decoder.decode_by_id(14).unwrap();
    let mut output = SubMeshCollection::new();
    let limited = account(ResourceLimits { occurrences: Some(0), ..ResourceLimits::default() });
    assert!(limited.scope(||router.collect_submeshes_from_item(&item,&mut decoder,&mut output,true,None)).is_err());
    assert!(output.is_empty());
    let enough = account(ResourceLimits { occurrences: Some(1), ..ResourceLimits::default() });
    enough.scope(||router.collect_submeshes_from_item(&item,&mut decoder,&mut output,true,None)).unwrap();
    assert_eq!(output.len(),1);
    assert!(output.sub_meshes[0].mesh.positions.is_empty());
    assert!(output.sub_meshes[0].mesh.instance_meta.is_some());
    assert_eq!(enough.usage().occurrences,1);
}

#[test]
fn resource_recoverable_source_fault_does_not_commit_an_empty_template_marker() {
    let malformed=BASE.replace("#10=IFCBLOCK(#2,1.,2.,3.);","#10=IFCBLOCK(#2,$,2.,3.);");
    let mut router=router(true);
    router.enable_output_instancing(Arc::new([(12,(2,13))].into_iter().collect()));
    router.set_instancing_batch_local(true);
    let first=account(ResourceLimits::default());
    let mut decoder=EntityDecoder::new(&malformed);
    let item=decoder.decode_by_id(13).unwrap();
    let mut output=SubMeshCollection::new();
    first.scope(||router.collect_submeshes_from_item(&item,&mut decoder,&mut output,true,None)).unwrap();
    assert!(output.is_empty());
    assert_eq!(first.check(),Ok(()),"original source loss remains recoverable");
    assert!(!router.materialized_source_handle().borrow().contains(&12));
    let mut repaired=EntityDecoder::new(BASE);
    let item=repaired.decode_by_id(13).unwrap();
    let next=account(ResourceLimits::default());
    next.scope(||router.collect_submeshes_from_item(&item,&mut repaired,&mut output,true,None)).unwrap();
    assert!(!output.sub_meshes[0].mesh.is_empty(),"next admitted request must produce a real template");
}
