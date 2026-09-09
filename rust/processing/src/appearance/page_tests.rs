// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
use ifc_lite_core::AttributeValue as A;
use crate::appearance::tests::{apply, CONTROLLED_IFC};
use crate::types::mesh::MeshData;
fn fixture() -> (PageAppearanceRequest, Vec<u8>) {
    let page = vec![255, 0, 0, 255];
    let mut rgba = page;
    rgba.extend([20, 80, 160, 255, 80, 160, 240, 255, 160, 40, 80, 255, 240, 80, 20, 255]);
    (PageAppearanceRequest {
        appearance: AppearanceRequest { representation_policy: RepresentationPolicy::Preserve, schema: "IFC4".into(), source_revision: "page-fixture".into(),
            next_express_id: 100, product_ids: vec![10, 30], image_uri: "appearance/page.png".into(),
            repeat_s: false, repeat_t: false, mapping: Mapping::Planar { frame: MappingFrame::World,
                origin: [0.2, 0.2, 0.], axis_u: [1., 0., 0.], axis_v: [0., 1., 0.], metres_per_tile: [0.4, 0.4] } },
        page: AppearanceRaster { width: 1, height: 1, byte_offset: 0, byte_length: 4 },
        source_images: vec![AppearanceSourceRaster { image_uri: "textures/wood.jpg".into(), raster: AppearanceRaster {
            width: 2, height: 2, byte_offset: 4, byte_length: 16 } }], texels_per_metre: 128.,
    }, rgba)
}
fn decoded(asset: &AppearanceGeneratedImage) -> Vec<u8> {
    let mut reader = png::Decoder::new(std::io::Cursor::new(&asset.png)).read_info().unwrap();
    let mut rgba = vec![0; reader.output_buffer_size().unwrap()];
    let frame = reader.next_frame(&mut rgba).unwrap(); rgba.truncate(frame.buffer_size()); rgba
}
fn sample(mesh: &MeshData, raster: Raster<'_>, point: [f64; 3], repeat: [bool; 2]) -> [f64; 4] {
    for tri in mesh.indices.chunks_exact(3) {
        let pts: Vec<[f64; 3]> = tri.iter().map(|i| std::array::from_fn(|a|
            mesh.origin[a] + f64::from(mesh.positions[*i as usize * 3 + a]))).collect();
        if pts.iter().any(|p| (p[2] - point[2]).abs() > 1e-5) { continue; }
        let [a, b, c] = [pts[0], pts[1], pts[2]];
        let denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
        if denominator.abs() < 1e-9 { continue; }
        let u = ((b[1] - c[1]) * (point[0] - c[0]) + (c[0] - b[0]) * (point[1] - c[1])) / denominator;
        let v = ((c[1] - a[1]) * (point[0] - c[0]) + (a[0] - c[0]) * (point[1] - c[1])) / denominator;
        let w = [u, v, 1. - u - v]; if w.iter().any(|v| *v < -1e-5) { continue; }
        let uv = mesh.uvs.as_ref().unwrap();
        let uv: [f64; 2] = std::array::from_fn(|axis| tri.iter().enumerate().map(|(i, index)| f64::from(uv[*index as usize * 2 + axis]) * w[i]).sum());
        let rgba = raster.sample([uv[0], 1. - uv[1]], repeat);
        return std::array::from_fn(|i| rgba[i] * f64::from(mesh.color[i]));
    }
    panic!("test point not on canonical source triangle");
}
#[test]
fn issue_4260_two_objects_preserve_original_albedo_outside_page_after_real_ifc_png_roundtrip() {
    let (request, rgba) = fixture();
    let result = plan_page_appearance(CONTROLLED_IFC.as_bytes(), &request, &rgba).unwrap();
    assert!(result.plan.exclusions.is_empty(), "{:?}", result.plan.exclusions);
    assert_eq!(result.assets.len(), 2);
    assert_ne!(result.assets[0].image_uri, result.assets[1].image_uri);
    let before = crate::process_geometry(CONTROLLED_IFC.as_bytes());
    let reopened = crate::process_geometry(apply(CONTROLLED_IFC, &result.plan).as_bytes());
    let old_raster = Raster::supplied(&request.source_images[0].raster, &rgba).unwrap();
    for (id, z) in [(10, 0.), (30, 5.)] {
        let old = before.meshes.iter().find(|m| m.express_id == id).unwrap();
        let new = reopened.meshes.iter().find(|m| m.express_id == id).unwrap();
        assert_eq!(old.indices.len(), new.indices.len());
        for (a, b) in old.indices.iter().zip(&new.indices) {
            assert_eq!(&old.positions[*a as usize * 3..*a as usize * 3 + 3], &new.positions[*b as usize * 3..*b as usize * 3 + 3]);
        }
        let image = result.assets.iter().find(|a| Some(a.image_uri.as_str()) == new.texture.as_ref().unwrap().url.as_deref()).unwrap();
        let pixels = decoded(image); let raster = Raster::new(image.width, image.height, &pixels).unwrap();
        let point = [0.05, 0.1, z];
        let expected = sample(old, old_raster, point, [true, false]);
        let outside = sample(new, raster, point, [false, false]);
        for i in 0..4 { assert!((outside[i] - expected[i]).abs() < 0.025, "outside {id}: {outside:?} != {expected:?}"); }
        let inside = sample(new, raster, [0.3, 0.3, z], [false, false]);
        assert!(inside[0] > 0.98 && inside[1] < 0.02 && inside[2] < 0.02, "inside {id}: {inside:?}");
    }
}
#[test]
fn issue_4260_transparent_page_and_refusals_never_replace_missing_source_with_white() {
    let (mut request, mut rgba) = fixture();
    let source = std::mem::take(&mut request.source_images);
    assert!(plan_page_appearance(CONTROLLED_IFC.as_bytes(), &request, &rgba).unwrap_err().contains("Missing pixels"));
    request.source_images = source;
    rgba[3] = 0;
    let result = plan_page_appearance(CONTROLLED_IFC.as_bytes(), &request, &rgba).unwrap();
    let before = crate::process_geometry(CONTROLLED_IFC.as_bytes());
    let after = crate::process_geometry(apply(CONTROLLED_IFC, &result.plan).as_bytes());
    let old = before.meshes.iter().find(|m| m.express_id == 10).unwrap();
    let new = after.meshes.iter().find(|m| m.express_id == 10).unwrap();
    let image = &result.assets[0]; let pixels = decoded(image);
    let actual = sample(new, Raster::new(image.width, image.height, &pixels).unwrap(), [0.3, 0.3, 0.], [false, false]);
    let expected = sample(old, Raster::supplied(&request.source_images[0].raster, &rgba).unwrap(), [0.3, 0.3, 0.], [true, false]);
    for i in 0..4 { assert!((actual[i] - expected[i]).abs() < 0.025); }
}
#[test]
fn issue_4260_raster_ranges_and_atlas_density_are_bounded_before_large_allocation() {
    let (mut request, rgba) = fixture();
    request.page.byte_offset = usize::MAX;
    assert!(plan_page_appearance(CONTROLLED_IFC.as_bytes(), &request, &rgba).unwrap_err().contains("overflow"));
    request.page.byte_offset = 0; request.page.width = u32::MAX;
    assert!(plan_page_appearance(CONTROLLED_IFC.as_bytes(), &request, &rgba).unwrap_err().contains("dimensions"));
    request.page.width = 1; request.texels_per_metre = 16_384.;
    assert!(plan_page_appearance(CONTROLLED_IFC.as_bytes(), &request, &rgba).unwrap_err().contains("requested/source fidelity"));
    request.texels_per_metre = 128.; request.appearance.repeat_s = true;
    assert!(plan_page_appearance(CONTROLLED_IFC.as_bytes(), &request, &rgba).unwrap_err().contains("non-repeating"));
}
#[test]
fn issue_4260_untextured_source_outside_page_keeps_canonical_surface_color() {
    let (mut request, rgba) = fixture(); request.appearance.product_ids = vec![10];
    let source = CONTROLLED_IFC.lines().filter(|line| !line.starts_with("#22=")).collect::<Vec<_>>().join("\n");
    let result = plan_page_appearance(source.as_bytes(), &request, &rgba).unwrap();
    let before = crate::process_geometry(source.as_bytes());
    let after = crate::process_geometry(apply(&source, &result.plan).as_bytes());
    let old = before.meshes.iter().find(|m| m.express_id == 10).unwrap();
    assert!(old.texture.is_none());
    let new = after.meshes.iter().find(|m| m.express_id == 10).unwrap();
    let image = &result.assets[0]; let pixels = decoded(image);
    let outside = sample(new, Raster::new(image.width, image.height, &pixels).unwrap(), [0.05, 0.1, 0.], [false, false]);
    for (actual, expected) in outside.iter().zip(old.color) { assert!((*actual - f64::from(expected)).abs() < 0.01); }
    // Flat translucency uses a distinct renderer path; reject it explicitly
    // rather than silently replacing it with an opaque textured draw.
    let translucent = source.replace("#25=IFCSURFACESTYLERENDERING(#27,0.,", "#25=IFCSURFACESTYLERENDERING(#27,0.5,");
    assert!(plan_page_appearance(translucent.as_bytes(), &request, &rgba).unwrap_err().contains("translucent"));
}
#[test]
fn issue_4260_second_page_apply_uses_canonical_image_uri_and_keeps_the_first_page_outside_new_bounds() {
    let (mut request, rgba) = fixture();
    let first = plan_page_appearance(CONTROLLED_IFC.as_bytes(), &request, &rgba).unwrap();
    let source = apply(CONTROLLED_IFC, &first.plan);
    let mut payload = vec![0, 255, 0, 255];
    request.source_images.clear();
    for asset in &first.assets {
        let pixels = decoded(asset);
        request.source_images.push(AppearanceSourceRaster { image_uri: asset.image_uri.clone(), raster: AppearanceRaster {
            width: asset.width, height: asset.height, byte_offset: payload.len(), byte_length: pixels.len(),
        } });
        payload.extend_from_slice(&pixels);
    }
    request.appearance.next_express_id = first.plan.next_available_express_id;
    request.appearance.image_uri = "appearance/page2.png".into();
    request.appearance.source_revision = "second-page".into();
    if let Mapping::Planar { origin, metres_per_tile, .. } = &mut request.appearance.mapping {
        *origin = [0.65, 0.05, 0.]; *metres_per_tile = [0.2, 0.2];
    }
    let second = plan_page_appearance(source.as_bytes(), &request, &payload).unwrap();
    let reopened = crate::process_geometry(apply(&source, &second.plan).as_bytes());
    for (id, z) in [(10, 0.), (30, 5.)] {
        let mesh = reopened.meshes.iter().find(|m| m.express_id == id).unwrap();
        let asset = second.assets.iter().find(|a| Some(a.image_uri.as_str()) == mesh.texture.as_ref().unwrap().url.as_deref()).unwrap();
        let bytes = decoded(asset); let raster = Raster::new(asset.width, asset.height, &bytes).unwrap();
        let original_page = sample(mesh, raster, [0.3, 0.3, z], [false, false]);
        assert!(original_page[0] > 0.98 && original_page[1] < 0.02, "{original_page:?}");
        let new_page = sample(mesh, raster, [0.7, 0.1, z], [false, false]);
        assert!(new_page[1] > 0.98 && new_page[0] < 0.02, "{new_page:?}");
    }
}
#[test]
fn issue_4260_identical_atlases_deduplicate_by_png_digest_and_aggregate_budget_never_returns_partial_success() {
    let (mut request, rgba) = fixture();
    let source = CONTROLLED_IFC.replace("((1,2,3),(1,2,4),(1,4,3),(2,3,4))", "((1,2,3))")
        .replace("#37=IFCINDEXEDTRIANGLETEXTUREMAP((#20),#34,#36,((3,2,1)));", "#37=IFCINDEXEDTRIANGLETEXTUREMAP((#20),#34,#36,((1,2,3)));\n#38=IFCSTYLEDITEM(#34,(#24),$);");
    let result = plan_page_appearance(source.as_bytes(), &request, &rgba).unwrap();
    assert_eq!(result.item_images.len(), 2); assert_eq!(result.assets.len(), 1);
    assert_eq!(result.item_images[0].image_uri, result.item_images[1].image_uri);
    assert_eq!(result.assets[0].image_uri, format!("textures/{:x}.png", Sha256::digest(&result.assets[0].png)));
    request.texels_per_metre = 2048.;
    assert!(plan_page_appearance(CONTROLLED_IFC.as_bytes(), &request, &rgba).unwrap_err().contains("budget"));
    request.texels_per_metre = 32.;
    assert_eq!(plan_page_appearance(CONTROLLED_IFC.as_bytes(), &request, &rgba).unwrap().plan.items.len(), 2);
}
#[test]
fn issue_4260_low_resolution_page_does_not_erase_high_frequency_source_checker_outside_bounds() {
    let (mut request, mut rgba) = fixture(); request.appearance.product_ids = vec![10];
    request.texels_per_metre = 4.;
    rgba.truncate(4);
    for y in 0..64 { for x in 0..64 {
        let value = if (x / 4 + y / 4) % 2 == 0 { 255 } else { 0 };
        rgba.extend([value, value, value, 255]);
    } }
    request.source_images[0].raster = AppearanceRaster { width: 64, height: 64, byte_offset: 4, byte_length: 64 * 64 * 4 };
    let source = CONTROLLED_IFC.replace("#27=IFCCOLOURRGB($,0.5,0.4,0.3);", "#27=IFCCOLOURRGB($,1.,1.,1.);");
    let result = plan_page_appearance(source.as_bytes(), &request, &rgba).unwrap();
    let before = crate::process_geometry(source.as_bytes());
    let after = crate::process_geometry(apply(&source, &result.plan).as_bytes());
    let old = before.meshes.iter().find(|m| m.express_id == 10).unwrap();
    let new = after.meshes.iter().find(|m| m.express_id == 10).unwrap();
    let asset = &result.assets[0]; let pixels = decoded(asset);
    assert!(asset.width >= 64, "requested page density must not downsample the source");
    for x in [1.5, 5.5, 9.5] {
        let point = [x / 64., 1.5 / 64., 0.];
        let expected = sample(old, Raster::supplied(&request.source_images[0].raster, &rgba).unwrap(), point, [true, false]);
        let actual = sample(new, Raster::new(asset.width, asset.height, &pixels).unwrap(), point, [false, false]);
        assert!((actual[0] - expected[0]).abs() < 0.15, "source detail {point:?}: {actual:?} != {expected:?}");
    }
}

#[test]
fn issue_4260_page_preserves_independent_rendering_fields_and_typed_roughness() {
    let (request, rgba) = fixture();
    let source = CONTROLLED_IFC.replace("#25=IFCSURFACESTYLERENDERING(#27,0.,$,$,$,$,$,$,.NOTDEFINED.);",
        "#25=IFCSURFACESTYLERENDERING(#27,0.,IFCNORMALISEDRATIOMEASURE(0.7),#27,$,#27,IFCNORMALISEDRATIOMEASURE(0.2),IFCSPECULARROUGHNESS(0.35),.PHONG.);");
    let source = source.replace("#37=IFCINDEXEDTRIANGLETEXTUREMAP", "#38=IFCSTYLEDITEM(#34,(#24),$);\n#37=IFCINDEXEDTRIANGLETEXTUREMAP");
    assert!(source.contains("IFCSPECULARROUGHNESS"));
    let result = plan_page_appearance(source.as_bytes(), &request, &rgba).unwrap();
    let exported = apply(&source, &result.plan);
    let mut decoded = Source::new(exported.as_bytes()).unwrap();
    for item in &result.item_images {
        let styled_id = decoded.styled_items[&item.geometry_item_id][0];
        let styled = decoded.entity(styled_id).unwrap();
        let (style_id, _) = crate::prepass::surface_style_from_styled_item(&styled, &mut decoded.decoder).unwrap();
        let style = decoded.entity(style_id).unwrap();
        let rendering = style.get_list(2).unwrap().iter().filter_map(A::as_entity_ref)
            .map(|id| decoded.entity(id).unwrap()).find(|e| e.ifc_type == IfcType::IfcSurfaceStyleRendering).unwrap();
        assert_eq!(rendering.get_float(6), Some(0.2));
        assert_eq!(rendering.get_float(7), Some(0.35));
        assert_eq!(rendering.get_list(7).unwrap()[0].as_string(), Some("IFCSPECULARROUGHNESS"));
        assert_eq!(rendering.get_ref(3), Some(27));
        assert_eq!(rendering.get_ref(5), Some(27));
        assert!(matches!(rendering.get(8), Some(A::Enum(name)) if name == "PHONG"));
        assert!(matches!(rendering.get(2), Some(A::Null)), "baked diffuse factor must not apply twice");
    }
    let original = decoded.entity(25).unwrap();
    assert_eq!(original.get_ref(0), Some(27));
    assert_eq!(original.get_float(2), Some(0.7));
}

#[test]
fn issue_4260_page_refuses_inherited_rendering_instead_of_dropping_its_properties() {
    let (request, rgba) = fixture();
    let source = CONTROLLED_IFC.replace("#23=IFCSTYLEDITEM(#14,", "#23=IFCSTYLEDITEM(#13,");
    let result = plan_page_appearance(source.as_bytes(), &request, &rgba).unwrap();
    assert!(!result.plan.items.iter().any(|item| item.geometry_item_id == 14));
    assert!(result.plan.exclusions.iter().any(|excluded| excluded.product_id == 10));
}

#[test]
fn png_budget_refuses_truncated_final_chunk_4260() {
    let atlas = page_atlas::Atlas { width: 1, height: 1, rgba: vec![20, 80, 160, 255], uv: vec![] };
    let complete = encode_png(&atlas, 4096).unwrap();
    assert_eq!(&complete[complete.len() - 8..complete.len() - 4], b"IEND");
    // Image data fits, but the final IEND chunk does not. Drop cannot report this error.
    for missing in [1, 4, 8, 12] {
        assert!(encode_png(&atlas, complete.len() - missing).is_err(), "accepted incomplete PNG missing {missing} bytes");
    }
    assert_eq!(encode_png(&atlas, complete.len()).unwrap(), complete);
    let mut decoder = png::Decoder::new(std::io::Cursor::new(&complete)).read_info().unwrap();
    let mut pixels = vec![0; decoder.output_buffer_size().unwrap()];
    decoder.next_frame(&mut pixels).unwrap();
    assert_eq!(pixels, atlas.rgba);
}
