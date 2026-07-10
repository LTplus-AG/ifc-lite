// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #961 — IFC surface textures (IfcBlobTexture PNG / IfcPixelTexture raw)
//! are decoded to RGBA8 in Rust and attached to the mesh with per-vertex UVs,
//! 1:1 with positions. buildingSMART annex-E "tessellated shape with style"
//! fixtures (a textured boiler on an IfcBoilerType, no occurrence).
//!
//! Fixtures are downloaded via `pnpm fixtures`; the test skips when absent so
//! it never fails environmentally (CI provides them).

use ifc_lite_processing::process_geometry;
use std::path::PathBuf;

const BOILER_TYPE_ID: u32 = 43;

fn fixture(name: &str) -> Option<String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/models/buildingsmart/annex_e/tessellated-shape-with-style")
        .join(name);
    std::fs::read_to_string(path).ok()
}

#[test]
fn blob_texture_decodes_to_rgba_with_uvs() {
    let Some(content) = fixture("tessellation-with-blob-texture.ifc") else {
        eprintln!("skipping: fixture missing — run `pnpm fixtures`");
        return;
    };
    let result = process_geometry(&content);
    let mesh = result
        .meshes
        .iter()
        .find(|m| m.express_id == BOILER_TYPE_ID)
        .expect("boiler type #43 should render");

    let texture = mesh.texture.as_ref().expect("blob texture should decode");
    assert!(texture.width > 0 && texture.height > 0, "decoded image has size");
    assert_eq!(
        texture.rgba.len(),
        (texture.width as usize) * (texture.height as usize) * 4,
        "RGBA8 buffer is width*height*4"
    );

    let uvs = mesh.uvs.as_ref().expect("textured mesh carries UVs");
    assert_eq!(
        uvs.len(),
        (mesh.positions.len() / 3) * 2,
        "UVs are 2 floats per vertex, 1:1 with positions"
    );
    // The boiler mesh is welded at the source (`build_mesh_data`): coincident
    // vertices sharing position + normal + UV are collapsed, so the vertex count
    // is no longer the raw `triangles * 3` triangle-soup — the UV seam and the
    // per-face normals keep the necessary splits. Triangles stay intact and the
    // UVs remain 1:1 with positions (checked above).
    let verts = mesh.positions.len() / 3;
    assert!(verts >= 3, "non-empty welded vertex buffer, got {verts}");
    assert_eq!(mesh.indices.len() % 3, 0, "index buffer is whole triangles");
    // UVs use the authored IfcTextureVertexList coordinates directly (the
    // IfcSurfaceTexture.TextureTransform scale is NOT applied — it over-tiles
    // vs the buildingSMART reference). The authored coords map the image ~1:1,
    // so they stay in a sane ~[0,1] range, not the ×48 noise of the raw scale.
    let max_u = uvs.iter().step_by(2).cloned().fold(f32::MIN, f32::max);
    assert!(max_u <= 1.5, "UVs should map ~1:1 (authored coords), got max u = {max_u}");
}

#[test]
fn pixel_texture_decodes_known_pixels() {
    let Some(content) = fixture("tessellation-with-pixel-texture.ifc") else {
        eprintln!("skipping: fixture missing — run `pnpm fixtures`");
        return;
    };
    let result = process_geometry(&content);
    let mesh = result
        .meshes
        .iter()
        .find(|m| m.express_id == BOILER_TYPE_ID)
        .expect("boiler type #43 should render");

    let texture = mesh.texture.as_ref().expect("pixel texture should decode");
    assert_eq!(texture.width, 256, "pixel texture width");
    assert_eq!(texture.height, 256, "pixel texture height");
    assert_eq!(texture.rgba.len(), 256 * 256 * 4, "RGBA8 256x256");
    // First authored pixel is opaque black ("0000000FF" → 00 00 00 FF).
    assert_eq!(
        &texture.rgba[0..4],
        &[0, 0, 0, 255],
        "first pixel is opaque black"
    );
    assert!(mesh.uvs.is_some(), "textured mesh carries UVs");
}
