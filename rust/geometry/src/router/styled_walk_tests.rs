// SPDX-License-Identifier: MPL-2.0
//! The styled and type-map walks on the common mapping controller: ordered
//! per-item sub-meshes, nesting bounds, the don't-bake template claim and
//! placeholder, and once-per-source drop counting across every walk.
use crate::math::mat4;
use crate::processors::BlockProcessor;
use crate::program::GeometryProgram;
use crate::{AccountedMappedItemCache, Error, GeometryProcessor, GeometryRouter, Mesh, Result, SubMeshCollection,
    TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use rustc_hash::FxHashMap;
use std::sync::Arc;
use std::{cell::Cell, rc::Rc};

/// Block #10 in map #12 (rep #11), mapped by #13 (identity) and #15 (moved
/// 10 units in x). #20/#21/#22: a second map whose items are block #16, the
/// nested mapped item #13 and block #17, in that order.
const BASE: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\
    #3=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);#10=IFCBLOCK(#2,1.,2.,3.);\
    #11=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10));#12=IFCREPRESENTATIONMAP(#2,#11);\
    #13=IFCMAPPEDITEM(#12,#3);#14=IFCCARTESIANPOINT((10.,0.,0.));\
    #4=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#14,1.,$);#15=IFCMAPPEDITEM(#12,#4);\
    #5=IFCCARTESIANPOINT((0.,0.,5.));#6=IFCAXIS2PLACEMENT3D(#5,$,$);\
    #16=IFCBLOCK(#6,4.,4.,4.);#17=IFCBLOCK(#2,7.,1.,1.);\
    #20=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#16,#13,#17));\
    #21=IFCREPRESENTATIONMAP(#2,#20);#22=IFCMAPPEDITEM(#21,#4);";

fn styled(router: &GeometryRouter, decoder: &mut EntityDecoder, id: u32, allow_instancing: bool)
    -> Result<SubMeshCollection> {
    let item = decoder.decode_by_id(id).unwrap();
    GeometryProgram::styled_item(&item, SubMeshCollection::new(), allow_instancing, None, router.rtc_offset())
        .drain_styled(router, decoder)
}

fn parts(router: &GeometryRouter, decoder: &mut EntityDecoder, id: u32) -> Vec<Mesh> {
    let item = decoder.decode_by_id(id).unwrap();
    GeometryProgram::mapped_item(&item).drain_parts(router, decoder).unwrap()
}

fn type_map(router: &GeometryRouter, decoder: &mut EntityDecoder, id: u32) -> Vec<Mesh> {
    let map = decoder.decode_by_id(id).unwrap();
    let parts = router.process_representation_map_with_texture(&map, decoder, &FxHashMap::default()).unwrap();
    parts.into_iter().map(|(mesh, _, _)| mesh).collect()
}

fn translation(x: f64) -> [f64; 16] {
    mat4::from_na(&nalgebra::Matrix4::new_translation(&nalgebra::Vector3::new(x, 0.0, 0.0)))
}

/// Each item keeps its own sub-mesh in item order, nested maps included, and
/// is baked by every mapping above it to the bytes the merged walk produces;
/// an instanceable sub-mesh records the non-trivial target it was baked by.
#[test]
fn nested_styled_items_keep_their_ids_and_bake_like_the_merged_walk() {
    let mut decoder = EntityDecoder::new(BASE);
    let meshes = styled(&GeometryRouter::new(), &mut decoder, 22, false).unwrap();
    let ids: Vec<u32> = meshes.sub_meshes.iter().map(|sub| sub.geometry_id).collect();
    assert_eq!(ids, [16, 10, 17]);
    let merged = parts(&GeometryRouter::new(), &mut decoder, 22).remove(0);
    let positions: Vec<f32> = meshes.sub_meshes.iter().flat_map(|sub| sub.mesh.positions.iter().copied()).collect();
    assert_eq!(positions, merged.positions);
    for sub in &meshes.sub_meshes {
        let instance = sub.mesh.instance_meta.as_ref().filter(|instance| instance.instanceable);
        assert_eq!(instance.unwrap().local_transform, Some(translation(10.0)), "#{}", sub.geometry_id);
    }
}

/// `MAX_MAPPED_ITEM_DEPTH` bounds every styled item, plain ones too, and the
/// cut item is recorded as its own type. A type map's nested item is a root
/// occurrence, so the same chain under a type map still reaches its block.
#[test]
fn depth_bounds_plain_styled_items_and_a_type_map_starts_a_fresh_path() {
    let mut source = BASE.to_string();
    let depth = ifc_lite_core::MAX_MAPPED_ITEM_DEPTH;
    for index in 0..depth {
        let map = 100 + index * 3;
        let next = if index + 1 == depth { 10 } else { map + 5 };
        source.push_str(&format!("#{map}=IFCREPRESENTATIONMAP(#2,#{rep});\
            #{rep}=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#{next}));\
            #{item}=IFCMAPPEDITEM(#{map},#3);", rep = map + 1, item = map + 2));
    }
    source.push_str("#901=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#102));\
        #900=IFCREPRESENTATIONMAP(#2,#901);");
    let mut decoder = EntityDecoder::new(&source);
    let router = GeometryRouter::new();
    assert!(styled(&router, &mut decoder, 102, false).unwrap().is_empty());
    assert_eq!(router.take_unsupported_items().get("IfcBlock"), Some(&1));
    let router = GeometryRouter::new();
    assert_eq!(parts(&router, &mut decoder, 102)[0].indices.len(), 36);
    let router = GeometryRouter::new();
    assert_eq!(type_map(&router, &mut decoder, 900)[0].indices.len(), 36);
    assert!(router.take_unsupported_items().is_empty());
}

/// A nested styled admission that fails is one recorded `IfcMappedItem` drop
/// per occurrence under the parent's decision; its siblings still mesh. A
/// failing top-level admission is the element's error, as it always was.
#[test]
fn a_failed_nested_styled_admission_is_one_drop_per_occurrence() {
    let source = format!("{BASE}#30=IFCMAPPEDITEM(#999,#3);\
        #40=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#30,#10,#30));\
        #41=IFCREPRESENTATIONMAP(#2,#40);#42=IFCMAPPEDITEM(#41,#3);");
    let calls = Rc::new(Cell::new(0));
    let mut router = GeometryRouter::new();
    router.register(Box::new(Counted(Rc::clone(&calls))));
    let mut decoder = EntityDecoder::new(&source);
    assert_eq!(styled(&router, &mut decoder, 42, false).unwrap().len(), 1);
    assert_eq!(calls.get(), 1);
    assert_eq!(router.take_unsupported_items().get("IfcMappedItem"), Some(&2));
    assert!(styled(&router, &mut decoder, 30, false).is_err());
    assert!(router.take_unsupported_items().is_empty());
}

/// The same block through a processor that counts its selected callbacks.
struct Counted(Rc<Cell<usize>>);
impl GeometryProcessor for Counted {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcBlock] }
    fn process(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder, schema: &IfcSchema,
        quality: TessellationQuality) -> Result<Mesh> {
        self.0.set(self.0.get() + 1);
        BlockProcessor::new().process(entity, decoder, schema, quality)
    }
}

/// A styled source claims its drop count before its items resolve: a source
/// whose items fail is claimed, so its later repaired walk records nothing.
#[test]
fn a_styled_source_is_claimed_before_its_items_resolve() {
    let source = format!("{BASE}#90=IFCPOLYLINE((#1,#1));\
        #50=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10,#999));\
        #51=IFCREPRESENTATIONMAP(#2,#50);#52=IFCMAPPEDITEM(#51,#3);");
    let mut decoder = EntityDecoder::new(&source);
    let router = GeometryRouter::new();
    assert!(styled(&router, &mut decoder, 52, false).is_err());
    assert!(router.take_unsupported_items().is_empty());
    let repaired = decoder.decode_by_id(90).unwrap();
    decoder.inject_shared_cache(&[(999, Arc::new(repaired))].into_iter().collect());
    assert_eq!(styled(&router, &mut decoder, 52, false).unwrap().len(), 1);
    assert!(router.take_unsupported_items().is_empty(), "the failed walk already claimed the source");
}

fn armed(batch_local: bool) -> GeometryRouter {
    let mut router = GeometryRouter::new();
    router.enable_accounted_mapped_item_cache(AccountedMappedItemCache::new());
    router.enable_output_instancing(Arc::new([(12, (2, 13))].into_iter().collect()));
    router.set_instancing_batch_local(batch_local);
    router
}

/// The don't-bake template materializes and is re-tagged to its source; any
/// other occurrence first registers the source model-wide, then pushes an
/// empty placeholder under the solid's id carrying its mapping. Without
/// `allow_instancing` every occurrence materializes.
#[test]
fn dont_bake_template_and_placeholder_carry_the_source_identity_and_mapping() {
    let mut decoder = EntityDecoder::new(BASE);
    let router = armed(false);
    let placeholder = styled(&router, &mut decoder, 15, true).unwrap();
    let [only] = placeholder.sub_meshes.as_slice() else { panic!("one placeholder") };
    assert_eq!(only.geometry_id, 10);
    assert!(only.mesh.positions.is_empty());
    let instance = only.mesh.instance_meta.as_ref().unwrap();
    assert_eq!((instance.rep_identity, instance.local_transform), (12, Some(translation(10.0))));
    assert_eq!(router.mapped_shared_unique_count(), 1, "the placeholder's source is registered");

    let template = styled(&router, &mut decoder, 13, true).unwrap();
    let [only] = template.sub_meshes.as_slice() else { panic!("one template") };
    assert_eq!((only.geometry_id, only.mesh.indices.len()), (10, 36));
    let instance = only.mesh.instance_meta.as_ref().unwrap();
    assert_eq!((instance.rep_identity, instance.local_transform), (12, Some(translation(0.0))));

    let flat = styled(&router, &mut decoder, 15, false).unwrap();
    assert_eq!(flat.sub_meshes[0].mesh.indices.len(), 36);
}

struct Failing;
impl GeometryProcessor for Failing {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcBlock] }
    fn process(&self, _: &DecodedEntity, _: &mut EntityDecoder, _: &IfcSchema, _: TessellationQuality)
        -> Result<Mesh> {
        Err(Error::geometry("refused block"))
    }
}

/// Batch-local, under an account, the first occurrence's template claim is
/// provisional: kept once it materialized geometry, rolled back when its walk
/// is stopped or yields nothing, so the next occurrence can become it.
/// Without an account the claim is permanent, as it always was.
#[test]
fn a_provisional_template_claim_is_kept_only_for_materialized_geometry() {
    use crate::resource::{ExecutionAccount, ExecutionPolicy, ResourceLimits};
    let unlimited = || ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let claimed = |router: &GeometryRouter| router.instanced_sources_materialized.borrow().contains(&12);
    let mut decoder = EntityDecoder::new(BASE);

    let router = armed(true);
    let template = unlimited().scope(|| styled(&router, &mut decoder, 13, true)).unwrap();
    assert_eq!(template.sub_meshes[0].mesh.indices.len(), 36);
    assert!(claimed(&router));
    let next = unlimited().scope(|| styled(&router, &mut decoder, 15, true)).unwrap();
    assert!(next.sub_meshes[0].mesh.positions.is_empty(), "the kept claim makes the next a placeholder");

    let mut router = armed(true);
    router.register(Box::new(Failing));
    assert!(unlimited().scope(|| styled(&router, &mut decoder, 13, true)).unwrap().is_empty());
    assert!(!claimed(&router), "an empty template is rolled back");
    assert!(styled(&router, &mut decoder, 13, true).unwrap().is_empty());
    assert!(claimed(&router), "unaccounted, the claim stands as it always did");

    let router = armed(true);
    let stopped = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        live_bytes: Some(std::mem::size_of::<u32>() as u64),
        ..Default::default()
    }));
    let result = stopped.scope(|| styled(&router, &mut decoder, 13, true));
    assert!(matches!(result, Err(Error::ProgramStopped(_))), "{:?}", result.err());
    assert!(!claimed(&router), "a stopped template is rolled back");
}

/// A source is counted once per router whichever walk reaches it first:
/// styled, type map, merged or the don't-bake registry walk.
#[test]
fn a_source_is_counted_once_across_styled_type_map_merged_and_shared_walks() {
    let source = format!("{BASE}#40=IFCPOLYLINE((#1,#14));\
        #41=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#40,#10));\
        #42=IFCREPRESENTATIONMAP(#2,#41);#43=IFCMAPPEDITEM(#42,#3);#44=IFCMAPPEDITEM(#42,#4);");
    let mut decoder = EntityDecoder::new(&source);
    let router = GeometryRouter::new();
    assert_eq!(styled(&router, &mut decoder, 43, false).unwrap().len(), 1);
    assert_eq!(router.take_unsupported_items().get("IfcPolyline"), Some(&1));
    assert_eq!(type_map(&router, &mut decoder, 42).len(), 1);
    assert_eq!(parts(&router, &mut decoder, 44)[0].indices.len(), 36);
    assert!(router.take_unsupported_items().is_empty());

    let router = GeometryRouter::new();
    type_map(&router, &mut decoder, 42);
    styled(&router, &mut decoder, 43, false).unwrap();
    assert_eq!(router.take_unsupported_items().get("IfcPolyline"), Some(&1));

    // #46 is a single-polyline source: the don't-bake registry walk of a
    // placeholder claims it, so its template walk records nothing more.
    let source = format!("{source}#45=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#40));\
        #46=IFCREPRESENTATIONMAP(#2,#45);#47=IFCMAPPEDITEM(#46,#3);#48=IFCMAPPEDITEM(#46,#4);");
    let mut decoder = EntityDecoder::new(&source);
    let mut router = GeometryRouter::new();
    router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
    router.enable_output_instancing(Arc::new([(46, (2, 47))].into_iter().collect()));
    styled(&router, &mut decoder, 48, true).unwrap();
    assert_eq!(router.take_unsupported_items().get("IfcPolyline"), Some(&1));
    styled(&router, &mut decoder, 47, true).unwrap();
    assert!(router.take_unsupported_items().is_empty());
    assert_eq!(router.unsupported_scope_depth(), 0);
}

/// The source's RepresentationType outranks its identifier on the styled and
/// type-map walks too; a blank type falls back to the identifier.
#[test]
fn representation_type_outranks_the_identifier_on_styled_and_type_map_walks() {
    let cases = [("Body", "Curve2D", false), ("FootPrint", "Tessellation", true), ("Body", "", true),
        ("FootPrint", "", false)];
    for (identifier, kind, counted) in cases {
        let source = format!("{BASE}#40=IFCPOLYLINE((#1,#14));\
            #41=IFCSHAPEREPRESENTATION($,'{identifier}','{kind}',(#40,#10));\
            #42=IFCREPRESENTATIONMAP(#2,#41);#43=IFCMAPPEDITEM(#42,#3);");
        let mut decoder = EntityDecoder::new(&source);
        let router = GeometryRouter::new();
        assert_eq!(styled(&router, &mut decoder, 43, false).unwrap().len(), 1);
        assert_eq!(router.take_unsupported_items().contains_key("IfcPolyline"), counted, "styled {identifier}/{kind}");
        let router = GeometryRouter::new();
        assert_eq!(type_map(&router, &mut decoder, 42).len(), 1);
        assert_eq!(router.take_unsupported_items().contains_key("IfcPolyline"), counted, "type map {identifier}/{kind}");
    }
}
