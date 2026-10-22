// SPDX-License-Identifier: MPL-2.0
//! The product program: representation and item order, the source and
//! numerical step boundaries, child roles, and stop/skip behaviour of the
//! production gateways that drain it.
use crate::processors::BlockProcessor;
use crate::program::{GeometryProgram, ProgramStage};
use crate::router::processing::SourceHygiene;
use crate::{GeometryProcessor, GeometryRouter, Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use std::{cell::RefCell, rc::Rc};

/// Product #40, placed 100 units along x, with an `Axis` representation whose
/// item #999 does not exist, a body of block #10 and mapped item #14 (source
/// block #11), and a second body of block #15.
const PRODUCT: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\
    #3=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);#10=IFCBLOCK(#2,1.,1.,1.);\
    #11=IFCBLOCK(#2,2.,2.,2.);#12=IFCSHAPEREPRESENTATION($,'Body','CSG',(#11));\
    #13=IFCREPRESENTATIONMAP(#2,#12);#14=IFCMAPPEDITEM(#13,#3);#15=IFCBLOCK(#2,3.,3.,3.);\
    #20=IFCSHAPEREPRESENTATION($,'Axis','Curve2D',(#999));\
    #21=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10,#14));\
    #22=IFCSHAPEREPRESENTATION($,'Body','CSG',(#15));\
    #23=IFCPRODUCTDEFINITIONSHAPE($,$,(#20,#21,#22));\
    #30=IFCCARTESIANPOINT((100.,0.,0.));#31=IFCAXIS2PLACEMENT3D(#30,$,$);#32=IFCLOCALPLACEMENT($,#31);\
    #40=IFCBUILDINGELEMENTPROXY('p',$,$,$,$,#32,#23,$);";

/// The block processor, recording the id of every item it is selected for.
struct Recording(Rc<RefCell<Vec<u32>>>);
impl GeometryProcessor for Recording {
    fn process(&self, item: &DecodedEntity, decoder: &mut EntityDecoder, schema: &IfcSchema,
        quality: TessellationQuality) -> Result<Mesh> {
        self.0.borrow_mut().push(item.id);
        BlockProcessor::new().process(item, decoder, schema, quality)
    }
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcBlock] }
}

fn recording_router() -> (GeometryRouter, Rc<RefCell<Vec<u32>>>) {
    let calls = Rc::new(RefCell::new(Vec::new()));
    let mut router = GeometryRouter::new();
    router.register(Box::new(Recording(Rc::clone(&calls))));
    (router, calls)
}

fn min_x(mesh: &Mesh) -> f32 {
    mesh.positions.chunks_exact(3).map(|p| p[0]).fold(f32::INFINITY, f32::min)
}

/// Items are reached in authored order through their canonical children; a
/// representation the walk does not select is never read (its item #999
/// would fail the product), and the merged body is placed once.
#[test]
fn walks_selected_representations_and_items_in_authored_order() {
    let mut decoder = EntityDecoder::new(PRODUCT);
    let (router, calls) = recording_router();
    let element = decoder.decode_by_id(40).unwrap();
    let parts = router.process_element_parts(&element, &mut decoder).unwrap();
    assert_eq!(*calls.borrow(), [10, 11, 15]);
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0].triangle_count(), 36);
    assert_eq!(min_x(&parts[0]), 100.);

    calls.borrow_mut().clear();
    let styled = router.process_element_with_submeshes(&element, &mut decoder).unwrap();
    // A mapped item's plain source items keep their own ids (#3199).
    let ids: Vec<u32> = styled.sub_meshes.iter().map(|sub| sub.geometry_id).collect();
    assert_eq!(ids, [10, 11, 15]);
    assert!(styled.sub_meshes.iter().all(|sub| min_x(&sub.mesh) == 100.));
}

/// Source steps admit one reached thing each; every item's merge, the finish
/// and the placement transform are numerical, and the placement itself is
/// one source step resolved after every item.
#[test]
fn source_admissions_alternate_with_numerical_merge_finish_and_place() {
    let mut decoder = EntityDecoder::new(PRODUCT);
    let (router, _) = recording_router();
    let element = decoder.decode_by_id(40).unwrap();
    let mut program = GeometryProgram::product(&element, SourceHygiene::Watertight);
    let mut stages = Vec::new();
    while let Some(request) = program.request().unwrap() {
        stages.push(request.stage());
        let reply = program.execute(request, &router, &mut decoder).unwrap();
        program.accept(reply, &router).ok().unwrap();
    }
    use ProgramStage::{Extension, Numerical, Source};
    let block = [Source, Source, Source, Extension, Numerical, Numerical];
    let mapped = [Source, Source, Source, Extension, Numerical, Numerical, Numerical, Numerical];
    let expected: Vec<ProgramStage> = [&[Source, Source][..], &block, &mapped, &[Source], &block,
        &[Numerical, Source, Numerical]].concat();
    assert_eq!(stages, expected);
    assert_eq!(program.finish_parts().unwrap().len(), 1);
}

/// A program stop reached by the walk ends it before any later item is
/// reached, records no dropped item and places nothing.
#[test]
fn a_stop_ends_the_walk_before_its_next_item() {
    use crate::resource::{ExecutionAccount, ExecutionPolicy, ResourceLimits};
    let mut decoder = EntityDecoder::new(PRODUCT);
    let (router, calls) = recording_router();
    let element = decoder.decode_by_id(40).unwrap();
    let limited = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        live_bytes: Some(0),
        ..Default::default()
    }));
    let result = limited.scope(|| router.process_element_parts(&element, &mut decoder));
    assert!(matches!(result, Err(crate::Error::ProgramStopped(_))), "{:?}", result.err());
    assert_eq!(*calls.borrow(), [10], "no later item is reached");
    assert!(router.take_unsupported_items().is_empty());
}

/// An item that fails fails the merged product, as the walk's `?` did; the
/// styled walk is the same strict entry.
#[test]
fn an_unreadable_items_list_fails_the_product() {
    let source = PRODUCT.replace("(#10,#14)", "#77");
    let mut decoder = EntityDecoder::new(&source);
    let (router, calls) = recording_router();
    let element = decoder.decode_by_id(40).unwrap();
    assert!(router.process_element_parts(&element, &mut decoder).is_err());
    assert!(router.process_element_with_submeshes(&element, &mut decoder).is_err());
    assert!(calls.borrow().is_empty(), "no item after the refused list is reached");
}
