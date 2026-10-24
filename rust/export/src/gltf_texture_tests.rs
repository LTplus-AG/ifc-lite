// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "gltf-textures")]
//! Opt-in glTF texture export (#7955 J5) against the buildingSMART annex-E
//! textured fixtures and in-tree untextured fixtures. A missing annex-E
//! fixture skips, and panics under `IFC_LITE_REQUIRE_FIXTURES=1` (the shared
//! testkit gate, #2802), so CI cannot pass these silently.
//!
//! Oracles fixed before the first run: `TEXCOORD_0` bytes equal the canonical
//! `MeshData::uvs` exactly; a decoded image is a PNG in the binary chunk that
//! round-trips to the canonical RGBA exactly; an image reference resolves back
//! to `URLReference` exactly; a textured material is `MASK` with cutoff
//! `0.004 * baseColorFactor.a` (the viewer's discard, within 1e-7), or 1.0 at
//! a tint alpha of at most 0.01 (the viewer hides the mesh); every material is
//! used by a primitive; the option
//! leaves untextured exports byte-identical; anything the assembler cannot
//! carry is refused with a typed error.
use super::tests::parse_glb;
use super::*;
use ifc_lite_processing::MeshTextureData;

const ANNEX_E: &str = "buildingsmart/annex_e/tessellated-shape-with-style";

fn annex_e(name: &str) -> Option<Vec<u8>> {
    crate::test_support::fixture_opt(&format!("{ANNEX_E}/{name}"))
}

fn meshes(bytes: &[u8]) -> ProcessingResult {
    process(bytes, &ProcessingRequest::full_pass().quality(TessellationQuality::Medium), &mut ())
}

fn textured_opts() -> GltfOptions {
    GltfOptions::default().with_include_metadata(true).with_textures(true)
}

fn floats(json: &Value, bin: &[u8], accessor: usize) -> Vec<f32> {
    let acc = &json["accessors"][accessor];
    let view = &json["bufferViews"][acc["bufferView"].as_u64().unwrap() as usize];
    let width = match acc["type"].as_str().unwrap() {
        "VEC2" => 2,
        "VEC3" => 3,
        other => panic!("unexpected accessor type {other}"),
    };
    let stride = view["byteStride"].as_u64().map_or(width * 4, |s| s as usize);
    let start = view["byteOffset"].as_u64().unwrap() as usize + acc["byteOffset"].as_u64().unwrap() as usize;
    let count = acc["count"].as_u64().unwrap() as usize;
    (0..count)
        .flat_map(|i| (0..width).map(move |k| start + i * stride + k * 4))
        .map(|at| f32::from_le_bytes(bin[at..at + 4].try_into().unwrap()))
        .collect()
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            out.push(u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap(), 16).unwrap());
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap()
}

/// Decode an embedded image (a PNG bufferView in the binary chunk) to RGBA8.
fn decode_embedded_png(json: &Value, bin: &[u8], image: &Value) -> (Vec<u8>, u32, u32) {
    assert!(image.get("uri").is_none(), "embedded, not a URI: {image}");
    assert_eq!(image["mimeType"], "image/png");
    let view = &json["bufferViews"][image["bufferView"].as_u64().expect("image bufferView") as usize];
    assert!(view.get("byteStride").is_none() && view.get("target").is_none(), "image view: {view}");
    let start = view["byteOffset"].as_u64().unwrap() as usize;
    let end = start + view["byteLength"].as_u64().unwrap() as usize;
    assert!(end <= json["buffers"][0]["byteLength"].as_u64().unwrap() as usize, "inside buffer 0");
    let png = bin[start..end].to_vec();
    let mut reader = png::Decoder::new(std::io::Cursor::new(png)).read_info().unwrap();
    let mut rgba = vec![0; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut rgba).unwrap();
    assert_eq!((info.color_type, info.bit_depth), (png::ColorType::Rgba, png::BitDepth::Eight));
    rgba.truncate(info.buffer_size());
    (rgba, info.width, info.height)
}

/// Every textured primitive in the GLB: (expressId, uv floats, position count,
/// material JSON, texture JSON).
fn textured_primitives(json: &Value, bin: &[u8]) -> Vec<(u32, Vec<f32>, usize, Value, Value)> {
    let mut out = Vec::new();
    for node in json["nodes"].as_array().unwrap() {
        let Some(mesh) = node["mesh"].as_u64() else { continue };
        let primitive = &json["meshes"][mesh as usize]["primitives"][0];
        let Some(uv) = primitive["attributes"]["TEXCOORD_0"].as_u64() else { continue };
        let positions = json["accessors"][primitive["attributes"]["POSITION"].as_u64().unwrap() as usize]["count"]
            .as_u64()
            .unwrap() as usize;
        let material = json["materials"][primitive["material"].as_u64().unwrap() as usize].clone();
        let texture = material["pbrMetallicRoughness"]["baseColorTexture"]["index"].as_u64().expect("textured material");
        let id = node["extras"]["expressId"].as_u64().unwrap() as u32;
        out.push((id, floats(json, bin, uv as usize), positions, material, json["textures"][texture as usize].clone()));
    }
    out
}

fn assert_textured_export(bytes: &[u8], decoded: bool) {
    let result = meshes(bytes);
    let canonical: Vec<&MeshData> = result.meshes.iter().filter(|m| m.texture.is_some()).collect();
    assert!(!canonical.is_empty(), "fixture must produce a textured mesh");
    let (json, bin) = parse_glb(&try_export_glb(bytes, &textured_opts()).unwrap());
    let primitives = textured_primitives(&json, &bin);
    assert_eq!(primitives.len(), canonical.len(), "one textured primitive per textured mesh");
    let used: std::collections::BTreeSet<u64> = json["meshes"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|mesh| mesh["primitives"].as_array().unwrap())
        .filter_map(|primitive| primitive["material"].as_u64())
        .collect();
    assert_eq!(used.len(), json["materials"].as_array().unwrap().len(), "no unused material");
    for (id, uvs, positions, material, texture) in &primitives {
        let mesh = canonical
            .iter()
            .find(|m| m.express_id == *id && m.uvs.as_ref().is_some_and(|c| c.len() == uvs.len()))
            .expect("primitive maps to a canonical textured mesh");
        let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(uvs), bits(mesh.uvs.as_ref().unwrap()), "TEXCOORD_0 is the canonical UVs verbatim");
        assert_eq!(*positions, uvs.len() / 2, "one UV per exported vertex");
        let t = mesh.texture.as_ref().unwrap();
        let sampler = &json["samplers"][texture["sampler"].as_u64().unwrap() as usize];
        let wrap = |repeat: bool| if repeat { 10497 } else { 33071 };
        assert_eq!((sampler["wrapS"].as_u64(), sampler["wrapT"].as_u64()), (Some(wrap(t.repeat_s)), Some(wrap(t.repeat_t))));
        // The viewer draws textured meshes opaque and discards texels below
        // alpha 0.004; glTF MASK compares factor.a * texel.a to the cutoff.
        assert_eq!(material["alphaMode"], "MASK");
        let factor = material["pbrMetallicRoughness"]["baseColorFactor"][3].as_f64().unwrap();
        assert!((material["alphaCutoff"].as_f64().unwrap() - 0.004 * factor).abs() <= 1e-7, "{material}");
        let image = &json["images"][texture["source"].as_u64().unwrap() as usize];
        if decoded {
            let (rgba, width, height) = decode_embedded_png(&json, &bin, image);
            assert_eq!((width, height), (t.width, t.height));
            assert!(rgba == **t.rgba.as_ref().unwrap(), "embedded PNG round-trips to the canonical RGBA");
        } else {
            let uri = image["uri"].as_str().unwrap();
            assert_eq!(percent_decode(uri), *t.url.as_ref().unwrap(), "image reference resolves to URLReference");
        }
    }
}

#[test]
fn issue_7955_j5_blob_texture_exports_texcoords_and_embedded_png() {
    let Some(bytes) = annex_e("tessellation-with-blob-texture.ifc") else { return };
    assert_textured_export(&bytes, true);
}

#[test]
fn issue_7955_j5_pixel_texture_exports_texcoords_and_embedded_png() {
    let Some(bytes) = annex_e("tessellation-with-pixel-texture.ifc") else { return };
    assert_textured_export(&bytes, true);
}

#[test]
fn issue_7955_j5_image_texture_exports_texcoords_and_its_url_reference() {
    let Some(bytes) = annex_e("tessellation-with-image-texture.ifc") else { return };
    assert_textured_export(&bytes, false);
}

#[test]
fn issue_7955_j5_default_export_of_a_textured_model_stays_untextured() {
    let Some(bytes) = annex_e("tessellation-with-blob-texture.ifc") else { return };
    let (json, bin) = parse_glb(&try_export_glb(&bytes, &GltfOptions::default().with_include_metadata(true)).unwrap());
    assert!(textured_primitives(&json, &bin).is_empty());
    for key in ["images", "samplers", "textures"] {
        assert!(json.get(key).is_none(), "default output carries no {key}");
    }
}

#[test]
fn issue_7955_j5_textures_option_leaves_untextured_exports_byte_identical() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/..");
    for path in [
        "geometry/tests/fixtures/mapped_instances_synthetic.ifc", // instanced groups
        "processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc", // void cuts
    ] {
        let bytes = std::fs::read(format!("{dir}/{path}")).unwrap();
        let base = try_export_glb(&bytes, &GltfOptions::default()).unwrap();
        assert!(base == try_export_glb(&bytes, &GltfOptions::default().with_textures(true)).unwrap(), "{path}");
    }
}

#[test]
fn issue_7955_j5_textures_are_refused_where_they_cannot_be_carried() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/..");
    let bytes = std::fs::read(format!("{dir}/geometry/tests/fixtures/mapped_instances_synthetic.ifc")).unwrap();
    let opts = GltfOptions::default().with_textures(true);
    let code = |r: Result<(), ExportError>| r.unwrap_err().code();
    let quantized = GltfOptions::default().with_textures(true).with_quantize(true);
    assert_eq!(code(try_export_glb(&bytes, &quantized).map(drop)), "UNSUPPORTED_OPTION");
    assert_eq!(code(try_export_glb_streaming_bounded(&bytes, &opts).map(drop)), "UNSUPPORTED_OPTION");
    assert_eq!(code(export_gltf_streaming(&bytes, &opts, 1 << 20, |_| {}).map(drop)), "UNSUPPORTED_OPTION");
}

#[test]
fn issue_7955_j5_incomplete_appearance_is_refused_not_exported_as_solid_colour() {
    let Some(bytes) = annex_e("tessellation-with-blob-texture.ifc") else { return };
    type Break = fn(&mut MeshData);
    let breaks: [(&str, Break); 3] = [
        ("missing UVs", |m| m.uvs = None),
        ("short UVs", |m| m.uvs.as_mut().unwrap().truncate(4)),
        ("truncated pixels", |m| {
            let t = m.texture.as_mut().unwrap();
            t.rgba = Some(std::sync::Arc::new(t.rgba.as_ref().unwrap()[4..].to_vec()));
        }),
    ];
    for (what, corrupt) in breaks {
        let mut result = meshes(&bytes);
        let mesh = result.meshes.iter_mut().find(|m| m.texture.is_some()).unwrap();
        corrupt(mesh);
        let err = try_export_glb_from_result(result, &textured_opts()).map(drop).unwrap_err();
        assert_eq!(err.code(), "INCOMPLETE_APPEARANCE", "{what}: {err}");
    }
}

#[test]
fn issue_7955_j5_absolute_image_reference_is_refused_not_exported_as_a_scheme() {
    let Some(bytes) = annex_e("tessellation-with-image-texture.ifc") else { return };
    for url in ["C:\\textures\\x.png", "/srv/textures/x.png", "https://example.com/x.png", "../shared/x.png"] {
        let mut result = meshes(&bytes);
        let mesh = result.meshes.iter_mut().find(|m| m.texture.is_some()).unwrap();
        mesh.texture.as_mut().unwrap().url = Some(url.into());
        let err = try_export_glb_from_result(result, &textured_opts()).map(drop).unwrap_err();
        assert_eq!(err.code(), "INCOMPLETE_APPEARANCE", "{url}: {err}");
    }
    // A Windows-relative reference is still exported, as a relative URI.
    let mut result = meshes(&bytes);
    let mesh = result.meshes.iter_mut().find(|m| m.texture.is_some()).unwrap();
    mesh.texture.as_mut().unwrap().url = Some("textures\\x 1.png".into());
    let (json, _) = parse_glb(&try_export_glb_from_result(result, &textured_opts()).unwrap().0);
    assert_eq!(json["images"][0]["uri"], "textures/x%201.png");
}

#[test]
fn issue_7955_j5_translucent_tint_scales_the_mask_cutoff_to_the_viewer_discard() {
    // The viewer draws a textured mesh opaque whatever its tint alpha and
    // discards texels below 0.004; glTF MASK tests factor.a * texel.a, so the
    // cutoff must be 0.004 * 0.5 for a half-transparent tint.
    let Some(bytes) = annex_e("tessellation-with-blob-texture.ifc") else { return };
    let mut result = meshes(&bytes);
    for mesh in result.meshes.iter_mut().filter(|m| m.texture.is_some()) {
        mesh.color[3] = 0.5;
    }
    let (json, bin) = parse_glb(&try_export_glb_from_result(result, &textured_opts()).unwrap().0);
    let primitives = textured_primitives(&json, &bin);
    assert!(!primitives.is_empty());
    for (_, _, _, material, _) in primitives {
        assert_eq!(material["alphaMode"], "MASK", "not BLEND: the viewer does not blend textured meshes");
        assert!((material["alphaCutoff"].as_f64().unwrap() - 0.002).abs() <= 1e-7, "{material}");
    }
}

#[test]
fn issue_7955_j5_a_tint_the_viewer_hides_is_hidden_in_gltf_too() {
    // The viewer skips a textured mesh whose own alpha is <= 0.01. A scaled
    // cutoff would be 0 at alpha 0 and keep every fragment; cutoff 1.0 is
    // above any factor.a * texel.a <= 0.01, so nothing is drawn.
    let Some(bytes) = annex_e("tessellation-with-blob-texture.ifc") else { return };
    for (alpha, cutoff) in [(0.0, 1.0), (0.01, 1.0), (0.02, 0.004 * 0.02)] {
        let mut result = meshes(&bytes);
        for mesh in result.meshes.iter_mut().filter(|m| m.texture.is_some()) {
            mesh.color[3] = alpha;
        }
        let (json, bin) = parse_glb(&try_export_glb_from_result(result, &textured_opts()).unwrap().0);
        let primitives = textured_primitives(&json, &bin);
        assert!(!primitives.is_empty());
        for (_, _, _, material, _) in primitives {
            assert_eq!(material["alphaMode"], "MASK", "{alpha}");
            assert!((material["alphaCutoff"].as_f64().unwrap() - cutoff).abs() <= 1e-7, "{alpha}: {material}");
        }
    }
}

#[test]
fn issue_7955_j5_tints_either_side_of_the_hide_threshold_never_share_a_material() {
    // Alphas 0.006 (hidden by the viewer) and 0.014 (visible) round to the
    // same colour key, but their MASK cutoffs differ (1.0 vs 0.004 * 0.014):
    // a shared material would show one mesh wrongly or hide the other (#8120).
    let Some(bytes) = annex_e("tessellation-with-blob-texture.ifc") else { return };
    let mut result = meshes(&bytes);
    let source = result.meshes.iter().find(|m| m.texture.is_some()).unwrap().clone();
    let mut second = source.clone();
    second.express_id = source.express_id + 1_000_000;
    second.color[3] = 0.006;
    let textured = result.meshes.iter().position(|m| m.texture.is_some()).unwrap();
    result.meshes[textured].color[3] = 0.014;
    result.meshes.push(second);
    let (json, bin) = parse_glb(&try_export_glb_from_result(result, &textured_opts()).unwrap().0);
    let mut cutoffs: Vec<f64> = textured_primitives(&json, &bin)
        .into_iter()
        .map(|(_, _, _, material, _)| material["alphaCutoff"].as_f64().unwrap())
        .collect();
    cutoffs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    cutoffs.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    assert_eq!(cutoffs.len(), 2, "two materials, one per side of the hide threshold: {cutoffs:?}");
    assert!((cutoffs[0] - 0.004 * 0.014).abs() <= 1e-7 && (cutoffs[1] - 1.0).abs() <= 1e-9, "{cutoffs:?}");
}

#[test]
fn issue_7955_j5_review3_distinct_embedded_images_start_on_four_byte_boundaries() {
    // Find an actual encoded PNG with an odd length; PNG size depends on the
    // compressor, so a fixed RGBA sample would be a brittle reproducer.
    let first = (0..=255)
        .map(|v| vec![v, 17, 31, 255])
        .find(|rgba| !texture::encode_png(rgba, 1, 1).unwrap().len().is_multiple_of(4))
        .expect("a one-pixel PNG with non-four-byte length");
    let textures = [
        MeshTextureData { texture_id: 1, rgba: Some(Arc::new(first)), width: 1, height: 1, url: None, repeat_s: true, repeat_t: true },
        MeshTextureData { texture_id: 2, rgba: Some(Arc::new(vec![5, 7, 11, 255])), width: 1, height: 1, url: None, repeat_s: true, repeat_t: true },
    ];
    let uvs = [0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
    let mut table = TextureTable::prepare(textures.iter().enumerate().map(|(i, t)| {
        (i as u32 + 1, 9, ViewTexture { uvs: &uvs, texture: t })
    })).unwrap();
    let mut ch = Chunker::new(12, usize::MAX, None);
    ch.flush();
    table.embed_images(&mut ch);
    assert_eq!(ch.buffer_views.len(), 2);
    for view in &ch.buffer_views {
        assert_eq!(view.byte_offset % 4, 0, "embedded image starts aligned");
    }
    let first_len = ch.buffer_views[0].byte_length as usize;
    assert_ne!(first_len % 4, 0, "the first PNG exercises inter-image padding");
    let second_offset = ch.buffer_views[1].byte_offset as usize;
    assert_eq!(second_offset, first_len.next_multiple_of(4));
    assert!(ch.img[first_len..second_offset].iter().all(|&b| b == 0));
    assert_eq!(ch.buffer_views[1].byte_length as usize, ch.img.len() - second_offset);
}

#[test]
fn issue_7955_j5_review3_two_texture_glb_keeps_png_views_separate() {
    let Some(bytes) = annex_e("tessellation-with-blob-texture.ifc") else { return };
    let first_rgba = (0..=255)
        .map(|v| vec![v, 17, 31, 255])
        .find(|rgba| !texture::encode_png(rgba, 1, 1).unwrap().len().is_multiple_of(4))
        .unwrap();
    let mut result = meshes(&bytes);
    let mut first = result.meshes.iter().find(|m| m.texture.is_some()).unwrap().clone();
    let mut second = first.clone();
    first.texture.as_mut().unwrap().rgba = Some(Arc::new(first_rgba.clone()));
    first.texture.as_mut().unwrap().width = 1;
    first.texture.as_mut().unwrap().height = 1;
    second.express_id += 10_000;
    second.texture.as_mut().unwrap().texture_id += 10_000;
    second.texture.as_mut().unwrap().rgba = Some(Arc::new(vec![5, 7, 11, 255]));
    second.texture.as_mut().unwrap().width = 1;
    second.texture.as_mut().unwrap().height = 1;
    result.meshes = vec![first, second];
    let (json, bin) = parse_glb(&try_export_glb_from_result(result, &textured_opts()).unwrap().0);
    let images = json["images"].as_array().unwrap();
    assert_eq!(images.len(), 2);
    for (image, rgba) in images.iter().zip([first_rgba, vec![5, 7, 11, 255]]) {
        let view = &json["bufferViews"][image["bufferView"].as_u64().unwrap() as usize];
        assert_eq!(view["byteOffset"].as_u64().unwrap() % 4, 0);
        assert_eq!(decode_embedded_png(&json, &bin, image), (rgba, 1, 1));
    }
    let first_view = &json["bufferViews"][images[0]["bufferView"].as_u64().unwrap() as usize];
    assert_ne!(first_view["byteLength"].as_u64().unwrap() % 4, 0);
}

#[test]
fn issue_7955_j5_review3_decoded_pixels_take_precedence_over_relative_url() {
    let Some(bytes) = annex_e("tessellation-with-blob-texture.ifc") else { return };
    let mut result = meshes(&bytes);
    let mesh = result.meshes.iter_mut().find(|m| m.texture.is_some()).unwrap();
    let expected = mesh.texture.as_ref().unwrap().clone();
    mesh.texture.as_mut().unwrap().url = Some("textures/unused.png".into());
    let (json, bin) = parse_glb(&try_export_glb_from_result(result, &textured_opts()).unwrap().0);
    let image = &json["images"][0];
    assert!(image.get("uri").is_none());
    let (rgba, width, height) = decode_embedded_png(&json, &bin, image);
    assert_eq!((width, height), (expected.width, expected.height));
    assert_eq!(rgba, **expected.rgba.as_ref().unwrap());
}
