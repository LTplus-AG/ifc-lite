// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! End-to-end fixture regression for #5582: `AC20-FZK-Haus.ifc` authors
//! `IfcSurfaceStyleRendering.SpecularColour` as a scalar
//! `IfcNormalisedRatioMeasure` on two named styles this file's own text
//! confirms verbatim — 'Glas' at 1.0 (`#22748`), 'Kiefer, glänzend' at 0.75
//! (`#17448`) — and this test proves `process_geometry` (the full native
//! pipeline: prepass -> `extract_surface_style_specular` ->
//! `GeometryStyleInfo.metallic_roughness` -> `build_mesh_data` ->
//! `MeshData.metallic`/`.roughness`) actually threads that through to real
//! mesh output, not just the unit-level extractor in `style/surface_tests.rs`.

use ifc_lite_processing::{process_geometry, MeshData};

const FIXTURE: &str = "tests/models/ara3d/AC20-FZK-Haus.ifc";

fn fixture_path(relative: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join(relative)
}

fn load_fixture() -> Option<String> {
    let path = fixture_path(FIXTURE);
    match std::fs::read_to_string(&path) {
        Ok(c) => Some(c),
        Err(_) => {
            eprintln!("{FIXTURE} missing — run `pnpm fixtures`. Skipping #5582 fixture test.");
            None
        }
    }
}

fn meshes_named<'a>(meshes: &'a [MeshData], name: &str) -> Vec<&'a MeshData> {
    meshes
        .iter()
        .filter(|m| m.material_name.as_deref() == Some(name))
        .collect()
}

/// 'Glas': `SpecularColour = IFCNORMALISEDRATIOMEASURE(1.)`, no
/// `SpecularHighlight`, `ReflectanceMethod = .NOTDEFINED.` -> a dielectric
/// (no metallic evidence) floored at the renderer's own glass roughness
/// (0.05): `roughness = 1 - 1.0`, clamped to the floor.
#[test]
fn glas_meshes_carry_floor_roughness_and_no_metal() {
    let Some(content) = load_fixture() else { return };
    let result = process_geometry(content.as_str());
    let glas = meshes_named(&result.meshes, "Glas");
    assert!(!glas.is_empty(), "expected at least one mesh styled 'Glas' in the fixture");
    for m in glas {
        assert_eq!(m.metallic, None, "Glas is a dielectric — no metal evidence (express_id {})", m.express_id);
        let roughness = m.roughness.unwrap_or_else(|| panic!("Glas mesh {} missing roughness", m.express_id));
        assert!((roughness - 0.05).abs() < 1e-6, "express_id {}: expected roughness ~0.05, got {roughness}", m.express_id);
    }
}

/// 'Kiefer, glänzend' (glossy pine): `SpecularColour =
/// IFCNORMALISEDRATIOMEASURE(0.75)` -> `roughness = 1 - 0.75 = 0.25`, and
/// still no metal evidence — a glossy dielectric varnish, not a conductor.
#[test]
fn kiefer_glaenzend_meshes_carry_moderate_roughness_and_no_metal() {
    let Some(content) = load_fixture() else { return };
    let result = process_geometry(content.as_str());
    let kiefer = meshes_named(&result.meshes, "Kiefer, gl\u{e4}nzend");
    assert!(!kiefer.is_empty(), "expected at least one mesh styled 'Kiefer, gl\u{e4}nzend' in the fixture");
    for m in kiefer {
        assert_eq!(m.metallic, None, "glossy pine is a dielectric — no metal evidence (express_id {})", m.express_id);
        let roughness = m.roughness.unwrap_or_else(|| panic!("Kiefer mesh {} missing roughness", m.express_id));
        assert!((roughness - 0.25).abs() < 1e-6, "express_id {}: expected roughness ~0.25, got {roughness}", m.express_id);
    }
}

/// The plain 'Kiefer' (unvarnished pine) style (`#17390`) authors a much
/// lower `SpecularColour` factor (0.1, vs 0.75 for its glossy twin above) —
/// `roughness = 1 - 0.1 = 0.9`, distinctly rougher than 'Kiefer, glänzend',
/// still with no metal evidence. Confirms the mapping tracks the FILE's own
/// factor per style rather than a single fixed value.
#[test]
fn plain_kiefer_meshes_are_rougher_than_their_glossy_twin() {
    let Some(content) = load_fixture() else { return };
    let result = process_geometry(content.as_str());
    let kiefer = meshes_named(&result.meshes, "Kiefer");
    assert!(!kiefer.is_empty(), "expected at least one mesh styled 'Kiefer' in the fixture");
    for m in kiefer {
        assert_eq!(m.metallic, None, "express_id {}", m.express_id);
        let roughness = m.roughness.unwrap_or_else(|| panic!("Kiefer mesh {} missing roughness", m.express_id));
        assert!((roughness - 0.9).abs() < 1e-6, "express_id {}: expected roughness ~0.9, got {roughness}", m.express_id);
    }
}
