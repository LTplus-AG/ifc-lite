// SPDX-License-Identifier: MPL-2.0
//! #7955 S2 review R3: finalization must retain stops after consuming the root.
use super::*;
use crate::resource::{Dimension, ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};

fn finish_stop(existing_type_map: bool) {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let traversal = RetainedTraversal::new(contract());
    let mut existing = if existing_type_map {
        traversal.type_map(decoder.decode_by_id(71).unwrap(), None)
    } else { traversal.product_parts(&entity) };
    let mut program = traversal.type_map(decoder.decode_by_id(61).unwrap(), None);
    let operations = drive(&mut program, &router, &mut decoder);
    assert_eq!(operations.len(), 1);
    assert!(operations[0].construction().is_some());
    assert!(program.request().unwrap().is_none(), "map completed before account entry");
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        work: Some(0), ..Default::default()
    }));
    let expected = account.scope(|| {
        assert_eq!(account.check(), Ok(()), "entry is not already stopped");
        let error = program.finish_type_map(60, 1, [1.; 4]).unwrap_err();
        let RetainedFailure::Stopped(stop) = error else { panic!("expected finalization resource stop: {error}") };
        assert!(matches!(stop, ProgramStop::ResourceRefused(f) if f.dimension == Dimension::Work));
        assert_eq!(account.check(), Err(stop));
        // No facade call inside the scope can latch the stop on our behalf.
        stop
    });
    assert_eq!(crate::resource::check_current(), Ok(()));
    let mut new_product = traversal.product_parts(&entity);
    let mut new_map = traversal.type_map(decoder.decode_by_id(71).unwrap(), None);
    for root in [&mut existing, &mut new_product, &mut new_map] {
        assert_eq!(root.request().err(), Some(RetainedProgramError::Stopped(expected)),
            "finalization stop survives on both existing and new roots after scope exit");
    }
    assert!(matches!(new_product.finish(), Err(RetainedFailure::Stopped(stop)) if stop == expected));
    assert!(matches!(new_map.finish_type_map(60, 1, [1.; 4]), Err(RetainedFailure::Stopped(stop)) if stop == expected));
}

#[test]
fn s2_r3_type_map_finalization_work_stop_reaches_existing_product_and_new_roots() {
    finish_stop(false);
}

#[test]
fn s2_r3_type_map_finalization_work_stop_reaches_existing_map_and_new_roots() {
    finish_stop(true);
}
