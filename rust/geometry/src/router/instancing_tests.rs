// SPDX-License-Identifier: MPL-2.0
use crate::router::GeometryRouter;
use ifc_lite_core::EntityDecoder;

/// A Body source whose two items both fail to mesh: `#8` has no registered
/// processor at all (the `None` arm), `#7` has one that errors on a null
/// profile/placement (the `Err` arm). `ensure_shared_mapped_source` is the
/// don't-bake path's own flat walk of a source, a separate entry into the
/// mapping controller from a mapped item's, and its two drop arms had no test: deleting both
/// `record_unsupported_item` calls left the whole suite green, so the one
/// place a don't-bake occurrence's loss is visible was unguarded.
const TWO_FAILING_ITEMS: &str = r#"
#7=IFCEXTRUDEDAREASOLID($,$,$,0.);
#8=IFCGEOMETRICSET(());
#9=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#7,#8));
"#;

#[test]
fn both_drop_arms_of_the_shared_source_walk_are_recorded() {
    let mut decoder = EntityDecoder::new(TWO_FAILING_ITEMS);
    let mut router = GeometryRouter::new();
    router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());

    let rep = decoder.decode_by_id(9).expect("decode #9");
    router
        .ensure_shared_mapped_source(&rep, 100, &mut decoder)
        .unwrap();

    assert_eq!(
        router.mapped_shared_unique_count(),
        0,
        "a source that meshes to nothing must not be published (unchanged)"
    );
    let unsupported = router.take_unsupported_items();
    assert_eq!(
        unsupported.get("IfcGeometricSet"),
        Some(&1),
        "the None arm (no processor for the type) must record: {unsupported:?}"
    );
    assert_eq!(
        unsupported.get("IfcExtrudedAreaSolid"),
        Some(&1),
        "the Err arm (processor ran and failed) must record: {unsupported:?}"
    );
}

/// The Body gate, on this walk. `plan_type_geometry` selects a type's
/// RepresentationMaps by reference and instantiation only, so a 2D
/// 'FootPrint'/'Annotation' map reaches the don't-bake path exactly as it
/// reaches the other three, carrying items no processor handles and which
/// are CORRECTLY absent from a 3D view. Counting them warns on a clean
/// model. The other three walks already gated; this one did not.
#[test]
fn a_footprint_source_records_nothing_on_the_shared_source_walk() {
    let footprint = r#"
#8=IFCANNOTATIONFILLAREA($,());
#9=IFCSHAPEREPRESENTATION($,'FootPrint','Annotation2D',(#8));
"#;
    let mut decoder = EntityDecoder::new(footprint);
    let mut router = GeometryRouter::new();
    router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());

    let rep = decoder.decode_by_id(9).expect("decode #9");
    router
        .ensure_shared_mapped_source(&rep, 101, &mut decoder)
        .unwrap();

    let unsupported = router.take_unsupported_items();
    assert!(
        unsupported.is_empty(),
        "a 2D representation carries no 3D content to lose: {unsupported:?}"
    );
}

/// The other half of that gate, so it cannot be satisfied by never counting:
/// the identical item under a Body representation IS a content loss.
#[test]
fn the_same_item_under_a_body_source_is_still_recorded_on_the_shared_source_walk() {
    let body = r#"
#8=IFCANNOTATIONFILLAREA($,());
#9=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#8));
"#;
    let mut decoder = EntityDecoder::new(body);
    let mut router = GeometryRouter::new();
    router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());

    let rep = decoder.decode_by_id(9).expect("decode #9");
    router
        .ensure_shared_mapped_source(&rep, 102, &mut decoder)
        .unwrap();

    let unsupported = router.take_unsupported_items();
    assert_eq!(
        unsupported.values().sum::<u64>(),
        1,
        "the gate keys on the representation, not on the item type: {unsupported:?}"
    );
}

fn fixture() -> String {
    std::fs::read_to_string("tests/fixtures/nested_mapped_item.ifc")
        .expect("read tests/fixtures/nested_mapped_item.ifc")
}

/// `ensure_shared_mapped_source` walks the source's items FLAT — it does not
/// recurse into a nested `IfcMappedItem` the way `process_mapped_item_cached`
/// does. Handed a nested source anyway, it
/// must publish NOTHING: the shared cache is keyed on the source id, so a mesh
/// missing the nested contribution would be served to every later occurrence,
/// including through `process_mapped_item_cached`'s own lookup.
///
/// `#20` is the outer map's representation: its own solid `#16` plus a nested
/// mapped item `#19` on map `#14`.
#[test]
fn nested_source_is_not_registered_flat() {
    let content = fixture();
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let mut router = GeometryRouter::with_units(&content, &mut decoder);
    router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());

    let nested_rep = decoder.decode_by_id(20).expect("decode #20");
    router
        .ensure_shared_mapped_source(&nested_rep, 21, &mut decoder)
        .unwrap();
    assert_eq!(
        router.mapped_shared_unique_count(),
        0,
        "a flat walk of a nested source must not be registered"
    );

    // Negative half: the inner map's representation `#13` is a single solid,
    // the shape the caller actually reaches here, and it IS registered.
    let flat_rep = decoder.decode_by_id(13).expect("decode #13");
    router
        .ensure_shared_mapped_source(&flat_rep, 14, &mut decoder)
        .unwrap();
    assert_eq!(router.mapped_shared_unique_count(), 1);
}

/// The empty-mesh guard: a source that decodes fine but walks to ZERO items
/// (`#40` is a well-formed `IfcShapeRepresentation` with an empty items list)
/// must not be published into the shared registry — an empty/truncated source
/// cached under `source_id` would be served to every later occurrence sharing
/// that `IfcRepresentationMap`, per the doc on `ensure_shared_mapped_source`.
///
/// The second half proves the guard doesn't poison the id going forward: a
/// later call with the SAME `source_id` but a real single-solid source (`#13`)
/// must still register, because the aborted empty attempt inserted nothing.
#[test]
fn empty_mesh_source_not_registered_then_real_source_still_is() {
    let content = fixture();
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let mut router = GeometryRouter::with_units(&content, &mut decoder);
    router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());

    let empty_rep = decoder.decode_by_id(40).expect("decode #40");
    router
        .ensure_shared_mapped_source(&empty_rep, 999, &mut decoder)
        .unwrap();
    assert_eq!(
        router.mapped_shared_unique_count(),
        0,
        "a source that meshes to zero positions must not be cached"
    );

    let flat_rep = decoder.decode_by_id(13).expect("decode #13");
    router
        .ensure_shared_mapped_source(&flat_rep, 999, &mut decoder)
        .unwrap();
    assert_eq!(
        router.mapped_shared_unique_count(),
        1,
        "a real mesh for the same source id must still register after an \
         aborted empty attempt didn't poison the entry"
    );
}
