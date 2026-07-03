// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `element.rs` (kept in a sibling `_tests.rs` module so the
//! production file stays under the module-size ratchet). Included via
//! `#[path = "element_tests.rs"] mod tests;`.

use super::*;

fn refs(ids: &[u32]) -> FxHashSet<u32> {
    ids.iter().copied().collect()
}

#[test]
fn plan_type_geometry_orphan_type_emits_unreferenced_maps_as_class_1() {
    for mode in [TypeGeometryMode::SuppressInstanced, TypeGeometryMode::EmitTagged] {
        let planned = plan_type_geometry(&[10, 11, 12], &refs(&[11]), false, mode);
        assert_eq!(
            planned,
            vec![(10, 1), (12, 1)],
            "orphan type: unreferenced maps render as class 1 in {mode:?}",
        );
    }
}

#[test]
fn plan_type_geometry_instantiated_type_suppressed_for_export_tagged_for_viewer() {
    let suppress = plan_type_geometry(
        &[10, 11],
        &refs(&[]),
        true,
        TypeGeometryMode::SuppressInstanced,
    );
    assert!(
        suppress.is_empty(),
        "an export must never duplicate an instanced type's geometry"
    );

    let tagged =
        plan_type_geometry(&[10, 11], &refs(&[]), true, TypeGeometryMode::EmitTagged);
    assert_eq!(
        tagged,
        vec![(10, 2), (11, 2)],
        "the viewer renders instanced type maps tagged class 2 for the Types view"
    );
}

#[test]
fn plan_type_geometry_referenced_maps_never_emit() {
    let planned = plan_type_geometry(
        &[10],
        &refs(&[10]),
        false,
        TypeGeometryMode::EmitTagged,
    );
    assert!(
        planned.is_empty(),
        "a map an IfcMappedItem instantiates draws through its occurrence"
    );
}

#[test]
fn find_geometry_item_color_follows_mapped_item() {
    // #100 IfcMappedItem → #101 IfcRepresentationMap → #103
    // IfcShapeRepresentation whose Items = (#110). The style lives on the
    // underlying item #110, not on the mapped item, so a flat lookup of
    // #100 misses it — the resolver must chase the mapping (#913 §2.7).
    const IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m.ifc','2026-06-04T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,$,$);
#100=IFCMAPPEDITEM(#101,#105);
#101=IFCREPRESENTATIONMAP(#102,#103);
#102=IFCAXIS2PLACEMENT3D(#104,$,$);
#103=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#110));
#104=IFCCARTESIANPOINT((0.,0.,0.));
#105=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#104,$,$);
ENDSEC;
END-ISO-10303-21;
"#;
    let blue = [0.1, 0.2, 0.9, 1.0];
    let mut styles: FxHashMap<u32, GeometryStyleInfo> = FxHashMap::default();
    styles.insert(110, GeometryStyleInfo::from_color(blue));

    let mut decoder = EntityDecoder::new(IFC);

    // Mapped item, no direct style → inherits the underlying item's colour.
    assert_eq!(find_geometry_item_color(100, &styles, &mut decoder), Some(blue));
    // A direct style still wins.
    assert_eq!(find_geometry_item_color(110, &styles, &mut decoder), Some(blue));
    // A non-mapped, unstyled item (the representation map itself) → None.
    assert_eq!(find_geometry_item_color(101, &styles, &mut decoder), None);
}

#[test]
fn infer_opening_material_names_glass_vs_frame() {
    let glass =
        infer_opening_subpart_material_name(&IfcType::IfcWindow, [0.7, 0.9, 0.5, 0.3], 42);
    assert_eq!(glass.as_deref(), Some("Window_Glass"));

    let frame =
        infer_opening_subpart_material_name(&IfcType::IfcDoor, [0.5, 0.5, 0.5, 1.0], 7);
    assert_eq!(frame.as_deref(), Some("Door_Frame_7"));

    let none = infer_opening_subpart_material_name(&IfcType::IfcWall, [1.0; 4], 1);
    assert!(none.is_none(), "only windows/doors get inferred part names");
}
