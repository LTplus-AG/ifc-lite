// SPDX-License-Identifier: MPL-2.0
//! Item-cache publication happens only at validated acceptance, and a shared
//! hit skips the selected processor entirely.
use crate::program::GeometryProgram;
use crate::{GeometryProcessor, GeometryRouter, Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use std::{cell::Cell, rc::Rc, sync::Arc};

const EXTRUSION: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\
    #3=IFCDIRECTION((0.,0.,1.));#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,2.);\
    #5=IFCEXTRUDEDAREASOLID(#4,#2,#3,3.);";

struct Counted { calls: Rc<Cell<u32>> }
impl GeometryProcessor for Counted {
    fn process(&self, item: &DecodedEntity, decoder: &mut EntityDecoder, schema: &IfcSchema,
        quality: TessellationQuality) -> Result<Mesh> {
        self.calls.set(self.calls.get() + 1);
        crate::processors::ExtrudedAreaSolidProcessor::new(schema.clone()).process(item, decoder, schema, quality)
    }
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcExtrudedAreaSolid] }
}

fn counted_router(cache: &crate::ItemDedupCache) -> (GeometryRouter, Rc<Cell<u32>>) {
    let calls = Rc::new(Cell::new(0));
    let mut router = GeometryRouter::new();
    router.enable_content_dedup_shared(Arc::clone(cache));
    router.register(Box::new(Counted { calls: Rc::clone(&calls) }));
    (router, calls)
}

#[test]
fn miss_publishes_at_accepted_hash_and_a_shared_hit_skips_the_processor() {
    let cache = GeometryRouter::new_dedup_cache();
    let mut decoder = EntityDecoder::new(EXTRUSION);
    let item = decoder.decode_by_id(5).unwrap();
    let (first, first_calls) = counted_router(&cache);
    let mut program = GeometryProgram::representation_item(&item, first.rtc_offset());
    let mut published_at = None;
    let mut steps = 0;
    while let Some(request) = program.request().unwrap() {
        let reply = program.execute(request, &first, &mut decoder).unwrap();
        // Publication capability stays in the controller until acceptance:
        // a reply refused for a foreign router publishes nothing.
        let reply = match program.accept(reply, &GeometryRouter::new()) {
            Err(rejected) => rejected.reply,
            Ok(()) => panic!("a foreign router cannot accept cache work"),
        };
        assert_eq!(first.dedup_unique_count(), 0, "no publication before acceptance");
        program.accept(reply, &first).ok().unwrap();
        steps += 1;
        if published_at.is_none() && first.dedup_unique_count() == 1 {
            published_at = Some(steps);
        }
    }
    let miss = program.finish().unwrap();
    assert_eq!(first_calls.get(), 1);
    assert_eq!(published_at, Some(steps), "the accepted final hash step publishes");

    let (second, second_calls) = counted_router(&cache);
    let hit = second.process_representation_item(&item, &mut decoder).unwrap();
    assert_eq!(second_calls.get(), 0, "a shared hit never reaches the processor");
    assert_eq!(hit.positions, miss.positions);
    assert_eq!(hit.normals, miss.normals);
    assert_eq!(hit.indices, miss.indices);
    let rep = |mesh: &Mesh| mesh.instance_meta.as_ref().map(|meta| meta.rep_identity);
    assert_eq!(rep(&hit), rep(&miss));
    let (min, max) = hit.bounds();
    assert_eq!([max.x - min.x, max.y - min.y, max.z - min.z], [1., 2., 3.]);
}

#[test]
fn failed_item_is_never_published() {
    let cache = GeometryRouter::new_dedup_cache();
    // A zero-depth extrusion is refused by its processor.
    let source = EXTRUSION.replace(",3.);", ",0.);");
    let mut decoder = EntityDecoder::new(&source);
    let item = decoder.decode_by_id(5).unwrap();
    let (router, calls) = counted_router(&cache);
    let result = router.process_representation_item(&item, &mut decoder);
    assert_eq!(calls.get(), 1);
    assert!(result.is_err() || result.as_ref().is_ok_and(Mesh::is_empty));
    assert_eq!(router.dedup_unique_count(), 0);
}
