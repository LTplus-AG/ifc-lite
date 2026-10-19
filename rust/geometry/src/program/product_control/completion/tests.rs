// SPDX-License-Identifier: MPL-2.0
//! Real constructor geometry paused before its reached placement admission.
use super::*;
use crate::{GeometryProcessor, GeometryRouter, TessellationQuality};
use crate::processors::BlockProcessor;
use crate::router::frame_parts::FrameParts;
use ifc_lite_core::EntityDecoder;
use nalgebra::Matrix4;

const SOURCE: &str = "#1=IFCWALL('w',$,$,$,$,#20,$,$);
#10=IFCBLOCK($,2.,3.,4.);
#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));";

#[test]
fn merged_completion_welds_before_late_source_and_places_after_source_disposal() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let element = decoder.decode_by_id(1).unwrap();
    let item = decoder.decode_by_id(10).unwrap();
    let mesh = BlockProcessor::new().lower_owned(&item, &mut decoder,
        TessellationQuality::Medium, None).unwrap().unwrap().evaluate().unwrap();
    let mut completion = ProductCompletion::new(element,
        ProductOutput::Merged((mesh, FrameParts::default(), (Mesh::new(), None))), SourceHygiene::IndexOnly);
    let CompletionPoll::Prepare(prepare) = completion.poll() else { panic!("prepare first") };
    assert!(matches!(completion.poll(), CompletionPoll::Pending));
    completion.accept_prepare(prepare.execute());
    let mut placement = Matrix4::identity();
    placement[(0, 3)] = 7.; placement[(1, 3)] = 11.; placement[(2, 3)] = 13.;
    decoder.cache_placement_transform(20, crate::math::mat4::col_major_array(&placement));
    let router = GeometryRouter::new();
    let CompletionPoll::Source(source) = completion.poll() else { panic!("late placement") };
    completion.accept_source(source.admit(&router, &mut decoder).unwrap());
    drop(decoder);
    drop(router);
    let CompletionPoll::Place(place) = completion.poll() else { panic!("owned placement operation") };
    completion.accept_place(place.execute());
    let CompletionPoll::Join(join) = completion.poll() else { panic!("owned output join") };
    completion.accept_join(join.execute().unwrap());
    let CompletionPoll::Complete(CompletedProduct::Merged(parts)) = completion.poll()
        else { panic!("completed merged parts") };
    assert_eq!(parts.len(), 1);
    for (axis, expected) in [(0, (7., 9.)), (1, (11., 14.)), (2, (13., 17.))] {
        let min = parts[0].positions.chunks_exact(3).map(|p| p[axis]).fold(f32::INFINITY, f32::min);
        let max = parts[0].positions.chunks_exact(3).map(|p| p[axis]).fold(f32::NEG_INFINITY, f32::max);
        assert_eq!((min, max), expected);
    }
    assert_eq!(parts[0].local_bounds, Some([0., 0., 0., 2., 3., 4.]));
}

#[test]
fn empty_styled_completion_still_reaches_placement_error() {
    let source = SOURCE.replace("$,#20,$", "$,#999,$");
    let mut decoder = EntityDecoder::new(&source);
    let element = decoder.decode_by_id(1).unwrap();
    let mut completion = ProductCompletion::new(element,
        ProductOutput::Styled(SubMeshCollection::new()), SourceHygiene::Watertight);
    let CompletionPoll::Prepare(prepare) = completion.poll() else { panic!("prepare") };
    completion.accept_prepare(prepare.execute());
    let CompletionPoll::Source(source) = completion.poll() else { panic!("placement still admitted") };
    assert!(source.admit(&GeometryRouter::new(), &mut decoder).is_err());
}

#[test]
fn product_completion_and_numerical_packets_are_send() {
    fn send<T: Send>() {}
    send::<ProductCompletion>();
    send::<ReadyProductPrepare>();
    send::<ReadyProductPlace>();
    send::<ReadyProductJoin>();
}
