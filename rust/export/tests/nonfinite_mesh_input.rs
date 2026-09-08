// SPDX-License-Identifier: MPL-2.0
//! Non-finite coordinates must never reach an exported mesh file.
//!
//! The three from-meshes exporters (`export_glb_from_meshes`,
//! `export_collada_from_meshes`, and `export_kmz_collada_from_meshes` through it)
//! take the viewer's flattened `MeshData` arrays straight off the wasm FFI. Nothing
//! between a plugin-supplied mesh and the bytes checked that a coordinate was finite,
//! and every one of the three failure modes below was observed on `main`:
//!
//! * glTF JSON has no lexical form for a non-finite number — `serde_json` maps one to
//!   `null`, and an accessor `min`/`max` of `[null,-0.5,0.0]` violates the glTF 2.0
//!   schema (the items are `number`).
//! * A `NaN` position slipped into the BIN chunk while `min`/`max` stayed finite,
//!   because `NaN < min` and `NaN > max` are both false — a bounding box that lies
//!   about its own buffer.
//! * COLLADA re-centres on the mesh AABB, so ONE non-finite vertex turned every OTHER
//!   vertex in the whole document into `inf`/`NaN`. One bad vertex, no surviving
//!   geometry.
//!
//! `NaN`, `+Infinity` and `-Infinity` are asserted separately: they did not behave
//! alike (`NaN` left `min`/`max` finite, the infinities produced `null`).

use ifc_lite_export::{export_collada_from_meshes, export_glb_from_meshes};

/// One triangle whose FIRST vertex's X is `poison`; the other two are finite and
/// must survive unchanged.
fn tri(poison: f32) -> (Vec<f32>, Vec<f32>, Vec<u32>) {
    let positions = vec![poison, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let normals = vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
    (positions, normals, vec![0u32, 1, 2])
}

fn glb_parts(poison: f32) -> (String, Vec<f32>) {
    let (p, n, i) = tri(poison);
    let (glb, stats) = export_glb_from_meshes(
        &p,
        &n,
        &i,
        &[3],
        &[3],
        &[0.8, 0.8, 0.8, 1.0],
        &[0.0, 0.0, 0.0],
        &[42],
        false,
        true,
        false,
    );
    // Anti-vacuity: the mesh must actually have been emitted, not silently dropped.
    assert_eq!(stats.meshes, 1, "expected exactly one emitted mesh");
    assert_eq!(stats.vertices, 3, "expected three emitted vertices");

    let jlen = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
    let json = String::from_utf8_lossy(&glb[20..20 + jlen]).to_string();
    let bstart = 20 + jlen;
    let blen = u32::from_le_bytes(glb[bstart..bstart + 4].try_into().unwrap()) as usize;
    let bin = &glb[bstart + 8..bstart + 8 + blen];
    let floats: Vec<f32> = bin
        .chunks_exact(4)
        .take(9) // the three POSITION vec3s
        .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
        .collect();
    (json, floats)
}

fn collada_positions(poison: f32) -> String {
    let (p, n, i) = tri(poison);
    let dae = export_collada_from_meshes(
        &p,
        &n,
        &i,
        &[3],
        &[3],
        &[0.8, 0.8, 0.8, 1.0],
        &[0.0, 0.0, 0.0],
    );
    let dae = String::from_utf8_lossy(&dae).to_string();
    let line = dae
        .lines()
        .find(|l| l.contains("float_array") && l.contains("pos-arr"))
        .unwrap_or_else(|| panic!("no position float_array in COLLADA output"))
        .trim()
        .to_string();
    // Anti-vacuity: the positions really are in there.
    assert!(line.contains("count=\"9\""), "expected 9 position floats: {line}");
    line
}

#[test]
fn glb_json_never_carries_a_null_bound() {
    for (label, poison) in
        [("NaN", f32::NAN), ("+Inf", f32::INFINITY), ("-Inf", f32::NEG_INFINITY)]
    {
        let (json, _) = glb_parts(poison);
        assert!(
            !json.contains("null"),
            "[{label}] glTF JSON carries a `null` where a number belongs: {json}"
        );
    }
}

#[test]
fn glb_bin_chunk_is_all_finite() {
    for (label, poison) in
        [("NaN", f32::NAN), ("+Inf", f32::INFINITY), ("-Inf", f32::NEG_INFINITY)]
    {
        let (_, floats) = glb_parts(poison);
        assert!(
            floats.iter().all(|f| f.is_finite()),
            "[{label}] GLB BIN chunk holds a non-finite position: {floats:?}"
        );
    }
}

#[test]
fn one_bad_vertex_does_not_poison_the_others_in_glb() {
    // The two good vertices are 1 apart in X and in Y. Whatever the scrub does with
    // the poisoned component, the surviving geometry must keep its shape.
    let (_, baseline) = glb_parts(0.0);
    for (label, poison) in
        [("NaN", f32::NAN), ("+Inf", f32::INFINITY), ("-Inf", f32::NEG_INFINITY)]
    {
        let (_, floats) = glb_parts(poison);
        assert_eq!(
            floats, baseline,
            "[{label}] a non-finite vertex changed the OTHER vertices: {floats:?}"
        );
    }
}

#[test]
fn collada_never_writes_a_nan_or_inf_token() {
    for (label, poison) in
        [("NaN", f32::NAN), ("+Inf", f32::INFINITY), ("-Inf", f32::NEG_INFINITY)]
    {
        let line = collada_positions(poison);
        for bad in ["NaN", "nan", "inf", "INF"] {
            assert!(
                !line.contains(bad),
                "[{label}] COLLADA position array carries `{bad}`: {line}"
            );
        }
    }
}

#[test]
fn one_bad_vertex_does_not_poison_the_others_in_collada() {
    let baseline = collada_positions(0.0);
    for (label, poison) in
        [("NaN", f32::NAN), ("+Inf", f32::INFINITY), ("-Inf", f32::NEG_INFINITY)]
    {
        assert_eq!(
            collada_positions(poison),
            baseline,
            "[{label}] a non-finite vertex changed the OTHER vertices in COLLADA"
        );
    }
}

/// Both directions: an all-finite mesh must still round-trip its exact coordinates.
/// A guard that zeroed everything would pass every assertion above.
#[test]
fn finite_meshes_are_untouched() {
    let positions = vec![-2.0f32, 0.0, 0.0, 3.0, 0.0, 0.0, 0.0, 4.5, 0.0];
    let normals = vec![0.0f32, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
    let indices = vec![0u32, 1, 2];
    let (glb, stats) = export_glb_from_meshes(
        &positions,
        &normals,
        &indices,
        &[3],
        &[3],
        &[0.25, 0.5, 0.75, 1.0],
        &[10.0, 20.0, 30.0],
        &[7],
        false,
        true,
        false,
    );
    assert_eq!(stats.vertices, 3);
    let jlen = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
    let json = String::from_utf8_lossy(&glb[20..20 + jlen]).to_string();
    // The exporter re-centres on the scene bbox, so assert the SPAN, which centring
    // preserves: X runs from -2 to 3 (5 wide), Y from 0 to 4.5.
    let bstart = 20 + jlen;
    let blen = u32::from_le_bytes(glb[bstart..bstart + 4].try_into().unwrap()) as usize;
    let bin = &glb[bstart + 8..bstart + 8 + blen];
    let f: Vec<f32> = bin
        .chunks_exact(4)
        .take(9)
        .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
        .collect();
    assert!((f[3] - f[0] - 5.0).abs() < 1e-5, "X span lost: {f:?}");
    assert!(f.iter().all(|v| v.is_finite()), "finite input went non-finite: {f:?}");
    assert!(
        json.contains("\"min\"") && json.contains("\"max\""),
        "accessor bounds missing: {json}"
    );
    assert!(!json.contains("null"), "finite input produced a null: {json}");

    let dae = export_collada_from_meshes(
        &positions,
        &normals,
        &indices,
        &[3],
        &[3],
        &[0.25, 0.5, 0.75, 1.0],
        &[10.0, 20.0, 30.0],
    );
    let dae = String::from_utf8_lossy(&dae).to_string();
    let line = dae
        .lines()
        .find(|l| l.contains("float_array") && l.contains("pos-arr"))
        .expect("position float_array")
        .to_string();
    // Centred about the AABB midpoint, so the extremes are ±half-span, exactly.
    assert!(line.contains("-2.5"), "expected the -2.5 X extreme: {line}");
    assert!(line.contains("2.5"), "expected the 2.5 X extreme: {line}");
}

/// A non-finite colour component would serialise as `null` in `baseColorFactor`,
/// which is as invalid as a `null` bound. Alpha must not be scrubbed to 0 — that
/// would turn a colour defect into an invisible mesh.
#[test]
fn nonfinite_colours_do_not_reach_the_material() {
    for poison in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let (p, n, i) = tri(0.0);
        let (glb, _) = export_glb_from_meshes(
            &p,
            &n,
            &i,
            &[3],
            &[3],
            &[poison, 0.5, 0.5, poison],
            &[0.0, 0.0, 0.0],
            &[1],
            false,
            true,
            false,
        );
        let jlen = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
        let json = String::from_utf8_lossy(&glb[20..20 + jlen]).to_string();
        assert!(!json.contains("null"), "non-finite colour reached the JSON: {json}");
        assert!(
            json.contains("\"baseColorFactor\""),
            "anti-vacuity: no material emitted: {json}"
        );
        assert!(
            !json.contains("baseColorFactor\":[0.0,0.5,0.5,0.0]")
                && !json.contains("baseColorFactor\":[0,0.5,0.5,0]"),
            "alpha was scrubbed to 0, hiding the mesh: {json}"
        );
    }
}

/// A non-finite per-mesh `origin` (f64) is folded into every vertex of that mesh,
/// so it poisons the mesh exactly like a bad position does.
#[test]
fn nonfinite_origin_does_not_reach_the_bytes() {
    for poison in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let (p, n, i) = tri(0.0);
        let (glb, stats) = export_glb_from_meshes(
            &p,
            &n,
            &i,
            &[3],
            &[3],
            &[0.8, 0.8, 0.8, 1.0],
            &[poison, 0.0, 0.0],
            &[1],
            false,
            true,
            false,
        );
        assert_eq!(stats.vertices, 3, "anti-vacuity: mesh dropped");
        let jlen = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
        let json = String::from_utf8_lossy(&glb[20..20 + jlen]).to_string();
        assert!(!json.contains("null"), "non-finite origin reached the JSON: {json}");
        let bstart = 20 + jlen;
        let blen = u32::from_le_bytes(glb[bstart..bstart + 4].try_into().unwrap()) as usize;
        let bin = &glb[bstart + 8..bstart + 8 + blen];
        let f: Vec<f32> = bin
            .chunks_exact(4)
            .take(9)
            .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
            .collect();
        assert!(f.iter().all(|v| v.is_finite()), "non-finite origin reached BIN: {f:?}");
    }
}
