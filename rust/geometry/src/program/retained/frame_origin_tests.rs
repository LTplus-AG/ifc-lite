// SPDX-License-Identifier: MPL-2.0
//! #7955 B2c: real controller refusals, owned facts and nonrigid controls.
use super::*;
use crate::program::retained::failure::{OriginCause, OriginFailure};
use crate::program::retained::value_error::{ValueError, ValueReason};
use std::sync::Arc;

fn origin(error: RetainedFailure, site: FailureSite, entity: u32, reason: ValueReason) -> Arc<OriginFailure> {
    let RetainedFailure::Origin(handle) = error else { panic!("owned origin required: {error:?}") };
    let origin = handle.origin().unwrap();
    assert_eq!((origin.site, origin.entity), (site, Some(entity)));
    assert!(matches!(origin.cause, OriginCause::Value(actual) if actual == reason),
        "B2c exact value fact required: {:?}", origin.cause);
    origin
}

#[test]
fn issue_7955_composition_action_refuses_whole_plan_atomically() {
    let (operations, result, domain) = admission(&positioned_source("1.E308", "1.E308"));
    assert_eq!(operations.len(), 1, "the finite construction is reached first");
    assert!(result.is_err(), "B2c composition action must refuse whole plan");
    let mut value = operations[0].value().try_copy().unwrap();
    let before = value.try_copy().unwrap();
    let transform = nalgebra::Matrix4::new_translation(&nalgebra::Vector3::new(1e308, 0., 0.));
    assert!(value.place_in_place(&transform, domain,
        RetainedPlacementStage::Product { product_id: 10 }).is_err());
    assert_eq!(value, before, "composition refusal preserves the entire logical definition");
}

#[test]
fn issue_7955_constructor_composition_action_and_report_precede_admission() {
    let (operations, result, _) = admission(&unit_overflow_source());
    assert!(operations.is_empty(), "B2c nonfinite constructor must not escape admission");
    origin(result.unwrap_err(), FailureSite::Constructor, 13, ValueReason::NonfiniteComposition);
}

#[test]
fn issue_7955_composition_report_survives_consumed_finish_and_source_drop() {
    let (operations, result, _) = admission(&positioned_source("1.E308", "1.E308"));
    assert_eq!(operations.len(), 1);
    // admission has dropped its controller, decoder, router and source bundle.
    origin(result.unwrap_err(), FailureSite::ProductPlacement, 10, ValueReason::NonfiniteComposition);
}

#[test]
fn issue_7955_identity_zero_source_is_reported_at_rejecting_product_placement() {
    let bytes = SOURCE.replace("(#13)", "(#0)").replace("#13=IFCEXTRUDEDAREASOLID", "#0=IFCEXTRUDEDAREASOLID");
    let (operations, result, _) = admission(&bytes);
    assert_eq!(operations.len(), 1, "parsed source #0 reaches logical admission");
    assert!(matches!(operations[0].value().definition(), LogicalRetainedDefinition::Source { source_id: 0, .. }));
    origin(result.unwrap_err(), FailureSite::ProductPlacement, 10, ValueReason::MissingSourceId);
}

#[test]
fn issue_7955_actual_mapping_determinant_causes_precede_any_constructor() {
    for (scale, reason) in [
        ("0.,$,1.,1.", ValueReason::SingularFrame),
        ("0.,$,1.E200,1.E200", ValueReason::NonfiniteDeterminant),
        ("1.,$,1.E200,1.E200", ValueReason::NonfiniteDeterminant),
    ] {
        let bytes = mapping_tests::mapped().replace("OPERATOR3D($,$,#84,1.,$)",
            &format!("OPERATOR3DNONUNIFORM($,$,#84,{scale})"));
        let (operations, result, _) = admission(&bytes);
        assert!(operations.is_empty());
        origin(result.unwrap_err(), FailureSite::MappingPlacement, 13, reason);
    }
}

#[test]
fn issue_7955_type_map_composition_reports_the_reached_map() {
    let bytes = positioned_source("1.E308", "1.E308");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let map = decoder.decode_by_id(61).unwrap();
    let mut program = RetainedProgram::type_map(map, None, contract());
    assert_eq!(drive(&mut program, &router, &mut decoder).len(), 1);
    origin(program.finish_type_map(60, 0, [1.; 4]).unwrap_err(), FailureSite::TypeMapPlacement,
        61, ValueReason::NonfiniteComposition);
}

#[test]
fn issue_7955_first_frame_cause_survives_later_identity_failure_and_independent_traversal() {
    let bytes = positioned_source("1.E308", "1.E308")
        .replace("(#23)", "(#0)").replace("#23=IFCEXTRUDEDAREASOLID", "#0=IFCEXTRUDEDAREASOLID");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let wall = decoder.decode_by_id(10).unwrap();
    let slab = decoder.decode_by_id(20).unwrap();
    let traversal = RetainedTraversal::new(contract());
    let mut first = traversal.product_parts(&wall);
    let mut second = traversal.product_parts(&slab);
    assert_eq!(drive(&mut first, &router, &mut decoder).len(), 1);
    let original = origin(first.finish().unwrap_err(), FailureSite::ProductPlacement,
        10, ValueReason::NonfiniteComposition);
    assert_eq!(drive(&mut second, &router, &mut decoder).len(), 1);
    let later = origin(second.finish().unwrap_err(), FailureSite::ProductPlacement,
        10, ValueReason::NonfiniteComposition);
    assert!(Arc::ptr_eq(&original, &later), "first cause is never replaced");
    let mut new_sibling = traversal.product_parts(&slab);
    drive(&mut new_sibling, &router, &mut decoder);
    assert!(Arc::ptr_eq(&original, &origin(new_sibling.finish().unwrap_err(),
        FailureSite::ProductPlacement, 10, ValueReason::NonfiniteComposition)));
    let mut independent = RetainedProgram::product_parts(&slab, contract());
    drive(&mut independent, &router, &mut decoder);
    origin(independent.finish().unwrap_err(), FailureSite::ProductPlacement, 20, ValueReason::MissingSourceId);
    assert_eq!(admission(SOURCE).1.unwrap().values.len(), 1);
}

#[test]
fn issue_7955_foreign_cached_value_is_committed_domain_refusal_not_owner_retirement() {
    let bytes = mapping_tests::mapped();
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let wall = decoder.decode_by_id(10).unwrap();
    let mut foreign = RetainedProgram::product_parts(&wall, contract());
    let operations = drive(&mut foreign, &router, &mut decoder);
    assert_eq!(foreign.finish().unwrap().values.len(), 1);
    let mut program = RetainedProgram::product_parts(&wall, contract());
    // Inject an actual admitted value into a different logical domain. This is
    // an internal invariant witness, not a forged numerical receipt or source.
    program.selection().unwrap().publish(81, &[operations[0].value().try_copy().unwrap()]).unwrap();
    assert!(drive(&mut program, &router, &mut decoder).is_empty(), "cached definition was reached");
    origin(program.finish().unwrap_err(), FailureSite::MappingPlacement, 13, ValueReason::PlacementDomain);
}

#[test]
fn issue_7955_nonrigid_classifier_and_retryable_owner_checks_never_latch() {
    let bytes = mapping_tests::mapped().replace("#84,1.,$", "#84,2.,$");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let mut foreign_decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let foreign_router = GeometryRouter::new();
    let wall = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&wall, contract());
    let failure = program.selection().unwrap().failure_handle();
    let initial = program.request().unwrap().unwrap();
    let (reply, initial_operations) = program.admit(initial, &router, &mut decoder).unwrap();
    assert!(initial_operations.is_empty());
    program.accept(reply, &router).unwrap_or_else(|e| panic!("{:?}", e.error));
    let mut affine = 0;
    while let Some(ticket) = program.request().unwrap() {
        assert_eq!(program.admit(ticket, &foreign_router, &mut foreign_decoder).err(),
            Some(RetainedProgramError::WrongOwner));
        assert!(failure.origin().is_none());
        let (reply, operations) = program.admit(ticket, &router, &mut decoder).unwrap();
        affine += operations.iter().filter(|op| matches!(op.kind(), RetainedOperationKind::Affine { .. })).count();
        let rejected = program.accept(reply, &foreign_router).expect_err("wrong owner keeps reply");
        assert_eq!(rejected.error, RetainedProgramError::WrongOwner);
        program.accept(rejected.reply, &router).unwrap_or_else(|e| panic!("{:?}", e.error));
    }
    assert_eq!(affine, 1, "scale 2 must pass through the negative rigid classifier");
    assert!(failure.origin().is_none());
    let plan = program.finish().unwrap();
    assert_eq!(plan.values.len(), 1);
    assert!(plan.values[0].is_product_placed());
}

#[test]
fn issue_7955_original_zero_work_stop_wins_before_frame_rejection() {
    let bytes = positioned_source("1.E308", "1.E308");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let wall = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&wall, contract());
    let failure = program.selection().unwrap().failure_handle();
    let account = crate::resource::ExecutionAccount::new(crate::resource::ExecutionPolicy::Bounded(
        crate::resource::ResourceLimits { work: Some(0), ..Default::default() }));
    let error = account.scope(|| mapping_tests::stop(&mut program, &router, &mut decoder));
    let RetainedProgramError::Stopped(stop) = error else { panic!("original stop: {error:?}") };
    assert!(matches!(stop, crate::resource::ProgramStop::ResourceRefused(refusal)
        if refusal.dimension == crate::resource::Dimension::Work && refusal.requested == 1
            && refusal.remaining == 0 && refusal.reason == crate::resource::RefusalReason::Limit));
    assert!(failure.origin().is_none(), "unreached composition cannot invent an origin");
    assert_eq!(program.request().err(), Some(error));
    assert!(matches!(program.finish(), Err(RetainedFailure::Stopped(actual)) if actual == stop));
}

#[test]
fn issue_7955_scalar_frame_predicates_preserve_order_and_atomicity() {
    let (operations, result, domain) = admission(SOURCE);
    assert_eq!(result.unwrap().values.len(), 1);
    let original = operations[0].value();
    for (matrix, reason) in [
        (nalgebra::Matrix4::<f64>::new_nonuniform_scaling(&nalgebra::Vector3::new(0., 1e200, 1e200)), ValueReason::NonfiniteDeterminant),
        (nalgebra::Matrix4::new_nonuniform_scaling(&nalgebra::Vector3::new(1., 1e200, 1e200)), ValueReason::NonfiniteDeterminant),
        (nalgebra::Matrix4::new_nonuniform_scaling(&nalgebra::Vector3::new(0., 1., 1.)), ValueReason::SingularFrame),
        (nalgebra::Matrix4::new_scaling(2.), ValueReason::NonrigidGram),
        (nalgebra::Matrix4::new_nonuniform_scaling(&nalgebra::Vector3::new(-1., 1., 1.)), ValueReason::ImproperRotation),
    ] {
        let mut value = original.try_copy().unwrap();
        assert!(matches!(value.place_in_place(&matrix, domain, RetainedPlacementStage::Product { product_id: 10 }),
            Err(ValueError::Fact(actual)) if actual == reason));
        assert_eq!(&value, original);
    }
}
