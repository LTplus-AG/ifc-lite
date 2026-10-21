// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7887: a private product plan cannot migrate between execution owners.
use super::*;
use crate::profile_walk_model as model;

#[test]
fn issue_7887_decoder_replacement_between_admitted_roots_is_rejected() {
    let content = model::wall("#160", "#160=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#140,#240));");
    for replacement in [false, true] {
        // No eager decoder index: admission may initialize it, and must seal
        // the resulting identity rather than rejecting that lazy initialization.
        let mut decoder = EntityDecoder::new(&content);
        let router = GeometryRouter::new();
        let wall = decoder.decode_by_id(100).unwrap();
        let plan = admit_product(&wall, &mut decoder, 2, &router);
        let roots = &plan.representations[0].1;
        assert_eq!(roots.len(), 2);
        plan.validate(&router, &decoder).unwrap();
        let first = router.process_representation_item_parts(&roots[0], &mut decoder).unwrap();
        assert_eq!(first.iter().map(crate::Mesh::triangle_count).sum::<usize>(), 12);
        if replacement {
            decoder = EntityDecoder::new(&content);
        } else {
            decoder.set_entity_index(std::sync::Arc::new(ifc_lite_core::build_entity_index(content.as_bytes())));
        }
        let error = plan.validate(&router, &decoder).unwrap_err();
        assert!(error.to_string().contains("execution owner changed"), "{error}");
        assert!(router.take_unsupported_items().is_empty(), "an owner failure is not damaged content");
    }
}

#[test]
fn issue_7887_router_configuration_change_cannot_reuse_admitted_roots() {
    let content = model::chain(1);
    let mut decoder = EntityDecoder::new(&content);
    let mut router = GeometryRouter::new();
    let wall = decoder.decode_by_id(100).unwrap();
    let plan = admit_product(&wall, &mut decoder, 2, &router);
    plan.validate(&router, &decoder).unwrap();
    router.set_tessellation_quality(crate::TessellationQuality::High);
    assert!(plan.validate(&router, &decoder).is_err());
}

#[test]
fn issue_7887_terminal_precedes_logical_and_shape_refusal_on_both_mesh_paths() {
    use crate::resource::{ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};
    // Both strict shape failure and zero logical allowance lose to cancellation.
    for content in [model::chain(1), model::wall("#160", "#160=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid');")] {
        let mut decoder = EntityDecoder::new(&content);
        let router = GeometryRouter::new();
        let wall = decoder.decode_by_id(100).unwrap();
        let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
        account.scope(|| {
            account.cancel();
            let merged = router.process_element_parts_with_budget(
                &wall, &mut decoder, super::super::processing::SourceHygiene::Watertight, 0,
            );
            assert!(matches!(merged, Err(crate::Error::ProgramStopped(ProgramStop::Cancelled))));
            let styled = router.process_element_submeshes_with_budget(
                &wall, &mut decoder, true, None, super::super::processing::SourceHygiene::Watertight, 0,
            );
            assert!(matches!(styled, Err(crate::Error::ProgramStopped(ProgramStop::Cancelled))));
            assert!(router.take_unsupported_items().is_empty());
        });
    }
}
