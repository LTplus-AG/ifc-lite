// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7887: run small logical budgets through the same helpers used by public
//! extraction, submesh and merged-mesh entrypoints. These are real parsed IFC
//! extrusions, not a counting visitor or a mock renderer.

use super::*;
use crate::profile_extractor::extract_profiles_with_budget;
use crate::profile_walk_model as model;

/// #9102: `#2000` holds `#3000` twice. Every entry pays an attempt; the
/// repeated `#3000` reference pays a member, and so does the second read of
/// `#3000`'s source (a first read of distinct items is free).
fn mapped_siblings() -> String {
    model::wall("#160", &format!(
        "{}\n#160=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#1000,#2000));\n{}{}{}",
        model::TARGET, model::mapped(1000, "#140"), model::mapped(2000, "#3000,#3000"),
        model::mapped(3000, "#240")
    ))
}

fn check(
    content: &str,
    allowance: u32,
    expected_depths: &[f32],
    refusal_type: Option<&str>,
    warm: bool,
) {
    let (profiles, skipped) = extract_profiles_with_budget(content, 0, allowance);
    let mut depths: Vec<_> = profiles.iter().map(|p| p.extrusion_depth).collect();
    depths.sort_by(f32::total_cmp);
    assert_eq!(depths, expected_depths, "drawing: {skipped:?}");
    assert_eq!(skipped.len(), usize::from(refusal_type.is_some()));
    if let Some(skip) = skipped.first() {
        assert!(
            skip.reason.contains(&format!("work budget of {allowance}")),
            "{skip:?}"
        );
    }
    let mut decoder = EntityDecoder::new(content);
    let router = GeometryRouter::with_units(content, &mut decoder);
    let element = decoder.decode_by_id(100).unwrap();
    if warm {
        let root = decoder.decode_by_id(2000).unwrap();
        let cached = router
            .process_mapped_item_parts(&root, &mut decoder)
            .unwrap();
        assert_eq!(cached.iter().map(Mesh::triangle_count).sum::<usize>(), 24);
        assert!(router.mapped_item_cache.borrow().contains_key(&2001));
    }
    // Repeat on the same router: a refusal cannot become a cached success,
    // nor can the first request poison an independently admitted later one.
    for _ in 0..2 {
        let meshes = router
            .process_element_submeshes_with_budget(
                &element,
                &mut decoder,
                false,
                None,
                SourceHygiene::Watertight,
                allowance,
            )
            .unwrap();
        let mut heights: Vec<_> = meshes
            .sub_meshes
            .iter()
            .map(|s| {
                let (lo, hi) = s.mesh.bounds();
                hi.z - lo.z
            })
            .collect();
        heights.sort_by(f32::total_cmp);
        assert_eq!(heights, expected_depths, "ordinary submeshes");
        assert_eq!(
            meshes
                .sub_meshes
                .iter()
                .map(|s| s.mesh.triangle_count())
                .sum::<usize>(),
            12 * expected_depths.len()
        );
        check_report(&router, refusal_type);
        let parts = router
            .process_element_parts_with_budget(
                &element,
                &mut decoder,
                SourceHygiene::Watertight,
                allowance,
            )
            .unwrap();
        assert_eq!(
            parts.iter().map(Mesh::triangle_count).sum::<usize>(),
            12 * expected_depths.len(),
            "merged source/cache path"
        );
        check_report(&router, refusal_type);
    }
    if refusal_type.is_some() && warm {
        let full = router
            .process_element_submeshes_with_budget(
                &element,
                &mut decoder,
                false,
                None,
                SourceHygiene::Watertight,
                allowance + 1,
            )
            .unwrap();
        assert_eq!(
            full.len(),
            3,
            "refusing one product must not cache a truncated source"
        );
        assert!(router.take_unsupported_items().is_empty());
    }
}

fn check_report(router: &GeometryRouter, refusal_type: Option<&str>) {
    assert!(router.take_unsupported_items().is_empty(), "#9268 budget is not unsupported");
    let refusals = router.take_budget_refusals();
    assert_eq!(refusals.len(), usize::from(refusal_type.is_some()));
}

#[test]
fn issue_7887_logical_product_budget_keeps_shallow_sibling_at_threshold() {
    // Every mapped occurrence pays an attempt: #1000, #2000 and #3000 twice
    // are four. The second root is atomic: at three its second `#3000` is
    // refused, and with it the otherwise valid first `#3000`. The shallow
    // first root survives. At four, every occurrence survives.
    let content = mapped_siblings();
    for warm in [false, true] {
        check(&content, 4, &[1.0, 1.0, 2.5], None, warm);
        check(&content, 3, &[2.5], Some("IfcMappedItem"), warm);
    }
}

#[test]
fn issue_7887_root_items_cannot_bypass_the_product_allowance() {
    check(&model::chain(1), 1, &[1.0], None, false);
    // The first root read pays only its repeated `#240` (#9102); the repeated
    // `#160` pays all 3.
    let content = model::wall(
        "#160,#160",
        "#160=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#140,#240,#240));",
    );
    check(&content, 4, &[1.0, 1.0, 1.0, 1.0, 2.5, 2.5], None, false);
    check(&content, 3, &[1.0, 1.0, 2.5], Some("IfcShapeRepresentation"), false);
}

#[test]
fn issue_7887_repeated_valid_dag_sources_pay_per_occurrence() {
    let content = model::wall(
        "#160",
        &format!(
            "{}\n#160=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#1000,#1000));\n{}",
            model::TARGET,
            model::mapped(1000, "#240")
        ),
    );
    // Each occurrence pays an attempt; the second also re-reads one member
    // (the first read is free, #9102).
    check(&content, 2, &[1.0, 1.0], None, false);
    check(&content, 1, &[1.0], Some("IfcMappedItem"), false);
}

#[test]
fn issue_7887_product_allowance_spans_selected_representations() {
    // `#160` costs four attempts and two members. `#170` lists `#140` twice:
    // its first read pays the repeat (1), its second read both (2). Attempts
    // fit four, but the members spread over both representations need five.
    let content = mapped_siblings()
        .replace("($,$,(#160))", "($,$,(#160,#170,#170))")
        .replace(
            "ENDSEC;\nEND-ISO",
            "#170=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#140,#140));\nENDSEC;\nEND-ISO",
        );
    check(&content, 5, &[1.0, 1.0, 2.5, 2.5, 2.5, 2.5, 2.5], None, false);
    check(
        &content,
        4,
        &[1.0, 1.0, 2.5, 2.5, 2.5],
        Some("IfcShapeRepresentation"),
        false,
    );
}

#[test]
fn issue_7887_later_shape_error_keeps_partial_profiles_but_fails_public_meshes() {
    let content = model::wall(
        "#160,#170",
        "\
        #160=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#140));\
        #170=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid');",
    );
    let (profiles, skipped) = extract_profiles_with_budget(&content, 0, 10);
    assert_eq!(profiles.len(), 1, "the earlier representation still draws");
    assert_eq!(profiles[0].extrusion_depth, 2.5);
    assert!(
        skipped.is_empty(),
        "shape errors historically are not profile drops: {skipped:?}"
    );
    let mut decoder = EntityDecoder::new(&content);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let wall = decoder.decode_by_id(100).unwrap();
    // #7887: assert the public variant and payload; Display adds its own prefix.
    let expected = "IfcShapeRepresentation missing Items";
    match router
        .process_element_parts(&wall, &mut decoder)
        .unwrap_err()
    {
        crate::Error::GeometryError(message) => {
            assert_eq!(message, expected, "process_element_parts payload")
        }
        error => panic!("process_element_parts expected GeometryError, got {error:?}"),
    }
    match router
        .process_element_with_submeshes(&wall, &mut decoder)
        .unwrap_err()
    {
        crate::Error::GeometryError(message) => {
            assert_eq!(message, expected, "process_element_with_submeshes payload")
        }
        error => panic!("process_element_with_submeshes expected GeometryError, got {error:?}"),
    }
    assert!(
        router.take_unsupported_items().is_empty(),
        "shape errors propagate, not count-and-continue"
    );
}
