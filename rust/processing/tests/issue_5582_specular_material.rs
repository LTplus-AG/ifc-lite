// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! End-to-end fixture regression for #5582: `AC20-FZK-Haus.ifc` authors
//! `IfcSurfaceStyleRendering.SpecularColour` as a scalar
//! `IfcNormalisedRatioMeasure` on two named styles this file's own text
//! confirms verbatim — 'Glas' at 1.0 (`#22748`), 'Kiefer, glänzend' at 0.75
//! (`#17448`) — and this test proves the finish reaches real mesh output the
//! way the browser batch path joins it: [`resolve_geometry_finishes`] over the
//! file's styled items, looked up by each mesh's `geometry_item_id`, the same
//! key the colour index (`GeometryStyleInfo`) uses. Not just the unit-level
//! extractor in `style/surface_tests.rs`.

use ifc_lite_core::EntityScanner;
use ifc_lite_processing::prepass::{resolve_geometry_finishes, PrepassSpans};
use ifc_lite_processing::style::SpecularMaterial;
use ifc_lite_processing::{process_geometry, MeshData};
use rustc_hash::FxHashMap;

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

/// The finish index the WASM prepass ships as `styleFinishes`.
fn geometry_finishes(content: &str) -> FxHashMap<u32, SpecularMaterial> {
    let mut spans = PrepassSpans::default();
    let mut scanner = EntityScanner::new(content.as_bytes());
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        spans.stash(type_name, id, start, end);
    }
    let mut decoder = ifc_lite_core::EntityDecoder::new(content.as_bytes());
    resolve_geometry_finishes(&spans.styled_items, &mut decoder)
}

/// A mesh's finish, joined exactly as the browser batch path joins it.
fn finish_of(m: &MeshData, finishes: &FxHashMap<u32, SpecularMaterial>) -> SpecularMaterial {
    let item = m.geometry_item_id.unwrap_or_else(|| panic!("mesh {} has no geometry_item_id to join on", m.express_id));
    finishes.get(&item).copied().unwrap_or_else(|| panic!("no finish claimed for item #{item} (mesh {})", m.express_id))
}

fn meshes_named<'a>(meshes: &'a [MeshData], name: &str) -> Vec<&'a MeshData> {
    meshes
        .iter()
        .filter(|m| m.material_name.as_deref() == Some(name))
        .collect()
}

/// 'Glas': `SpecularColour = IFCNORMALISEDRATIOMEASURE(1.)`, no
/// `SpecularHighlight`, `ReflectanceMethod = .NOTDEFINED.` -> a dielectric
/// (no metallic evidence) with roughness AS AUTHORED: `roughness = 1 - 1.0 =
/// 0.0`. Rust does not floor this — the renderer's shader owns the single
/// `MIN_SPECULAR_ROUGHNESS` clamp (review of #5582).
#[test]
fn glas_meshes_carry_zero_roughness_and_no_metal() {
    let Some(content) = load_fixture() else { return };
    let result = process_geometry(content.as_str());
    let finishes = geometry_finishes(&content);
    let glas = meshes_named(&result.meshes, "Glas");
    assert!(!glas.is_empty(), "expected at least one mesh styled 'Glas' in the fixture");
    for m in glas {
        let f = finish_of(m, &finishes);
        assert_eq!(f.metallic, None, "Glas is a dielectric — no metal evidence (express_id {})", m.express_id);
        let roughness = f.roughness.unwrap_or_else(|| panic!("Glas mesh {} missing roughness", m.express_id));
        assert!(roughness.abs() < 1e-6, "express_id {}: expected roughness ~0.0 as authored, got {roughness}", m.express_id);
    }
}

/// 'Kiefer, glänzend' (glossy pine): `SpecularColour =
/// IFCNORMALISEDRATIOMEASURE(0.75)` -> `roughness = 1 - 0.75 = 0.25`, and
/// still no metal evidence — a glossy dielectric varnish, not a conductor.
#[test]
fn kiefer_glaenzend_meshes_carry_moderate_roughness_and_no_metal() {
    let Some(content) = load_fixture() else { return };
    let result = process_geometry(content.as_str());
    let finishes = geometry_finishes(&content);
    let kiefer = meshes_named(&result.meshes, "Kiefer, gl\u{e4}nzend");
    assert!(!kiefer.is_empty(), "expected at least one mesh styled 'Kiefer, gl\u{e4}nzend' in the fixture");
    for m in kiefer {
        let f = finish_of(m, &finishes);
        assert_eq!(f.metallic, None, "glossy pine is a dielectric — no metal evidence (express_id {})", m.express_id);
        let roughness = f.roughness.unwrap_or_else(|| panic!("Kiefer mesh {} missing roughness", m.express_id));
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
    let finishes = geometry_finishes(&content);
    let kiefer = meshes_named(&result.meshes, "Kiefer");
    assert!(!kiefer.is_empty(), "expected at least one mesh styled 'Kiefer' in the fixture");
    for m in kiefer {
        let f = finish_of(m, &finishes);
        assert_eq!(f.metallic, None, "express_id {}", m.express_id);
        let roughness = f.roughness.unwrap_or_else(|| panic!("Kiefer mesh {} missing roughness", m.express_id));
        assert!((roughness - 0.9).abs() < 1e-6, "express_id {}: expected roughness ~0.9, got {roughness}", m.express_id);
    }
}
