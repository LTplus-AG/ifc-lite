// SPDX-License-Identifier: MPL-2.0
//! #7955 review R1: consumed accept effects retain stops across account scopes.
use super::*;
use crate::resource::{Dimension, ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};

fn accept_stop(bytes: String, source_id: u32, type_map: bool) {
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let traversal = RetainedTraversal::new(contract());
    let mut existing_sibling = traversal.product_parts(&entity);
    let mut program = if type_map {
        traversal.type_map(decoder.decode_by_id(61).unwrap(), None)
    } else { traversal.product_parts(&entity) };
    // Bounded driver: failure to reach the actual construction cannot pass.
    for _ in 0..100 {
        let ticket = program.request().unwrap().expect("construction must be reached");
        let (reply, operations) = program.admit(ticket, &router, &mut decoder).unwrap();
        let target = operations.iter().any(|operation| operation.construction().is_some()
            && matches!(operation.value().definition(),
                LogicalRetainedDefinition::Source { source_id: id, .. } if *id == source_id));
        if !target {
            program.accept(reply, &router).unwrap_or_else(|error| panic!("{:?}", error.error));
            continue;
        }
        let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
            live_bytes: Some(0), ..Default::default()
        }));
        let expected = account.scope(|| {
            assert_eq!(account.check(), Ok(()), "fresh account must admit entry");
            // Acceptance consumes this reply even when its subsequent allocation
            // refuses. Returning a reusable rejected reply would duplicate effects.
            assert!(program.accept(reply, &router).is_ok(), "consumed accept must not return a reply");
            account.check().expect_err("accept must hit the zero live-byte allowance")
            // Deliberately no facade request/check before leaving this scope.
        });
        assert!(matches!(expected, ProgramStop::ResourceRefused(failure)
            if failure.dimension == Dimension::LiveBytes));
        assert_eq!(crate::resource::check_current(), Ok(()), "ambient stop ended with scope");
        let mut new_sibling = traversal.product_parts(&entity);
        let stops = (program.request().err(), existing_sibling.request().err(), new_sibling.request().err());
        let finish = if type_map { program.finish_type_map(60, 0, [1.; 4]) } else { program.finish() };
        assert_eq!(stops, (Some(RetainedProgramError::Stopped(expected)),
            Some(RetainedProgramError::Stopped(expected)), Some(RetainedProgramError::Stopped(expected))),
            "accept stop must survive scope exit on original and sibling roots");
        assert!(matches!(finish, Err(RetainedFailure::Stopped(stop)) if stop == expected),
            "finish must refuse with the retained stop");
        return;
    }
    panic!("bounded driver never reached the selected source construction");
}

#[test]
fn h2_accept_stop_mapped_boolean_survives_scope_and_sibling_roots() {
    // Exact review trace: #114 is reached through #314 inside the nested Union.
    let bytes = boolean_tests::nested().replace(".UNION.,#114,#115", ".UNION.,#314,#115")
        .replace("ENDSEC;END-ISO", "#314=IFCMAPPEDITEM(#315,#316);#315=IFCREPRESENTATIONMAP(#5,#317);#316=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,2.,$);#317=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#114));ENDSEC;END-ISO");
    accept_stop(bytes, 114, false);
}

#[test]
fn h2_accept_stop_plain_mapping_survives_scope_and_sibling_roots() {
    accept_stop(mapping_tests::mapped(), 113, false);
}

#[test]
fn h2_accept_stop_product_survives_scope_and_sibling_roots() {
    accept_stop(SOURCE.to_owned(), 13, false);
}

#[test]
fn h2_accept_stop_type_map_survives_scope_and_sibling_roots() {
    accept_stop(SOURCE.to_owned(), 13, true);
}
