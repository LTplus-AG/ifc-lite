// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use crate::appearance::evaluated::tests::{corners, real_source};
use crate::appearance::source::Source;
use crate::appearance::tests::{apply, CONTROLLED_IFC};
use crate::appearance::*;
use std::collections::BTreeSet;

/// A uniquely owned parametric Body: one extruded 2 x 1 x 1 box (12 triangles)
/// with one explicit surface style. Its wrapper is not shared by any type map.
const SWEPT: &str = "#40=IFCBUILDINGELEMENTPROXY('0Swept0000000000000001',$,'Swept',$,$,#41,#42,$,.NOTDEFINED.);
#41=IFCLOCALPLACEMENT($,#5);
#42=IFCPRODUCTDEFINITIONSHAPE($,$,(#43));
#43=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#44));
#44=IFCEXTRUDEDAREASOLID(#45,#5,#47,1.);
#45=IFCRECTANGLEPROFILEDEF(.AREA.,$,#46,2.,1.);
#46=IFCAXIS2PLACEMENT2D(#48,$);
#47=IFCDIRECTION((0.,0.,1.));
#48=IFCCARTESIANPOINT((0.,0.));
#49=IFCSTYLEDITEM(#44,(#50),$);
#50=IFCSURFACESTYLE('Plain',.BOTH.,(#51));
#51=IFCSURFACESTYLERENDERING(#27,0.,$,$,$,$,$,$,.NOTDEFINED.);
";
fn swept_source() -> String {
    CONTROLLED_IFC.replace("ENDSEC;\nEND-ISO-10303-21;", &format!("{SWEPT}ENDSEC;\nEND-ISO-10303-21;"))
}
fn request(product: u32, masks: Vec<FaceMask>) -> AppearanceRequest {
    AppearanceRequest { representation_policy: RepresentationPolicy::EvaluatedOccurrence, schema: "IFC4".into(),
        source_revision: "mask".into(), next_express_id: 100, product_ids: vec![product],
        image_uri: "textures/mask.png".into(), repeat_s: true, repeat_t: true,
        mapping: Mapping::Box { frame: MappingFrame::World, origin: [0.; 3], metres_per_tile: [1.; 3] }, face_masks: masks }
}
fn mask(product: u32, fingerprint: &str, triangles: Vec<u32>) -> FaceMask {
    FaceMask { product_id: product, surface_fingerprint: fingerprint.into(), triangles }
}
fn fingerprint_of(source: &str, product: u32) -> String {
    let plan = plan_appearance(source.as_bytes(), &request(product, vec![])).unwrap();
    assert!(plan.exclusions.is_empty(), "{:?}", plan.exclusions);
    plan.conversions[0].surface_fingerprint.clone()
}
fn meshes_of(output: &str, product: u32) -> Vec<crate::types::mesh::MeshData> {
    crate::process_geometry(output.as_bytes()).meshes.into_iter().filter(|m| m.express_id == product).collect()
}
fn selected_corners(mesh: &crate::types::mesh::MeshData, triangles: &[u32], keep: bool) -> Vec<[f64; 3]> {
    let all: Vec<[f64; 3]> = corners(mesh);
    all.chunks_exact(3).enumerate().filter(|(t, _)| triangles.contains(&(*t as u32)) == keep).flat_map(|(_, c)| c.iter().copied()).collect()
}

#[test]
fn issue_4404_unique_swept_body_converts_only_under_evaluated_policy() {
    let source = swept_source();
    let mut preserved = request(40, vec![]);
    preserved.representation_policy = RepresentationPolicy::Preserve;
    let refused = plan_appearance(source.as_bytes(), &preserved).unwrap();
    assert!(refused.items.is_empty() && refused.created.is_empty());
    assert!(refused.exclusions[0].reason.contains("IfcTriangulatedFaceSet"), "{:?}", refused.exclusions);
    let plan = plan_appearance(source.as_bytes(), &request(40, vec![])).unwrap();
    assert!(plan.exclusions.is_empty(), "{:?}", plan.exclusions);
    let conversion = &plan.conversions[0];
    assert_eq!((conversion.representation_id, conversion.source_geometry_item_id), (43, 44), "unique wrapper is rewritten in place");
    assert!(plan.edits.iter().all(|edit| edit.express_id == 43));
    assert_eq!(conversion.surface_fingerprint.len(), 64);
    assert!(conversion.masked_triangles.is_none() && conversion.retained_geometry_item_id.is_none());
    assert_eq!(plan.created.iter().filter(|row| row.r#type == "IfcTriangulatedFaceSet").count(), 1);
    let output = apply(&source, &plan);
    let before = crate::process_geometry(source.as_bytes());
    let after = crate::process_geometry(output.as_bytes());
    assert_eq!(before.meshes.len(), after.meshes.len());
    for mesh in &before.meshes {
        let other = after.meshes.iter().find(|m| m.express_id == mesh.express_id).unwrap();
        if mesh.express_id == 40 {
            assert_eq!(corners(mesh), corners(other)); assert!(other.texture.is_some() && other.uvs.is_some());
        } else { assert_eq!(serde_json::to_value(mesh).unwrap(), serde_json::to_value(other).unwrap()); }
    }
    let mut second = request(40, vec![]);
    second.next_express_id = plan.next_available_express_id; second.image_uri = "textures/second.png".into();
    second.representation_policy = RepresentationPolicy::Preserve;
    let second = plan_appearance(output.as_bytes(), &second).unwrap();
    assert!(second.exclusions.is_empty() && second.conversions.is_empty() && second.items.len() == 1);
}

#[test]
fn issue_4404_face_mask_splits_the_evaluated_body_and_retains_the_source_style() {
    let source = swept_source();
    let fingerprint = fingerprint_of(&source, 40);
    let plan = plan_appearance(source.as_bytes(), &request(40, vec![mask(40, &fingerprint, vec![5, 0, 1, 1])])).unwrap();
    assert!(plan.exclusions.is_empty(), "{:?}", plan.exclusions);
    let conversion = &plan.conversions[0];
    assert_eq!(conversion.masked_triangles.as_deref(), Some(&[0, 1, 5][..]));
    assert_eq!(conversion.surface_fingerprint, fingerprint, "a mask does not change the surface identity");
    let retained = conversion.retained_geometry_item_id.unwrap();
    assert_eq!(plan.items.len(), 1);
    assert_eq!(plan.items[0].geometry_item_id, conversion.geometry_item_id);
    assert_eq!(plan.created.iter().map(|row| row.express_id).collect::<Vec<_>>(), (plan.next_express_id..plan.next_available_express_id).collect::<Vec<_>>());
    let face_sets: Vec<_> = plan.created.iter().filter(|row| row.r#type == "IfcTriangulatedFaceSet").collect();
    assert_eq!(face_sets.iter().map(|row| row.express_id).collect::<Vec<_>>(), vec![conversion.geometry_item_id, retained]);
    assert_eq!(face_sets[0].attributes[0], face_sets[1].attributes[0], "both face sets share one point list");
    assert_eq!(face_sets[0].attributes[3].as_array().unwrap().len(), 3);
    assert_eq!(face_sets[1].attributes[3].as_array().unwrap().len(), 9);
    let retained_style = plan.created.iter().find(|row| row.r#type == "IfcStyledItem" && row.attributes[0] == json!(format!("#{retained}"))).unwrap();
    assert_eq!(retained_style.attributes[1], json!(["#50"]), "the unmasked face set keeps the source surface style");
    let body = plan.edits.iter().find(|edit| edit.express_id == 43 && edit.index == 3).unwrap();
    assert_eq!(body.value, json!([format!("#{}", conversion.geometry_item_id), format!("#{retained}")]));
    let original = meshes_of(&source, 40).remove(0);
    let output = apply(&source, &plan);
    let after = meshes_of(&output, 40);
    assert_eq!(after.len(), 2);
    let textured = after.iter().find(|m| m.geometry_item_id == Some(conversion.geometry_item_id)).unwrap();
    let plain = after.iter().find(|m| m.geometry_item_id == Some(retained)).unwrap();
    assert!(textured.texture.is_some() && textured.uvs.is_some());
    assert!(plain.texture.is_none() && plain.uvs.is_none());
    assert_eq!(plain.color, original.color);
    assert_eq!(corners(textured), selected_corners(&original, &[0, 1, 5], true));
    assert_eq!(corners(plain), selected_corners(&original, &[0, 1, 5], false));
    let mut page = request(40, vec![mask(40, &fingerprint, vec![0, 1, 5])]);
    page.repeat_s = false; page.repeat_t = false;
    page.mapping = Mapping::Planar { frame: MappingFrame::World, origin: [0.; 3], axis_u: [1., 0., 0.], axis_v: [0., 1., 0.], metres_per_tile: [2., 2.] };
    let page = plan_page_appearance(source.as_bytes(), &PageAppearanceRequest { appearance: page,
        page: AppearanceRaster { width: 1, height: 1, byte_offset: 0, byte_length: 4 }, source_images: vec![], texels_per_metre: 16. }, &[0, 0, 255, 255]).unwrap();
    assert!(page.plan.exclusions.is_empty(), "{:?}", page.plan.exclusions);
    assert_eq!(page.plan.conversions[0].masked_triangles.as_deref(), Some(&[0, 1, 5][..]));
    assert_eq!(page.item_images.len(), 1);
    assert_eq!(page.item_images[0].geometry_item_id, page.plan.items[0].geometry_item_id);
    let reopened = meshes_of(&apply(&source, &page.plan), 40);
    assert_eq!(reopened.iter().filter(|m| m.texture.is_some()).count(), 1);
    assert_eq!(reopened.iter().map(|m| m.indices.len() / 3).collect::<BTreeSet<_>>(), BTreeSet::from([3, 9]));
}

#[test]
fn issue_4404_stale_or_malformed_face_masks_are_explicit_refusals() {
    let source = swept_source();
    let fingerprint = fingerprint_of(&source, 40);
    let mut stale = fingerprint.clone();
    stale.replace_range(0..1, if stale.starts_with('0') { "1" } else { "0" });
    let refused = |masks: Vec<FaceMask>| {
        let plan = plan_appearance(source.as_bytes(), &request(40, masks)).unwrap();
        assert!(plan.items.is_empty() && plan.created.is_empty() && plan.edits.is_empty() && plan.conversions.is_empty());
        assert_eq!(plan.exclusions.len(), 1);
        plan.exclusions[0].reason.clone()
    };
    assert_eq!(refused(vec![mask(40, &stale, vec![0])]), super::STALE);
    assert!(refused(vec![mask(40, &fingerprint, vec![12])]).contains("outside the evaluated surface"));
    assert!(refused(vec![mask(40, &fingerprint, vec![])]).contains("no triangles"));
    let whole = plan_appearance(source.as_bytes(), &request(40, vec![mask(40, &fingerprint, (0..12).collect())])).unwrap();
    assert!(whole.exclusions.is_empty());
    assert!(whole.conversions[0].masked_triangles.is_none() && whole.conversions[0].retained_geometry_item_id.is_none());
    assert_eq!(whole.created.iter().filter(|row| row.r#type == "IfcTriangulatedFaceSet").count(), 1);
    let mut preserved = request(40, vec![mask(40, &fingerprint, vec![0])]);
    preserved.representation_policy = RepresentationPolicy::Preserve;
    assert!(plan_appearance(source.as_bytes(), &preserved).unwrap_err().contains("evaluatedOccurrence"));
    let page = PageAppearanceRequest { appearance: AppearanceRequest { repeat_s: false, repeat_t: false,
        mapping: Mapping::Planar { frame: MappingFrame::World, origin: [0.; 3], axis_u: [1., 0., 0.], axis_v: [0., 1., 0.], metres_per_tile: [2., 2.] }, ..preserved },
        page: AppearanceRaster { width: 1, height: 1, byte_offset: 0, byte_length: 4 }, source_images: vec![], texels_per_metre: 16. };
    assert!(plan_page_appearance(source.as_bytes(), &page, &[0, 0, 255, 255]).unwrap_err().contains("evaluatedOccurrence"));
    assert!(plan_appearance(source.as_bytes(), &request(40, vec![mask(10, &fingerprint, vec![0])])).unwrap_err().contains("outside the appearance scope"));
    let mut duplicate = request(40, vec![mask(40, &fingerprint, vec![0]), mask(40, &fingerprint, vec![1])]);
    duplicate.product_ids.push(10);
    assert!(plan_appearance(source.as_bytes(), &duplicate).unwrap_err().contains("Duplicate"));
    assert!(plan_appearance(source.as_bytes(), &request(40, vec![mask(40, &fingerprint, vec![0]), mask(40, &fingerprint, vec![1])])).unwrap_err().contains("exceed the appearance scope"));
    assert!(plan_appearance(source.as_bytes(), &request(40, vec![mask(40, "abc", vec![0])])).unwrap_err().contains("hex SHA-256"));
    let direct = plan_appearance(source.as_bytes(), &request(10, vec![mask(10, &fingerprint, vec![0])])).unwrap();
    assert!(direct.items.is_empty() && direct.created.is_empty());
    assert_eq!(direct.exclusions[0].reason, super::DIRECT_BODY);
}

#[test]
fn issue_4404_surface_fingerprint_binds_to_the_placed_surface_not_express_ids() {
    let source = swept_source();
    let fingerprint = fingerprint_of(&source, 40);
    assert_eq!(fingerprint_of(&source, 40), fingerprint, "deterministic across plans");
    let renumbered = source.replace("#44", "#94");
    assert_eq!(fingerprint_of(&renumbered, 40), fingerprint, "express ids are not part of the surface identity");
    // The local coordinates are rebuilt from the f32 world evaluation, so the
    // placement is part of the identity except where the move is exactly
    // representable: (10, 20, 0) keeps the fingerprint, an ordinary survey
    // offset does not and the mask is reported stale rather than reapplied.
    let place = |x: &str, y: &str, z: &str| source.replace("#41=IFCLOCALPLACEMENT($,#5);",
        &format!("#41=IFCLOCALPLACEMENT($,#52);\n#52=IFCAXIS2PLACEMENT3D(#53,$,$);\n#53=IFCCARTESIANPOINT(({x},{y},{z}));"));
    let exact = place("10.", "20.", "0.");
    assert_eq!(fingerprint_of(&exact, 40), fingerprint, "an f32-exact move keeps the surface");
    let mask_on_exact = plan_appearance(exact.as_bytes(), &request(40, vec![mask(40, &fingerprint, vec![0, 1])])).unwrap();
    assert!(mask_on_exact.exclusions.is_empty(), "{:?}", mask_on_exact.exclusions);
    let moved = place("12.345", "67.891", "0.1");
    assert_ne!(fingerprint_of(&moved, 40), fingerprint, "a placement edit generally changes the placed surface");
    assert_eq!(fingerprint_of(&moved, 40), fingerprint_of(&moved, 40), "the placed surface is itself stable");
    let mask_on_moved = plan_appearance(moved.as_bytes(), &request(40, vec![mask(40, &fingerprint, vec![0, 1])])).unwrap();
    assert_eq!(mask_on_moved.exclusions.len(), 1, "{:?}", mask_on_moved.exclusions);
    assert_eq!(mask_on_moved.exclusions[0].reason, super::STALE);
    assert!(mask_on_moved.items.is_empty() && mask_on_moved.created.is_empty() && mask_on_moved.edits.is_empty());
    let resized = source.replace("#45=IFCRECTANGLEPROFILEDEF(.AREA.,$,#46,2.,1.);", "#45=IFCRECTANGLEPROFILEDEF(.AREA.,$,#46,3.,1.);");
    let changed = fingerprint_of(&resized, 40);
    assert_ne!(changed, fingerprint);
    let stale = plan_appearance(resized.as_bytes(), &request(40, vec![mask(40, &fingerprint, vec![0, 1])])).unwrap();
    assert_eq!(stale.exclusions.len(), 1);
    assert_eq!(stale.exclusions[0].reason, super::STALE);
    assert!(stale.items.is_empty() && stale.created.is_empty() && stale.edits.is_empty());
    let mut source = Source::new(source.as_bytes()).unwrap();
    let product = source.entity(40).unwrap();
    let scale = source.decoder.length_unit_scale();
    let points = [[0.25, 0.5, 0.75], [1.0000004, 2., 3.]];
    let same = super::fingerprint(product.get_string(0).unwrap(), &points, scale, &[0, 1, 0]).unwrap();
    assert_eq!(super::fingerprint(product.get_string(0).unwrap(), &[[0.25, 0.5, 0.75], [1.0000001, 2., 3.]], scale, &[0, 1, 0]).unwrap(), same, "sub-micrometre rounding is quantised away");
    assert_ne!(super::fingerprint(product.get_string(0).unwrap(), &[[0.25, 0.5, 0.75], [1.00001, 2., 3.]], scale, &[0, 1, 0]).unwrap(), same);
    assert_ne!(super::fingerprint("0Other000000000000000a", &points, scale, &[0, 1, 0]).unwrap(), same, "the product identity is part of the mask binding");
    assert!(super::fingerprint("x", &[[f64::INFINITY, 0., 0.]], scale, &[0, 0, 0]).is_err());
}

#[test]
fn issue_4404_real_unique_swept_slab_converts_with_a_cloned_type_shared_wrapper() {
    let Some(source) = real_source() else { return };
    let mut request = request(34509, vec![]);
    request.next_express_id = 100_000; request.source_revision = "real-AC20".into();
    let plan = plan_appearance(source.as_bytes(), &request).unwrap();
    assert!(plan.exclusions.is_empty(), "{:?}", plan.exclusions);
    let conversion = &plan.conversions[0];
    assert_eq!(conversion.source_geometry_item_id, 34485);
    assert_ne!(conversion.representation_id, 34495, "a Body referenced by the type map is cloned, never rewritten");
    assert_eq!(plan.edits.iter().map(|edit| (edit.express_id, edit.index)).collect::<BTreeSet<_>>(), BTreeSet::from([(34505, 2)]));
    assert_eq!(plan.created.iter().map(|row| row.express_id).collect::<Vec<_>>(), (plan.next_express_id..plan.next_available_express_id).collect::<Vec<_>>());
    let output = apply(&source, &plan);
    let mut reopened = Source::new(output.as_bytes()).unwrap();
    assert_eq!(reopened.entity(34495).unwrap().get_string(2), Some("SweptSolid"), "the shared type wrapper is intact");
    assert_eq!(reopened.entity(34509).unwrap().get_ref(6), Some(34505));
    let before = crate::process_geometry(source.as_bytes());
    let after = crate::process_geometry(output.as_bytes());
    assert_eq!(before.meshes.len(), after.meshes.len());
    for mesh in &before.meshes {
        let other = after.meshes.iter().find(|m| m.express_id == mesh.express_id && (m.express_id == 34509 || m.geometry_item_id == mesh.geometry_item_id)).unwrap();
        if mesh.express_id == 34509 { assert_eq!(corners(mesh), corners(other)); assert!(other.texture.is_some()); assert_eq!(mesh.global_id, other.global_id); }
        else { assert_eq!(serde_json::to_value(mesh).unwrap(), serde_json::to_value(other).unwrap()); }
    }
}

#[test]
fn issue_4404_real_mapped_member_face_mask_changes_one_occurrence_only() {
    let Some(source) = real_source() else { return };
    let mut whole = request(35169, vec![]);
    whole.next_express_id = 100_000; whole.source_revision = "real-AC20".into();
    let fingerprint = plan_appearance(source.as_bytes(), &whole).unwrap().conversions[0].surface_fingerprint.clone();
    let mut masked = whole.clone();
    masked.face_masks = vec![mask(35169, &fingerprint, vec![0, 1, 2, 3])];
    let plan = plan_appearance(source.as_bytes(), &masked).unwrap();
    assert!(plan.exclusions.is_empty(), "{:?}", plan.exclusions);
    let conversion = &plan.conversions[0];
    assert_eq!(conversion.masked_triangles.as_deref(), Some(&[0, 1, 2, 3][..]));
    let retained = conversion.retained_geometry_item_id.unwrap();
    assert!(plan.edits.iter().all(|edit| edit.express_id == 35155));
    assert_eq!(plan.created.iter().map(|row| row.express_id).collect::<Vec<_>>(), (plan.next_express_id..plan.next_available_express_id).collect::<Vec<_>>());
    let output = apply(&source, &plan);
    let before = crate::process_geometry(source.as_bytes());
    let after = crate::process_geometry(output.as_bytes());
    assert_eq!(before.meshes.len() + 1, after.meshes.len());
    let original = before.meshes.iter().find(|m| m.express_id == 35169).unwrap();
    let textured = after.meshes.iter().find(|m| m.geometry_item_id == Some(conversion.geometry_item_id)).unwrap();
    let plain = after.meshes.iter().find(|m| m.geometry_item_id == Some(retained)).unwrap();
    assert!(textured.texture.is_some() && plain.texture.is_none());
    assert_eq!((textured.indices.len() / 3, plain.indices.len() / 3), (4, 8));
    assert_eq!(corners(textured), selected_corners(original, &[0, 1, 2, 3], true));
    assert_eq!(corners(plain), selected_corners(original, &[0, 1, 2, 3], false));
    assert_eq!(plain.color, original.color);
    assert_eq!(textured.global_id, original.global_id);
    for mesh in before.meshes.iter().filter(|m| m.express_id != 35169) {
        let other = after.meshes.iter().find(|m| m.express_id == mesh.express_id && m.geometry_item_id == mesh.geometry_item_id).unwrap();
        assert_eq!(serde_json::to_value(mesh).unwrap(), serde_json::to_value(other).unwrap());
    }
    if let Ok(directory) = std::env::var("IFCLITE_EVALUATED_EVIDENCE_DIR") {
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(std::path::Path::new(&directory).join("native-mask-planned.ifc"), output).unwrap();
        std::fs::write(std::path::Path::new(&directory).join("native-mask-plan.json"), serde_json::to_vec_pretty(&plan).unwrap()).unwrap();
    }
}

/// The post-opening slab (one opening, cloned type-shared wrapper, rounding
/// bounds on the cut corners) carries a partial mask: the retained face set
/// must reproduce the cut geometry the unmasked conversion authors.
#[test]
fn issue_4404_real_cut_slab_face_mask_retains_the_opening_cut_geometry() {
    let Some(source) = real_source() else { return };
    let mut whole = request(59290, vec![]);
    whole.next_express_id = 100_000; whole.source_revision = "real-AC20".into();
    let unmasked = plan_appearance(source.as_bytes(), &whole).unwrap();
    assert!(unmasked.exclusions.is_empty(), "{:?}", unmasked.exclusions);
    let fingerprint = unmasked.conversions[0].surface_fingerprint.clone();
    let cut = meshes_of(&apply(&source, &unmasked), 59290);
    assert_eq!(cut.len(), 1);
    assert_eq!(cut[0].indices.len() / 3, 32, "the unmasked conversion authors the cut slab");
    let selected: Vec<u32> = (0..32).step_by(2).collect();
    let mut masked = whole.clone();
    masked.face_masks = vec![mask(59290, &fingerprint, selected.clone())];
    let plan = plan_appearance(source.as_bytes(), &masked).unwrap();
    assert!(plan.exclusions.is_empty(), "{:?}", plan.exclusions);
    let conversion = &plan.conversions[0];
    assert_eq!(conversion.masked_triangles.as_deref(), Some(&selected[..]));
    assert_eq!(conversion.surface_fingerprint, fingerprint);
    let retained = conversion.retained_geometry_item_id.unwrap();
    assert_eq!(conversion.source_removed_meshes.len(), 1, "the opening companion still travels with a masked plan");
    assert_eq!(conversion.source_removed_meshes[0].express_id, 59365);
    assert_ne!(conversion.representation_id, 59278, "the type-shared wrapper is cloned, never rewritten");
    assert_eq!(plan.edits.iter().map(|edit| (edit.express_id, edit.index)).collect::<BTreeSet<_>>(),
        unmasked.edits.iter().map(|edit| (edit.express_id, edit.index)).collect::<BTreeSet<_>>(), "a mask adds no edit beyond the unmasked conversion");
    assert_eq!(plan.edits.iter().map(|edit| edit.express_id).collect::<BTreeSet<_>>(), BTreeSet::from([59286, 59354]));
    assert_eq!(plan.created.iter().map(|row| row.express_id).collect::<Vec<_>>(), (plan.next_express_id..plan.next_available_express_id).collect::<Vec<_>>());
    let face_sets: Vec<_> = plan.created.iter().filter(|row| row.r#type == "IfcTriangulatedFaceSet").collect();
    assert_eq!(face_sets.iter().map(|row| row.express_id).collect::<Vec<_>>(), vec![conversion.geometry_item_id, retained]);
    assert_eq!(face_sets[0].attributes[0], face_sets[1].attributes[0], "both face sets share one point list");
    let output = apply(&source, &plan);
    let before = crate::process_geometry(source.as_bytes());
    let after = crate::process_geometry(output.as_bytes());
    assert_eq!(before.meshes.len(), after.meshes.len(), "one opening mesh leaves, one retained face set arrives");
    assert!(!after.meshes.iter().any(|mesh| mesh.express_id == 59365), "the Reference opening produces no subtractive geometry");
    let textured = after.meshes.iter().find(|m| m.geometry_item_id == Some(conversion.geometry_item_id)).unwrap();
    let plain = after.meshes.iter().find(|m| m.geometry_item_id == Some(retained)).unwrap();
    assert!(textured.texture.is_some() && textured.uvs.is_some());
    assert!(plain.texture.is_none() && plain.uvs.is_none());
    assert_eq!((textured.indices.len() / 3, plain.indices.len() / 3), (16, 16));
    assert_eq!(corners(textured), selected_corners(&cut[0], &selected, true));
    assert_eq!(corners(plain), selected_corners(&cut[0], &selected, false), "the retained set is the unmasked cut geometry");
    let original = before.meshes.iter().find(|m| m.express_id == 59290).unwrap();
    assert_eq!(plain.color, original.color);
    assert_eq!(textured.global_id, original.global_id);
    assert_eq!(plain.global_id, original.global_id);
    let mut max_error = 0f64;
    for (mesh, keep) in [(textured, true), (plain, false)] {
        for (a, b) in selected_corners(original, &selected, keep).iter().zip(corners(mesh)) {
            for axis in 0..3 { max_error = max_error.max((a[axis] - b[axis]).abs()); }
        }
    }
    assert!(max_error <= 1e-3, "masked and retained corners stay within a millimetre of the canonical cut source: {max_error}");
    for mesh in before.meshes.iter().filter(|m| m.express_id != 59290 && m.express_id != 59365) {
        let other = after.meshes.iter().find(|m| m.express_id == mesh.express_id && m.geometry_item_id == mesh.geometry_item_id).unwrap();
        assert_eq!(serde_json::to_value(mesh).unwrap(), serde_json::to_value(other).unwrap());
    }
}
