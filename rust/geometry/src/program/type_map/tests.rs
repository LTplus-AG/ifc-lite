// SPDX-License-Identifier: MPL-2.0
//! Actual map/constructor boundaries and late-origin semantics.
use super::*;
use crate::{GeometryProcessor, TessellationQuality};
use crate::processors::BlockProcessor;
use std::sync::Arc;

fn source(items: &str, origin: &str) -> String {
    format!("#1=IFCREPRESENTATIONMAP({origin},#2);
#2=IFCSHAPEREPRESENTATION($,'Axis','CSG',({items}));
#10=IFCBLOCK($,2.,3.,4.);
#20=IFCAXIS2PLACEMENT3D(#21,$,$);
#21=IFCCARTESIANPOINT((7.,0.,0.));")
}

fn block(item: &DecodedEntity, decoder: &mut EntityDecoder<'_>) -> Mesh {
    BlockProcessor::new().lower_owned(item, decoder, TessellationQuality::Medium, None)
        .unwrap().unwrap().evaluate().unwrap()
}

#[test]
fn type_map_non_body_whole_items_fail_before_children_and_origin() {
    let source = source("#10,#998", "#999");
    let mut decoder = EntityDecoder::new(&source);
    let map = decoder.decode_by_id(1).unwrap();
    let items = TypeMap::begin(&map).admit(&mut decoder).unwrap();
    assert!(decoder.get_cached(10).is_none(), "representation admission does not admit Items");
    assert!(items.lower(&mut decoder).is_err(), "whole Items fails before first child");
    assert!(decoder.get_cached(999).is_none(), "late origin remains dormant after list failure");
}

#[test]
fn type_map_repeated_occurrences_execute_before_late_repaired_origin() {
    let source = source("#10,#10", "#999");
    let mut decoder = EntityDecoder::new(&source);
    let map = decoder.decode_by_id(1).unwrap();
    let router = GeometryRouter::new();
    let mut program = TypeMap::begin(&map).admit(&mut decoder).unwrap()
        .lower(&mut decoder).unwrap().accept(&router);
    let mut occurrences = 0;
    while let Some(item) = program.next() {
        let mesh = block(&item, &mut decoder);
        assert_eq!(mesh.indices.len(), 36);
        let ready = program.merge(TypeItemOutput::Parts(vec![mesh]));
        program.accept_merge(ready.execute());
        occurrences += 1;
    }
    assert_eq!(occurrences, 2);
    assert!(decoder.get_cached(999).is_none());
    let repair = decoder.decode_by_id(20).unwrap();
    decoder.inject_shared_cache(&[(999, Arc::new(repair))].into_iter().collect());
    let ready = program.origin().admit(&router, &mut decoder).unwrap();
    drop(decoder);
    drop(router);
    drop(source);
    let parts = ready.execute();
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0].0.indices.len(), 72, "same ID contributes twice");
    let min_x = parts[0].0.positions.chunks_exact(3).map(|p| p[0])
        .fold(f32::INFINITY, f32::min);
    assert_eq!(min_x, 7., "origin reads repaired source after both children");
}

#[test]
fn type_map_wrong_origin_type_is_identity_but_unreadable_origin_is_late_error() {
    for (origin, expected_success) in [("#10", true), ("#999", false)] {
        let source = source("#10", origin);
        let mut decoder = EntityDecoder::new(&source);
        let map = decoder.decode_by_id(1).unwrap();
        let router = GeometryRouter::new();
        let mut program = TypeMap::begin(&map).admit(&mut decoder).unwrap()
            .lower(&mut decoder).unwrap().accept(&router);
        let item = program.next().unwrap();
        let mesh = block(&item, &mut decoder);
        let ready = program.merge(TypeItemOutput::Parts(vec![mesh]));
        program.accept_merge(ready.execute());
        assert!(program.next().is_none());
        match program.origin().admit(&router, &mut decoder) {
            Ok(ready) => {
                assert!(expected_success);
                let parts = ready.execute();
                assert_eq!(parts[0].0.positions.iter().copied().fold(f32::INFINITY, f32::min), 0.);
            }
            Err(_) => assert!(!expected_success),
        }
    }
}

#[test]
fn type_map_suspended_and_numerical_stages_are_send() {
    fn send<T: Send>() {}
    send::<TypeMapSource>();
    send::<TypeMapItemsSource>();
    send::<TypeMap>();
    send::<ReadyTypeMerge>();
    send::<TypeMapOrigin>();
    send::<ReadyTypeMap>();
}
