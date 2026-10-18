// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::{Mesh, SubMeshCollection, GeometryProcessor, TessellationQuality};
use crate::processors::BlockProcessor;
use ifc_lite_core::{IfcSchema, IfcType};
use std::{cell::Cell, rc::Rc, sync::Arc};

const BASE: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);#10=IFCBLOCK(#2,1.,2.,3.);
#11=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10));#12=IFCREPRESENTATIONMAP(#2,#11);
#13=IFCMAPPEDITEM(#12,#3);";

fn submeshes(router: &GeometryRouter, decoder: &mut EntityDecoder<'_>, id: u32) -> SubMeshCollection {
    let item = decoder.decode_by_id(id).unwrap();
    let mut meshes = SubMeshCollection::new();
    router.collect_submeshes_from_item(&item, decoder, &mut meshes, false, None).unwrap();
    meshes
}
fn parts(router: &GeometryRouter, decoder: &mut EntityDecoder<'_>, id: u32) -> Vec<Mesh> {
    let item = decoder.decode_by_id(id).unwrap();
    router.process_mapped_item_parts(&item, decoder).unwrap()
}
fn triangles(parts: &[Mesh]) -> usize { parts.iter().map(|mesh| mesh.indices.len() / 3).sum() }

#[test]
fn repeated_mapped_dag_edges_are_occurrences_in_both_consumers() {
    let source = format!("{BASE}#20=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#13,#13));
        #21=IFCREPRESENTATIONMAP(#2,#20);#22=IFCMAPPEDITEM(#21,#3);");
    let router = GeometryRouter::new();
    let mut decoder = EntityDecoder::new(&source);
    let merged = parts(&router, &mut decoder, 22);
    assert_eq!(triangles(&merged), 24);
    let styled = submeshes(&router, &mut decoder, 22);
    assert_eq!(styled.len(), 2);
    assert!(styled.sub_meshes.iter().all(|sub| sub.geometry_id == 10 && sub.mesh.indices.len() == 36));
}

#[test]
fn cache_hit_skips_source_representation_but_preserves_transform_admission() {
    let source = format!("{BASE}#30=IFCREPRESENTATIONMAP(#2,#999);#31=IFCMAPPEDITEM(#30,#3);
        #32=IFCMAPPEDITEM(#30,#998);");
    let mut decoder = EntityDecoder::new(&source);
    let router = GeometryRouter::new();
    let cached = parts(&router, &mut decoder, 13).remove(0);
    router.publish_mapped_source(30, &cached, false).unwrap();
    let merged = parts(&router, &mut decoder, 31);
    assert_eq!(merged[0].positions, cached.positions);
    assert_eq!(merged[0].indices, cached.indices);
    let item = decoder.decode_by_id(31).unwrap();
    let mut styled = SubMeshCollection::new();
    let error = router.collect_submeshes_from_item(&item, &mut decoder, &mut styled, false, None).unwrap_err();
    assert!(error.to_string().contains("999"), "submesh path must resolve representation before any cache: {error}");
    let broken_target = decoder.decode_by_id(32).unwrap();
    let merged_error = router.process_mapped_item_parts(&broken_target, &mut decoder).unwrap_err();
    assert!(merged_error.to_string().contains("998"), "transform admission precedes a merged cache hit: {merged_error}");
    let styled_error = router.collect_submeshes_from_item(&broken_target, &mut decoder,
        &mut styled, false, None).unwrap_err();
    assert!(styled_error.to_string().contains("999"), "styled representation admission precedes that same transform: {styled_error}");
    // A cached source must not bypass a missing MappingSource admission.
    let missing = format!("{BASE}#31=IFCMAPPEDITEM(#999,#3);");
    let mut missing = EntityDecoder::new(&missing);
    let item = missing.decode_by_id(31).unwrap();
    assert!(router.process_mapped_item_parts(&item, &mut missing).is_err());
}

#[test]
fn maximum_depth_applies_to_plain_submesh_children_but_not_merged_source_leaves() {
    let mut source = BASE.to_string();
    let depth = ifc_lite_core::MAX_MAPPED_ITEM_DEPTH;
    for index in 0..depth {
        let map = 100 + index * 3;
        let next = if index + 1 == depth { 10 } else { map + 5 };
        source.push_str(&format!("#{map}=IFCREPRESENTATIONMAP(#2,#{rep});
            #{rep}=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#{next}));
            #{item}=IFCMAPPEDITEM(#{map},#3);", rep = map + 1, item = map + 2));
    }
    let mut decoder = EntityDecoder::new(&source);
    let merged_router = GeometryRouter::new();
    assert_eq!(triangles(&parts(&merged_router, &mut decoder, 102)), 12);
    let styled_router = GeometryRouter::new();
    assert!(submeshes(&styled_router, &mut decoder, 102).is_empty());
    assert_eq!(styled_router.take_unsupported_items().get("IfcBlock"), Some(&1));
}

struct RepairSource { calls: Rc<Cell<usize>> }
impl GeometryProcessor for RepairSource {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcBlock] }
    fn process(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        schema: &IfcSchema, quality: TessellationQuality) -> Result<Mesh> {
        self.calls.set(self.calls.get() + 1);
        // A real mutable-decoder extension repairs an unavailable source after
        // the first child failed. The next occurrence tests error-path policy.
        let source = decoder.decode_by_id(12).unwrap();
        decoder.inject_shared_cache(&[(999, Arc::new(source))].into_iter().collect());
        BlockProcessor::new().process(entity, decoder, schema, quality)
    }
}
#[test]
fn failed_submesh_path_ids_remain_sticky_while_merged_paths_are_released() {
    let source = format!("{BASE}#30=IFCMAPPEDITEM(#999,#3);
        #40=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#30,#10,#30));
        #41=IFCREPRESENTATIONMAP(#2,#40);#42=IFCMAPPEDITEM(#41,#3);");
    let calls = Rc::new(Cell::new(0));
    let mut router = GeometryRouter::new();
    router.register(Box::new(RepairSource { calls: calls.clone() }));
    let mut decoder = EntityDecoder::new(&source);
    let styled = submeshes(&router, &mut decoder, 42);
    assert_eq!(styled.len(), 1, "failed mapped child remains on this styled path after repair");
    assert_eq!(calls.get(), 1);
    assert_eq!(router.take_unsupported_items().get("IfcMappedItem"), Some(&2));
    let calls = Rc::new(Cell::new(0));
    let mut router = GeometryRouter::new();
    router.register(Box::new(RepairSource { calls: calls.clone() }));
    let mut decoder = EntityDecoder::new(&source);
    assert_eq!(triangles(&parts(&router, &mut decoder, 42)), 24);
    assert_eq!(calls.get(), 2, "merged child can be retried after a failed admission");
    assert_eq!(router.take_unsupported_items().get("IfcMappedItem"), Some(&1));
}

#[test]
fn failed_bulk_item_admission_claims_only_the_submesh_source_and_runs_no_earlier_item() {
    let source = format!("{BASE}#90=IFCPOLYLINE((#1,#1));
        #20=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10,#999));
        #21=IFCREPRESENTATIONMAP(#2,#20);#22=IFCMAPPEDITEM(#21,#3);");
    for merged in [true, false] {
        let mut decoder = EntityDecoder::new(&source);
        let router = GeometryRouter::new();
        let item = decoder.decode_by_id(22).unwrap();
        let mut meshes = SubMeshCollection::new();
        let result = if merged { router.process_mapped_item_parts(&item, &mut decoder).map(|_| ()) }
            else { router.collect_submeshes_from_item(&item, &mut decoder, &mut meshes, false, None) };
        assert!(result.is_err());
        assert!(meshes.is_empty());
        assert!(router.cached_mapped_source(21).is_none(), "bulk failure must precede meshing and cache publication");
        assert!(router.take_unsupported_items().is_empty());
        let repaired = decoder.decode_by_id(90).unwrap();
        decoder.inject_shared_cache(&[(999, Arc::new(repaired))].into_iter().collect());
        if merged {
            assert_eq!(triangles(&parts(&router, &mut decoder, 22)), 12);
            assert_eq!(router.take_unsupported_items().get("IfcPolyline"), Some(&1));
        } else {
            assert_eq!(submeshes(&router, &mut decoder, 22).len(), 1);
            assert!(router.take_unsupported_items().is_empty(), "failed styled bulk read already claimed its source");
        }
    }
}

#[test]
fn owned_source_counting_policy_is_installed_only_during_reached_steps() {
    let source = format!("{BASE}#90=IFCPOLYLINE((#1,#1));
        #20=IFCSHAPEREPRESENTATION($,'Body','CSG',(#90));
        #21=IFCREPRESENTATIONMAP(#2,#20);#22=IFCMAPPEDITEM(#21,#3);
        #50=IFCSHAPEREPRESENTATION($,'FootPrint','Curve2D',());");
    for merged in [true, false] {
        let mut decoder = EntityDecoder::new(&source);
        let router = GeometryRouter::new();
        let item = decoder.decode_by_id(22).unwrap();
        let footprint = decoder.decode_by_id(50).unwrap();
        if merged {
            let mut walk = MergedWalk::new(&item, &router).unwrap();
            assert!(walk.advance(&router, &mut decoder)); // Claim and own the Body source policy.
            let ambient = router.enter_unsupported_source(500, &footprint);
            assert_eq!(triangles(&walk.run(&router, &mut decoder).unwrap()), 0);
            router.record_unsupported_item(IfcType::IfcBlock); // Ambient FootPrint still suppresses this.
            let counts = router.take_unsupported_items();
            assert_eq!(counts.get("IfcPolyline"), Some(&1));
            assert!(!counts.contains_key("IfcBlock"));
            drop(ambient);
        } else {
            let mut meshes = SubMeshCollection::new();
            let mut walk = SubmeshWalk::new(&item, false, &router).unwrap();
            assert!(walk.advance(&router, &mut decoder, &mut meshes, None));
            let ambient = router.enter_unsupported_source(500, &footprint);
            walk.run(&router, &mut decoder, &mut meshes, None).unwrap();
            router.record_unsupported_item(IfcType::IfcBlock);
            let counts = router.take_unsupported_items();
            assert_eq!(counts.get("IfcPolyline"), Some(&1));
            assert!(!counts.contains_key("IfcBlock"));
            drop(ambient);
        }
        assert!(router.unsupported_policy(), "no owned frame keeps a guard on the router");
    }
}

struct PanickingBlock;
impl GeometryProcessor for PanickingBlock {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcBlock] }
    fn process(&self, _: &DecodedEntity, _: &mut EntityDecoder, _: &IfcSchema,
        _: TessellationQuality) -> Result<Mesh> { panic!("mapped extension interrupted"); }
}
#[test]
fn mapped_custom_panic_restores_ambient_policy_and_never_publishes_partial_source() {
    for merged in [true, false] {
        let mut decoder = EntityDecoder::new(BASE);
        let mut router = GeometryRouter::new();
        router.register(Box::new(PanickingBlock));
        let item = decoder.decode_by_id(13).unwrap();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if merged { router.process_mapped_item_parts(&item, &mut decoder).map(|_| ()) }
            else { router.collect_submeshes_from_item(&item, &mut decoder, &mut SubMeshCollection::new(), false, None) }
        }));
        assert!(result.is_err());
        assert!(router.unsupported_policy());
        assert!(router.cached_mapped_source(12).is_none());
        // A post-panic unsupported top-level item must report independently.
        router.record_unsupported_item(IfcType::IfcPolyline);
        assert_eq!(router.take_unsupported_items().get("IfcPolyline"), Some(&1));
    }
}

struct NestedBody { router: std::rc::Weak<GeometryRouter>, merged: bool, calls: Rc<Cell<usize>> }
impl GeometryProcessor for NestedBody {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcBlock] }
    fn process(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        schema: &IfcSchema, quality: TessellationQuality) -> Result<Mesh> {
        self.calls.set(self.calls.get() + 1);
        let router = self.router.upgrade().unwrap();
        assert!(!router.unsupported_policy(), "outer FootPrint suppresses only its own drops");
        let inner = decoder.decode_by_id(42).unwrap();
        if self.merged {
            assert_eq!(triangles(&router.process_mapped_item_parts(&inner, decoder)?), 0);
        } else {
            let mut meshes = SubMeshCollection::new();
            router.collect_submeshes_from_item(&inner, decoder, &mut meshes, false, None)?;
            assert!(meshes.is_empty());
        }
        assert!(!router.unsupported_policy(), "return restores the interrupted outer source policy");
        BlockProcessor::new().process(entity, decoder, schema, quality)
    }
}
#[test]
fn reentrant_body_source_reports_inside_suppressed_footprint_and_restores_outer_policy() {
    let source = format!("{BASE}#90=IFCPOLYLINE((#1,#1));
        #20=IFCSHAPEREPRESENTATION($,'FootPrint','Curve2D',(#10));
        #21=IFCREPRESENTATIONMAP(#2,#20);#22=IFCMAPPEDITEM(#21,#3);
        #40=IFCSHAPEREPRESENTATION($,'Body','CSG',(#90));
        #41=IFCREPRESENTATIONMAP(#2,#40);#42=IFCMAPPEDITEM(#41,#3);");
    for merged in [true, false] {
        let calls = Rc::new(Cell::new(0));
        let mut base = GeometryRouter::new();
        let router = Rc::new_cyclic(|weak| {
            base.register(Box::new(NestedBody { router: weak.clone(), merged, calls: calls.clone() }));
            base
        });
        let mut decoder = EntityDecoder::new(&source);
        if merged { assert_eq!(triangles(&parts(&router, &mut decoder, 22)), 12); }
        else { assert_eq!(submeshes(&router, &mut decoder, 22).len(), 1); }
        assert_eq!(calls.get(), 1, "a real outer solid callback reached the nested source");
        assert_eq!(router.take_unsupported_items().get("IfcPolyline"), Some(&1));
        assert!(router.unsupported_policy());
    }
}

#[test]
fn repeated_diamond_dag_retains_all_256_authored_occurrences() {
    let mut source = BASE.to_owned();
    let mut previous = 13;
    for level in 0..8 {
        let map = 100 + level * 3;
        source.push_str(&format!("#{map}=IFCREPRESENTATIONMAP(#2,#{rep});
            #{rep}=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#{previous},#{previous}));
            #{item}=IFCMAPPEDITEM(#{map},#3);", rep = map + 1, item = map + 2));
        previous = map + 2;
    }
    let mut decoder = EntityDecoder::new(&source);
    let router = GeometryRouter::new();
    assert_eq!(triangles(&parts(&router, &mut decoder, previous)), 256 * 12);
    let styled = submeshes(&router, &mut decoder, previous);
    assert_eq!(styled.len(), 256);
    assert_eq!(styled.sub_meshes.iter().map(|sub| sub.mesh.indices.len() / 3).sum::<usize>(), 256 * 12);
}
