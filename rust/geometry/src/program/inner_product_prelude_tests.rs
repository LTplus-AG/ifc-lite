// SPDX-License-Identifier: MPL-2.0
//! The real dedicated alignment lower/callback and its reached placement order.
use super::*;
use crate::{GeometryProcessor, TessellationQuality};
use crate::processors::BlockProcessor;
use ifc_lite_core::IfcSchema;
use std::{cell::Cell, rc::Rc, sync::Arc};

const SOURCE: &str = "#1=IFCALIGNMENT('a',$,$,$,$,#20,#999,$,$);
#2=IFCPRODUCTDEFINITIONSHAPE($,$,(#3));
#3=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10));
#10=IFCBLOCK($,2.,3.,4.);
#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));";

struct OwnedAlignment { calls: Rc<Cell<usize>> }
impl GeometryProcessor for OwnedAlignment {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcAlignment] }
    fn lower_owned(&self, _: &DecodedEntity, decoder: &mut EntityDecoder,
        quality: crate::TessellationQuality, rtc: Option<(f64, f64, f64)>) -> Option<Result<OwnedConstructor>> {
        assert!(rtc.is_none(), "dedicated alignment never takes the raw RTC hook");
        self.calls.set(self.calls.get() + 1);
        Some(decoder.decode_by_id(10).map_err(Into::into).and_then(|block|
            BlockProcessor::new().lower_owned(&block, decoder, quality, None).unwrap()))
    }
    fn process(&self, _: &DecodedEntity, _: &mut EntityDecoder, _: &IfcSchema,
        _: TessellationQuality) -> Result<Mesh> { panic!("owned alignment commits to actual selected lower hook") }
}

#[test]
fn alignment_common_root_pauses_before_owned_math_and_late_placement() {
    let calls = Rc::new(Cell::new(0));
    let mut router = GeometryRouter::new();
    router.register(Box::new(OwnedAlignment { calls: calls.clone() }));
    let mut decoder = EntityDecoder::new(SOURCE);
    let element = decoder.decode_by_id(1).unwrap();
    let mut program = super::super::GeometryProgram::product(element, ProductConsumer::Merged, SourceHygiene::Watertight);
    let source = program.request().unwrap().unwrap();
    assert_eq!(source.stage(), ProgramStage::Source);
    let lowered = program.execute(source, &router, &mut decoder).unwrap();
    program.accept(lowered, &router).unwrap();
    assert_eq!(calls.get(), 1);
    assert!(decoder.get_cached(20).is_none(), "alignment placement remains late");
    for _ in 0..2 {
        let numeric = program.request().unwrap().unwrap();
        assert_eq!(numeric.stage(), ProgramStage::Numerical);
        let reply = program.execute(numeric, &router, &mut decoder).unwrap();
        program.accept(reply, &router).unwrap();
    }
    let placement = program.request().unwrap().unwrap();
    assert_eq!(placement.stage(), ProgramStage::Source);
    let mut transform = nalgebra::Matrix4::identity();
    transform[(0, 3)] = 7.;
    decoder.cache_placement_transform(20, crate::math::mat4::col_major_array(&transform));
    let reply = program.execute(placement, &router, &mut decoder).unwrap();
    program.accept(reply, &router).unwrap();
    while let Some(request) = program.request().unwrap() {
        let reply = program.execute(request, &router, &mut decoder).unwrap();
        program.accept(reply, &router).unwrap();
    }
    let parts = program.finish_parts().unwrap();
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0].indices.len(), 36);
    assert_eq!(parts[0].positions.chunks_exact(3).map(|p| p[0]).fold(f32::INFINITY, f32::min), 7.);
    assert!(decoder.get_cached(999).is_none(), "nonempty direct alignment never admits ordinary representations");
}

struct CallbackAlignment { repair_then_fail: bool }
impl GeometryProcessor for CallbackAlignment {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcAlignment] }
    fn process(&self, _: &DecodedEntity, decoder: &mut EntityDecoder, schema: &IfcSchema,
        quality: TessellationQuality) -> Result<Mesh> {
        if self.repair_then_fail {
            let shape = decoder.decode_by_id(2)?;
            decoder.inject_shared_cache(&[(999, Arc::new(shape))].into_iter().collect());
            return Err(crate::Error::geometry("unreadable dedicated Axis"));
        }
        let block = decoder.decode_by_id(10)?;
        let mut mesh = BlockProcessor::new().process(&block, decoder, schema, quality)?;
        mesh.indices.extend_from_slice(&[0, 0, 0]);
        Ok(mesh)
    }
}

#[test]
fn alignment_extension_failure_repairs_later_shape_before_ordinary_fallback() {
    let mut router = GeometryRouter::new();
    router.register(Box::new(CallbackAlignment { repair_then_fail: true }));
    let mut decoder = EntityDecoder::new(SOURCE);
    let element = decoder.decode_by_id(1).unwrap();
    let parts = router.process_element_parts(&element, &mut decoder).unwrap();
    assert_eq!(parts[0].indices.len(), 36, "ordinary fallback observes actual earlier callback mutation");
}

#[test]
fn dedicated_alignment_completion_preserves_its_no_hygiene_policy() {
    let mut router = GeometryRouter::new();
    router.register(Box::new(CallbackAlignment { repair_then_fail: false }));
    let mut decoder = EntityDecoder::new(SOURCE);
    let element = decoder.decode_by_id(1).unwrap();
    let parts = router.process_element_parts(&element, &mut decoder).unwrap();
    assert_eq!(parts[0].indices.len(), 39, "alignment validates and welds without applying source cleanup");
    assert!(parts[0].indices.chunks_exact(3).any(|tri| tri[0] == tri[1] && tri[1] == tri[2]));
}

#[test]
fn alignment_prelude_packets_remain_send() {
    fn send<T: Send>() {}
    send::<PreludeControl>(); send::<PreludeAction>(); send::<PreludeReply>();
    send::<PreludeReadyWork>();
    send::<super::super::inner_product_adapter::ProductReadyWork>();
}
