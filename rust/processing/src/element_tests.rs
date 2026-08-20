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

#[test]
fn find_geometry_item_color_terminates_on_cyclic_mapping() {
    // #100's mapped representation lists #100 itself as an item, so the
    // chase re-enters where it started. The chain is entirely file-supplied,
    // so a malformed or hostile file controls the recursion depth.
    const IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m.ifc','2026-06-04T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,$,$);
#100=IFCMAPPEDITEM(#101,$);
#101=IFCREPRESENTATIONMAP($,#103);
#103=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#100));
ENDSEC;
END-ISO-10303-21;
"#;
    let styles: FxHashMap<u32, GeometryStyleInfo> = FxHashMap::default();
    let mut decoder = EntityDecoder::new(IFC);
    assert_eq!(find_geometry_item_color(100, &styles, &mut decoder), None);
}

/// Build a chain of `hops` nested `IfcMappedItem`s whose innermost mapped
/// representation lists the styled leaf `#999`. Entry point is `#200`.
fn nested_mapped_chain(hops: u32) -> String {
    let mut s = String::from(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
         FILE_NAME('m.ifc','2026-06-04T00:00:00',(''),(''),'','','');\n\
         FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
         #2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,$,$);\n",
    );
    for i in 0..hops {
        let map_item = 200 + i;
        let rep_map = 1000 + i;
        let shape = 2000 + i;
        // The last hop's representation holds the styled leaf; the others
        // hold the next mapped item down.
        let inner = if i + 1 == hops { 999 } else { 200 + i + 1 };
        s.push_str(&format!("#{map_item}=IFCMAPPEDITEM(#{rep_map},$);\n"));
        s.push_str(&format!("#{rep_map}=IFCREPRESENTATIONMAP($,#{shape});\n"));
        s.push_str(&format!(
            "#{shape}=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#{inner}));\n"
        ));
    }
    s.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    s
}

#[test]
fn find_geometry_item_color_resolves_exactly_at_the_depth_cap() {
    let green = [0.0, 0.8, 0.2, 1.0];
    let mut styles: FxHashMap<u32, GeometryStyleInfo> = FxHashMap::default();
    styles.insert(999, GeometryStyleInfo::from_color(green));

    let ifc = nested_mapped_chain(MAX_MAPPED_ITEM_DEPTH);
    let mut decoder = EntityDecoder::new(&ifc);
    assert_eq!(
        find_geometry_item_color(200, &styles, &mut decoder),
        Some(green),
        "a chain exactly MAX_MAPPED_ITEM_DEPTH hops deep must still resolve"
    );
}

#[test]
fn find_geometry_item_color_stops_one_hop_past_the_depth_cap() {
    let green = [0.0, 0.8, 0.2, 1.0];
    let mut styles: FxHashMap<u32, GeometryStyleInfo> = FxHashMap::default();
    styles.insert(999, GeometryStyleInfo::from_color(green));

    let ifc = nested_mapped_chain(MAX_MAPPED_ITEM_DEPTH + 1);
    let mut decoder = EntityDecoder::new(&ifc);
    assert_eq!(
        find_geometry_item_color(200, &styles, &mut decoder),
        None,
        "one hop past the cap the chase gives up rather than recursing on"
    );
}

/// The two boundary tests above build their chains *from*
/// `MAX_MAPPED_ITEM_DEPTH`, so they follow the constant wherever it moves and
/// stay green even if it is tuned down to 1 — they pin the boundary's shape,
/// not its position. This one uses a literal depth: nesting this shallow is
/// ordinary in real assemblies (a mapped item inside a mapped type inside an
/// aggregate), and colour must survive it whatever the cap is set to.
#[test]
fn find_geometry_item_color_resolves_ordinary_nesting_depth() {
    let green = [0.0, 0.8, 0.2, 1.0];
    let mut styles: FxHashMap<u32, GeometryStyleInfo> = FxHashMap::default();
    styles.insert(999, GeometryStyleInfo::from_color(green));

    let ifc = nested_mapped_chain(8);
    let mut decoder = EntityDecoder::new(&ifc);
    assert_eq!(
        find_geometry_item_color(200, &styles, &mut decoder),
        Some(green),
        "8 mapped-item hops is ordinary nesting; the cap must not swallow it"
    );
}

/// `resolve_color_for_representation_map` (#957, the type-geometry path) is a
/// second entry point into the same chase, reaching it from a rep map rather
/// than from a mapped item. The cap lives inside `find_geometry_item_color`
/// so it covers both; a guard at either call site would not have.
#[test]
fn resolve_color_for_representation_map_terminates_on_cyclic_mapping() {
    const IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m.ifc','2026-06-04T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,$,$);
#100=IFCMAPPEDITEM(#101,$);
#101=IFCREPRESENTATIONMAP($,#103);
#103=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#100));
ENDSEC;
END-ISO-10303-21;
"#;
    let styles: FxHashMap<u32, GeometryStyleInfo> = FxHashMap::default();
    let mut decoder = EntityDecoder::new(IFC);
    assert_eq!(
        resolve_color_for_representation_map(101, &styles, &mut decoder),
        None
    );
}

/// A depth cap alone bounds the chain LENGTH but not its BREADTH. This
/// representation holds four items that each lead back into the cycle, so a
/// depth-only guard explores `4^MAX_MAPPED_ITEM_DEPTH` paths — no stack
/// overflow, just a worker pinned forever. Trading the abort for a hang would
/// not have been a fix.
///
/// The assertion is on the returned colour, as everywhere else here. Its
/// failure mode without the visited set is a hang rather than a wrong value,
/// which CI reports as a lane timeout; that is stated plainly rather than
/// dressed up as a fast assertion, because there is no way to assert "this
/// returned before the heat death of the universe" that is not a timing test.
#[test]
fn find_geometry_item_color_bounds_cyclic_fan_out_not_just_depth() {
    const IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m.ifc','2026-06-04T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,$,$);
#100=IFCMAPPEDITEM(#101,$);
#101=IFCREPRESENTATIONMAP($,#103);
#103=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#110,#111,#112,#113));
#110=IFCMAPPEDITEM(#101,$);
#111=IFCMAPPEDITEM(#101,$);
#112=IFCMAPPEDITEM(#101,$);
#113=IFCMAPPEDITEM(#101,$);
ENDSEC;
END-ISO-10303-21;
"#;
    let styles: FxHashMap<u32, GeometryStyleInfo> = FxHashMap::default();
    let mut decoder = EntityDecoder::new(IFC);
    assert_eq!(find_geometry_item_color(100, &styles, &mut decoder), None);
}

/// The cap is not a free parameter: it must match the geometry router's
/// `MAX_MAPPED_ITEM_DEPTH`, or a chain longer than this one but shorter than
/// the router's renders its geometry and silently loses its leaf's style.
/// The boundary tests above derive their fixtures FROM this constant, so they
/// follow it anywhere; this pins the value itself.
#[test]
fn mapped_item_depth_cap_matches_the_geometry_router() {
    assert_eq!(
        MAX_MAPPED_ITEM_DEPTH, 32,
        "must equal ifc_lite_geometry::router::processing::MAX_MAPPED_ITEM_DEPTH"
    );
}

/// An item shared between a DEEP branch (where the cap cuts its subtree before
/// the styled leaf) and a SHORT one (where it resolves). A plain visited SET
/// marks it on the deep visit and skips the short one, silently losing the
/// colour — a WRONG VALUE rather than a crash, so nothing reports it
/// (Codex, #2868 review; same shape here).
#[test]
fn a_shared_item_resolves_via_the_shallow_branch() {
    let mut body = String::from(
        "#200=IFCMAPPEDITEM(#201,$);\n\
         #201=IFCREPRESENTATIONMAP($,#202);\n\
         #202=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#300,#900));\n",
    );
    for i in 0..30u32 {
        let (item, rm, sh) = (300 + i, 400 + i, 500 + i);
        let inner = if i == 29 { 900 } else { 300 + i + 1 };
        body.push_str(&format!("#{item}=IFCMAPPEDITEM(#{rm},$);\n"));
        body.push_str(&format!("#{rm}=IFCREPRESENTATIONMAP($,#{sh});\n"));
        body.push_str(&format!(
            "#{sh}=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#{inner}));\n"
        ));
    }
    body.push_str(
        "#900=IFCMAPPEDITEM(#901,$);\n\
         #901=IFCREPRESENTATIONMAP($,#902);\n\
         #902=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#950));\n\
         #950=IFCMAPPEDITEM(#951,$);\n\
         #951=IFCREPRESENTATIONMAP($,#952);\n\
         #952=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#999));\n",
    );
    let ifc = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
         FILE_NAME('m.ifc','2026-06-04T00:00:00',(''),(''),'','','');\n\
         FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
         #2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,$,$);\n{body}ENDSEC;\nEND-ISO-10303-21;\n"
    );
    let green = [0.0, 0.8, 0.2, 1.0];
    let mut styles: FxHashMap<u32, GeometryStyleInfo> = FxHashMap::default();
    styles.insert(999, GeometryStyleInfo::from_color(green));
    let mut decoder = EntityDecoder::new(&ifc);
    assert_eq!(
        find_geometry_item_color(200, &styles, &mut decoder),
        Some(green),
        "the shallow branch reaches the styled leaf well inside the cap"
    );
}
