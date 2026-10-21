// SPDX-License-Identifier: MPL-2.0
//! The mapping controller: ordered accumulation, nesting, cache/instance
//! semantics and once-per-source drop counting through the common protocol.
use crate::program::{GeometryProgram, ProgramError, ProgramStage};
use crate::processors::BlockProcessor;
use crate::{GeometryProcessor, GeometryRouter, Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
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

/// The same block through a processor that counts its selected callbacks.
struct Counted(Rc<Cell<u32>>);
impl GeometryProcessor for Counted {
    fn process(&self, item: &DecodedEntity, decoder: &mut EntityDecoder, schema: &IfcSchema,
        quality: TessellationQuality) -> Result<Mesh> {
        self.0.set(self.0.get() + 1);
        BlockProcessor::new().process(item, decoder, schema, quality)
    }
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcBlock] }
}

fn counted_router() -> (GeometryRouter, Rc<Cell<u32>>) {
    let calls = Rc::new(Cell::new(0));
    let mut router = GeometryRouter::new();
    router.register(Box::new(Counted(Rc::clone(&calls))));
    (router, calls)
}

fn parts(router: &GeometryRouter, decoder: &mut EntityDecoder, id: u32) -> Result<Vec<Mesh>> {
    let item = decoder.decode_by_id(id).unwrap();
    GeometryProgram::mapped_item(&item).drain_parts(router, decoder)
}

fn block(router: &GeometryRouter, decoder: &mut EntityDecoder, id: u32) -> Mesh {
    let item = decoder.decode_by_id(id).unwrap();
    GeometryProgram::item(&item, router.rtc_offset()).drain(router, decoder).unwrap()
}

fn payload(mesh: &Mesh) -> (&[f32], &[f32], &[u32], [f64; 3], Option<[f32; 6]>) {
    (&mesh.positions, &mesh.normals, &mesh.indices, mesh.origin, mesh.local_bounds)
}

/// A repeated source is walked once; a cache hit re-places the cached
/// source-coords mesh to the same bytes and instance identity a walk yields.
#[test]
fn repeated_occurrence_hits_the_cache_with_walked_bytes_and_instance_identity() {
    let mut decoder = EntityDecoder::new(BASE);
    let (router, calls) = counted_router();
    let first = parts(&router, &mut decoder, 13).unwrap();
    let hit = parts(&router, &mut decoder, 15).unwrap();
    assert_eq!(calls.get(), 1, "the second occurrence reuses the cached source");
    let (fresh, fresh_calls) = counted_router();
    let walked = parts(&fresh, &mut decoder, 15).unwrap();
    assert_eq!(fresh_calls.get(), 1);
    assert_eq!((first.len(), hit.len(), walked.len()), (1, 1, 1));
    assert_eq!(payload(&hit[0]), payload(&walked[0]));
    let (hit_meta, walked_meta) = (hit[0].instance_meta.as_ref().unwrap(), walked[0].instance_meta.as_ref().unwrap());
    assert_eq!(hit_meta.rep_identity, 12, "a mapped occurrence's identity is its RepresentationMap");
    assert_eq!(
        (hit_meta.rep_identity, hit_meta.local_transform, hit_meta.instanceable),
        (walked_meta.rep_identity, walked_meta.local_transform, walked_meta.instanceable)
    );
    assert_eq!(hit_meta.local_transform.unwrap()[3], 10.0, "the mapping, not the source, moves");
    let (min, _) = hit[0].bounds();
    assert_eq!(min.x, 10.0);
    let cached = router.mapped_item_cache.borrow().get(&12).cloned().unwrap();
    let source = block(&GeometryRouter::new(), &mut decoder, 10);
    assert_eq!(payload(&cached), payload(&source), "the cache holds source coordinates");
}

/// A nested map's placed parts merge where its item stands, between its
/// siblings, and the enclosing occurrence instances on its own map.
#[test]
fn nested_source_merges_in_item_order_under_the_parent_mapping() {
    let mut decoder = EntityDecoder::new(BASE);
    let router = GeometryRouter::new();
    let outer = parts(&router, &mut decoder, 22).unwrap();
    assert_eq!(outer.len(), 1);
    let reference = GeometryRouter::new();
    let mut expected = crate::router::frame_parts::SourceParts::default();
    expected.merge(&block(&reference, &mut decoder, 16));
    expected.merge(&parts(&reference, &mut decoder, 13).unwrap()[0]);
    expected.merge(&block(&reference, &mut decoder, 17));
    let mut expected = expected.into_parts().unwrap();
    let item = decoder.decode_by_id(22).unwrap();
    let source = decoder.decode_by_id(21).unwrap();
    let mut transform = reference.mapped_item_transform(&item, &source, &mut decoder).unwrap();
    reference.place_mapped_parts(21, &mut expected, transform.as_mut().map(|t| &*t));
    assert_eq!(payload(&outer[0]), payload(&expected[0]));
    assert_eq!(outer[0].instance_meta.as_ref().unwrap().rep_identity, 21);
    assert_eq!(outer[0].indices.len(), 3 * 36, "three blocks, each once");
}

/// Source steps read IFC; merging, closing and placing are numerical. A hit
/// is one source step and one placement; owners are checked before work.
#[test]
fn mapping_steps_are_source_then_numerical_and_refuse_a_foreign_owner() {
    let mut decoder = EntityDecoder::new(BASE);
    let router = GeometryRouter::new();
    let item = decoder.decode_by_id(13).unwrap();
    let mut program = GeometryProgram::mapped_item(&item);
    let mut stages = Vec::new();
    let (foreign, mut foreign_decoder) = (GeometryRouter::new(), EntityDecoder::new(BASE));
    while let Some(request) = program.request().unwrap() {
        stages.push(request.stage());
        if stages.len() > 1 {
            // Bound to its first executing owners, each later step refuses
            // others before taking its work.
            assert_eq!(program.execute(request, &foreign, &mut decoder).err(), Some(ProgramError::WrongOwner));
            assert_eq!(program.execute(request, &router, &mut foreign_decoder).err(),
                Some(ProgramError::WrongOwner));
        }
        let reply = program.execute(request, &router, &mut decoder).unwrap();
        program.accept(reply, &router).ok().unwrap();
    }
    use ProgramStage::{Numerical, Source};
    // Enter, the block's lowering, its arithmetic, merge, close, place.
    assert_eq!(stages, [Source, Source, Numerical, Numerical, Numerical, Numerical]);
    let walked = program.finish_parts().unwrap();
    let mut program = GeometryProgram::mapped_item(&item);
    let mut stages = Vec::new();
    while let Some(request) = program.request().unwrap() {
        stages.push(request.stage());
        let reply = program.execute(request, &router, &mut decoder).unwrap();
        program.accept(reply, &router).ok().unwrap();
    }
    assert_eq!(stages, [Source, Numerical], "a hit walks nothing");
    assert_eq!(payload(&program.finish_parts().unwrap()[0]), payload(&walked[0]));
}

/// A nested map that fails is one dropped `IfcMappedItem`; it cuts the parent
/// short, so the parent is not shared model-wide (a later complete walk would
/// be served the short mesh), while the per-router fallback keeps the
/// historical behaviour and caches it.
#[test]
fn a_failed_nested_map_is_one_drop_and_withholds_the_short_parent_from_sharing() {
    let source = format!("{BASE}#30=IFCMAPPEDITEM(#999,#3);\
        #31=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#16,#30));\
        #32=IFCREPRESENTATIONMAP(#2,#31);#33=IFCMAPPEDITEM(#32,#3);");
    let mut decoder = EntityDecoder::new(&source);
    let mut shared = GeometryRouter::new();
    shared.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
    let short = parts(&shared, &mut decoder, 33).unwrap();
    assert_eq!(short[0].indices.len(), 36, "the parent keeps its own block");
    assert_eq!(shared.take_unsupported_items().get("IfcMappedItem"), Some(&1));
    assert_eq!(shared.mapped_shared_unique_count(), 0, "a truncated source is not shared");
    let local = GeometryRouter::new();
    assert_eq!(payload(&parts(&local, &mut decoder, 33).unwrap()[0]), payload(&short[0]));
    assert!(local.mapped_item_cache.borrow().contains_key(&32));
}

/// A total-loss source is counted once however many occurrences walk it, and
/// a nested drop is counted under its own source's decision, innermost wins.
#[test]
fn drops_count_once_per_source_and_under_the_innermost_source() {
    // #40 is unsupported. Map #42 (Body) holds only it; map #45 (FootPrint)
    // holds #40 and the nested Body occurrence #43 of #42.
    let source = format!("{BASE}#40=IFCPOLYLINE((#1,#14));\
        #41=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#40));#42=IFCREPRESENTATIONMAP(#2,#41);\
        #43=IFCMAPPEDITEM(#42,#3);#44=IFCSHAPEREPRESENTATION($,'FootPrint','Curve2D',(#40,#43));\
        #45=IFCREPRESENTATIONMAP(#2,#44);#46=IFCMAPPEDITEM(#45,#3);#47=IFCMAPPEDITEM(#42,#4);");
    let mut decoder = EntityDecoder::new(&source);
    let mut router = GeometryRouter::new();
    router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
    parts(&router, &mut decoder, 46).unwrap();
    assert_eq!(router.take_unsupported_items().get("IfcPolyline"), Some(&1),
        "the FootPrint map's own item is suppressed; its nested Body map's is not");
    parts(&router, &mut decoder, 47).unwrap();
    parts(&router, &mut decoder, 43).unwrap();
    assert!(router.take_unsupported_items().is_empty(), "an empty source re-walks but counts once");
    assert!(router.unsupported_scope_depth() == 0, "no walk leaves a scope open");
}

/// The source's RepresentationType outranks its identifier for counting.
#[test]
fn representation_type_outranks_the_identifier_for_drop_counting() {
    for (identifier, kind, counted) in [("Body", "Curve2D", false), ("FootPrint", "Tessellation", true)] {
        let source = format!("{BASE}#40=IFCPOLYLINE((#1,#14));\
            #41=IFCSHAPEREPRESENTATION($,'{identifier}','{kind}',(#40,#10));\
            #42=IFCREPRESENTATIONMAP(#2,#41);#43=IFCMAPPEDITEM(#42,#3);");
        let mut decoder = EntityDecoder::new(&source);
        let router = GeometryRouter::new();
        assert_eq!(parts(&router, &mut decoder, 43).unwrap()[0].indices.len(), 36);
        assert_eq!(router.take_unsupported_items().contains_key("IfcPolyline"), counted, "{identifier}/{kind}");
    }
}

/// Units scale the mapping translation, never the already-scaled source; a
/// raw-coordinate item rebased by the model RTC keeps that offset in its f64
/// origin, which the mapping then carries (#7690): rotating the occurrence
/// must not put it a site-offset away.
#[test]
fn units_rtc_and_the_origin_follow_the_mapping_in_f64() {
    let site = [2_600_000.0, 1_200_000.0, 0.0];
    let source = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\
        #7=IFCCARTESIANPOINTLIST3D(((2600000.,1200000.,0.),(2600001.,1200000.,0.),(2600000.,1200001.,0.)),$);\
        #8=IFCTRIANGULATEDFACESET(#7,$,.F.,((1,2,3)),$);\
        #9=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#8));#12=IFCREPRESENTATIONMAP(#2,#9);\
        #14=IFCCARTESIANPOINT((1000.,0.,0.));#15=IFCDIRECTION((0.,1.,0.));\
        #4=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#15,$,#14,1.,$);#13=IFCMAPPEDITEM(#12,#4);";
    let mut decoder = EntityDecoder::new(source);
    let mut router = GeometryRouter::with_scale_and_local_frame(0.001, false);
    router.set_rtc_offset((site[0] * 0.001, site[1] * 0.001, 0.0));
    let placed = parts(&router, &mut decoder, 13).unwrap().remove(0);
    assert!(!placed.rtc_applied);
    // x' = -y, y' = x (axis1 = +Y), then +1 m (1000 mm scaled).
    let expected_origin = [-site[1] * 0.001 + 1.0, site[0] * 0.001, 0.0];
    for axis in 0..3 {
        assert!((placed.origin[axis] - expected_origin[axis]).abs() < 1e-9, "{:?}", placed.origin);
    }
    let corner = [placed.positions[3] as f64 + placed.origin[0], placed.positions[4] as f64 + placed.origin[1]];
    assert!((corner[0] - expected_origin[0]).abs() < 1e-6 && (corner[1] - (expected_origin[1] + 0.001)).abs() < 1e-6,
        "{corner:?}");
}

/// A program stop reached two maps deep is terminal for the whole walk, is
/// never recorded as a dropped item, and publishes no source.
#[test]
fn a_program_stop_in_a_nested_source_is_terminal_at_every_level() {
    let mut decoder = EntityDecoder::new(BASE);
    let router = GeometryRouter::new();
    use crate::resource::{ExecutionAccount, ExecutionPolicy, ResourceLimits};
    let limited = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        live_bytes: Some(0),
        ..Default::default()
    }));
    let result = limited.scope(|| parts(&router, &mut decoder, 22));
    assert!(matches!(result, Err(crate::Error::ProgramStopped(_))), "{:?}", result.err());
    assert!(router.take_unsupported_items().is_empty());
    assert!(router.mapped_item_cache.borrow().is_empty());
    assert!(router.unsupported_scope_depth() == 0);
}

struct Panicking;
impl GeometryProcessor for Panicking {
    fn process(&self, _: &DecodedEntity, _: &mut EntityDecoder, _: &IfcSchema, _: TessellationQuality)
        -> Result<Mesh> {
        panic!("mapped extension interrupted");
    }
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcBlock] }
}

/// An unwinding source item leaves no scope open and publishes nothing.
#[test]
fn an_unwinding_source_item_publishes_nothing_and_restores_counting() {
    let mut decoder = EntityDecoder::new(BASE);
    let mut router = GeometryRouter::new();
    router.register(Box::new(Panicking));
    let unwind = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| parts(&router, &mut decoder, 22)));
    assert!(unwind.is_err());
    assert!(router.mapped_item_cache.borrow().is_empty());
    assert!(router.unsupported_scope_depth() == 0);
}
