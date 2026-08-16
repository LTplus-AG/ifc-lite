// SPDX-License-Identifier: MPL-2.0
//! Unit tests for the COLLADA (`.dae`) exporter in `collada.rs`. Split out per the
//! repo convention for modules whose bulk is test code (see `frame.rs` /
//! `frame_tests.rs`).

use super::*;

/// `(positions, normals, indices, vertex_counts, index_counts, colors, origins)`.
type MeshArrays = (Vec<f32>, Vec<f32>, Vec<u32>, Vec<u32>, Vec<u32>, Vec<f32>, Vec<f64>);

fn one_quad() -> MeshArrays {
    // A unit quad in the XY plane (Y-up input), single red mesh.
    let positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0, 1.0];
    let normals: Vec<f32> = std::iter::repeat_n([0.0f32, 1.0, 0.0], 4).flatten().collect();
    let indices = vec![0u32, 1, 2, 0, 2, 3];
    (positions, normals, indices, vec![4], vec![6], vec![1.0, 0.0, 0.0, 1.0], vec![0.0, 0.0, 0.0])
}

#[test]
fn emits_valid_collada_skeleton() {
    let (p, n, i, vc, ic, col, og) = one_quad();
    let dae = export_collada_from_meshes(&p, &n, &i, &vc, &ic, &col, &og);
    let xml = String::from_utf8(dae).unwrap();
    assert!(xml.contains(r#"version="1.4.1""#));
    assert!(xml.contains("<up_axis>Z_UP</up_axis>"));
    assert!(xml.contains("<unit name=\"meter\" meter=\"1\"/>"));
    assert!(xml.contains("<instance_visual_scene url=\"#scene\"/>"));
    // The shared geometry + a triangles block bound to the material.
    assert!(xml.contains("<triangles material=\"sym0\""));
    assert!(xml.contains("<instance_material symbol=\"sym0\" target=\"#mat0\"/>"));
}

#[test]
fn emission_carries_colour_and_double_sided() {
    let (p, n, i, vc, ic, col, og) = one_quad();
    let xml = String::from_utf8(export_collada_from_meshes(&p, &n, &i, &vc, &ic, &col, &og)).unwrap();
    // Red emission = brightness lever for Google Earth.
    assert!(xml.contains("<emission><color>1 0 0 1</color></emission>"));
    assert!(xml.contains("<double_sided>1</double_sided>"));
    assert!(xml.contains("profile=\"GOOGLEEARTH\""));
}

/// Parse every `<float_array id="geoN-pos-arr">` (one per chunk) into vertices.
fn parse_positions(xml: &str) -> Vec<[f32; 3]> {
    let mut out: Vec<f32> = Vec::new();
    let mut rest = xml;
    while let Some(at) = rest.find("<float_array") {
        let s = &rest[at..];
        let tag_end = s.find('>').unwrap();
        let close = s.find("</float_array>").unwrap();
        if s[..tag_end].contains("-pos-arr") {
            out.extend(s[tag_end + 1..close].split_whitespace().map(|t| t.parse::<f32>().unwrap()));
        }
        rest = &s[close + "</float_array>".len()..];
    }
    out.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect()
}

/// The largest `<float_array>` text node, in bytes — the value strict XML
/// parsers cap (libxml2 / Google Earth at ~10 MB).
fn max_float_array_bytes(xml: &str) -> usize {
    let mut max = 0;
    let mut rest = xml;
    while let Some(at) = rest.find("<float_array") {
        let s = &rest[at..];
        let open = s.find('>').unwrap() + 1;
        let close = s.find("</float_array>").unwrap();
        max = max.max(close - open);
        rest = &s[close..];
    }
    max
}

fn hbounds(verts: &[[f32; 3]]) -> (f32, f32) {
    let (mut mnx, mut mxx, mut mny, mut mxy) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
    for v in verts {
        mnx = mnx.min(v[0]);
        mxx = mxx.max(v[0]);
        mny = mny.min(v[1]);
        mxy = mxy.max(v[1]);
    }
    ((mnx + mxx) / 2.0, (mny + mxy) / 2.0) // (X centre, Y centre)
}

#[test]
fn converts_yup_to_zup_and_centers() {
    // Y-up input vertex (0,1,0) ("up") must land at Z-up Z=1 (up preserved), and the
    // geometry is centred on its horizontal AABB so the .dae origin == geometry centre.
    let positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let normals: Vec<f32> = std::iter::repeat_n([0.0f32, 0.0, 1.0], 3).flatten().collect();
    let xml = String::from_utf8(export_collada_from_meshes(
        &positions, &normals, &[0, 1, 2], &[3], &[3], &[0.5, 0.5, 0.5, 1.0], &[0.0, 0.0, 0.0],
    ))
    .unwrap();
    let verts = parse_positions(&xml);
    assert!(verts.iter().any(|v| (v[2] - 1.0).abs() < 1e-4), "Y-up (0,1,0) -> Z-up Z=1");
    let (cx, cy) = hbounds(&verts);
    assert!(cx.abs() < 1e-4 && cy.abs() < 1e-4, "geometry centred: ({cx}, {cy})");
}

#[test]
fn centers_geometry_far_from_origin() {
    // A model whose geometry sits ~100-200 m from the local/survey origin must be
    // re-centred so the .dae origin == geometry centre — the point the KMZ <Location>
    // is computed for. This is the CH1903+/LV95 ~250 m offset fix (#1427).
    let positions = vec![
        100.0, 0.0, 200.0, 110.0, 0.0, 200.0, 110.0, 0.0, 220.0, 100.0, 0.0, 220.0,
    ];
    let normals: Vec<f32> = std::iter::repeat_n([0.0f32, 1.0, 0.0], 4).flatten().collect();
    let xml = String::from_utf8(export_collada_from_meshes(
        &positions, &normals, &[0, 1, 2, 0, 2, 3], &[4], &[6], &[0.6, 0.6, 0.6, 1.0], &[0.0, 0.0, 0.0],
    ))
    .unwrap();
    let (cx, cy) = hbounds(&parse_positions(&xml));
    assert!(cx.abs() < 1e-3, "X re-centred to ~0 (geometry was ~105 from origin): {cx}");
    assert!(cy.abs() < 1e-3, "Y re-centred to ~0 (geometry was ~210 from origin): {cy}");
}

#[test]
fn deduplicates_shared_vertices() {
    // A quad supplied NON-indexed as two triangles (6 vertices: a,b,c and a,c,d)
    // collapses to 4 unique — a and c are shared with identical position+normal.
    // This is the lever that shrinks per-face IFC meshes under Google Earth's
    // vertex/triangle limits (#1427).
    let (a, b, c, d) = ([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 0.0, 1.0], [0.0, 0.0, 1.0]);
    let mut positions = vec![];
    for v in [a, b, c, a, c, d] {
        positions.extend_from_slice(&v);
    }
    let normals: Vec<f32> = std::iter::repeat_n([0.0f32, 1.0, 0.0], 6).flatten().collect();
    let indices: Vec<u32> = (0..6).collect();
    let xml = String::from_utf8(export_collada_from_meshes(
        &positions, &normals, &indices, &[6], &[6], &[0.5, 0.5, 0.5, 1.0], &[0.0, 0.0, 0.0],
    ))
    .unwrap();
    assert_eq!(parse_positions(&xml).len(), 4, "6 input verts dedupe to 4 unique");
}

#[test]
fn large_model_is_chunked_into_small_text_nodes() {
    // >MAX_VERTS unique vertices must split into multiple <geometry> chunks so no
    // single <float_array> is a huge XML text node. Strict XML parsers (libxml2 and
    // Google Earth) reject a text node over ~10 MB, which made large models load but
    // render INVISIBLE (#1427). One 25k-triangle / 75k-vertex mesh exceeds the 60k
    // per-chunk cap and must produce ≥2 geometries, all parser-safe.
    let vcount = 75_000usize; // > MAX_VERTS (60k)
    let mut positions = Vec::with_capacity(vcount * 3);
    let mut normals = Vec::with_capacity(vcount * 3);
    let mut indices = Vec::with_capacity(vcount);
    for i in 0..vcount {
        let f = i as f32 * 0.01;
        positions.extend_from_slice(&[f, 1.0, -f]);
        normals.extend_from_slice(&[0.0, 1.0, 0.0]);
        indices.push(i as u32);
    }
    let xml = String::from_utf8(export_collada_from_meshes(
        &positions, &normals, &indices, &[vcount as u32], &[vcount as u32],
        &[0.5, 0.5, 0.5, 1.0], &[0.0, 0.0, 0.0],
    ))
    .unwrap();
    assert!(xml.matches("<geometry ").count() >= 2, "geometry split into ≥2 chunks");
    // All vertices survive the split (75k in, 75k out across chunks).
    assert_eq!(parse_positions(&xml).len(), vcount, "no vertices dropped by chunking");
    assert!(
        max_float_array_bytes(&xml) < 5_000_000,
        "largest float_array stays small: {} bytes",
        max_float_array_bytes(&xml)
    );
    // Each <triangles count="N"> stays under Google Earth's 16-bit ceiling (21,845).
    let max_tri = xml
        .match_indices("<triangles ")
        .map(|(i, _)| {
            let tag = &xml[i..i + xml[i..].find('>').unwrap()];
            let c = tag.find("count=\"").unwrap() + 7;
            tag[c..tag[c..].find('"').unwrap() + c].parse::<usize>().unwrap()
        })
        .max()
        .unwrap();
    assert!(max_tri <= 21_845, "no <triangles> over the 16-bit ceiling: {max_tri}");
}

#[test]
fn triangles_count_matches_index_list_on_ragged_input() {
    // A malformed index count (not a multiple of 3) must not desync the emitted
    // <triangles count> from the <p> list — keep only whole triangles.
    let positions = vec![0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.5, 0.0, 0.5];
    let normals: Vec<f32> = std::iter::repeat_n([0.0f32, 1.0, 0.0], 4).flatten().collect();
    let indices = vec![0u32, 1, 2, 0, 2]; // 5 indices = one whole triangle + a stray pair
    let xml = String::from_utf8(export_collada_from_meshes(
        &positions, &normals, &indices, &[4], &[5], &[0.3, 0.3, 0.3, 1.0], &[0.0, 0.0, 0.0],
    ))
    .unwrap();
    // Exactly one triangle survives; its <p> holds 3 vertex+normal index pairs (6 ints).
    assert!(xml.contains("<triangles material=\"sym0\" count=\"1\">"));
    let p_start = xml.find("<p>").unwrap() + 3;
    let p = &xml[p_start..xml[p_start..].find("</p>").unwrap() + p_start];
    assert_eq!(p.split_whitespace().count(), 6, "one triangle = 3 pairs = 6 indices: {p}");
}

#[test]
fn translucent_material_emits_transparency() {
    let positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0];
    let normals: Vec<f32> = std::iter::repeat_n([0.0f32, 1.0, 0.0], 3).flatten().collect();
    let xml = String::from_utf8(export_collada_from_meshes(
        &positions, &normals, &[0, 1, 2], &[3], &[3], &[0.0, 1.0, 0.0, 0.5], &[0.0, 0.0, 0.0],
    ))
    .unwrap();
    assert!(xml.contains("<transparency>"));
    assert!(xml.contains("opaque=\"A_ONE\""));
}

// ── Composed KMZ orientation invariant (#2554 / PR #2628) ──────────────────────
//
// `kmz.rs::heading_matches_ifc_convention` and this file's own
// `converts_yup_to_zup_and_centers` each pin ONE half of the KMZ rotation
// pipeline in isolation: the IFC-grid-north → KML `<heading>` conversion, and
// the COLLADA Z-up<->Y-up up-axis swap. Both can be individually correct while
// the two halves disagree about what "north" means to each other — that
// disagreement is exactly what #2554 was: a model that rendered rotated in
// Google Earth even though the heading formula and the up-axis swap were each,
// on their own, defensible. This test composes both real code paths and checks
// the only thing a user actually sees: does the model come out pointing where
// the IFC file said it should.
//
// Geometry, independent of the implementation:
//   - `kmz.rs`'s own doc comment defines the baseline: at `heading = 0` the
//     model's local +X axis (Y-up mesh convention: `(1, 0, 0)`) already points
//     east, and Google Earth's `<heading>` then rotates the model CLOCKWISE
//     (viewed from above) by that many degrees, moving local +X to true
//     bearing `90 + heading` (mod 360).
//   - `IfcMapConversion`'s `(XAxisAbscissa, XAxisOrdinate)` encode a compass
//     bearing `B` (clockwise from true north) as the standard bearing->Cartesian
//     pair `(sin B, cos B)` — east and north components respectively.
//   - Composing the two, the recovered bearing of the exported model's local
//     +X axis must equal the original `B`, for every `B`.
#[test]
fn composed_orientation_reproduces_ifc_bearing() {
    // (bearing_deg, x_abscissa, x_ordinate) — bearing encoded as (sin B, cos B).
    let cases: [(f64, f64, f64); 3] = [
        // 30 deg: the reviewer's scratch case (heading = 300, (90+300) mod 360 = 30).
        (30.0, 30f64.to_radians().sin(), 30f64.to_radians().cos()),
        // 200 deg: a different quadrant (both axis components negative).
        (200.0, 200f64.to_radians().sin(), 200f64.to_radians().cos()),
        // Identity axis (1, 0): local X == grid X, no rotation encoded. This is the
        // case the original #2554 bug got wrong (a spurious rotation appeared even
        // though the IFC file encoded none).
        (90.0, 1.0, 0.0),
    ];

    for (bearing, x_abscissa, x_ordinate) in cases {
        // Half 1 (kmz.rs, real code path): IFC grid-north axis -> KML heading.
        let heading = crate::kmz::ifc_angle_to_kml_heading(Some(x_abscissa), Some(x_ordinate));

        // Half 2 (collada.rs, real code path): the mesh's local +X ("east" at
        // heading = 0, per kmz.rs's doc comment) converted from the Y-up mesh
        // frame the exporter receives into the Z-up frame the .dae declares.
        let zup = to_zup(1.0, 0.0, 0.0);

        // Compose: apply the KML heading as Google Earth does — a clockwise
        // rotation, about the vertical axis, of the Z-up model whose (X, Y)
        // plane is (east, north) at heading = 0. This is plain rotation
        // geometry, not code under test: it stands in for what Google Earth
        // itself does with the <heading> value at render time.
        let h = heading.to_radians();
        let east = zup[0] * h.cos() + zup[1] * h.sin();
        let north = -zup[0] * h.sin() + zup[1] * h.cos();
        let recovered_bearing = east.atan2(north).to_degrees().rem_euclid(360.0);

        assert!(
            (recovered_bearing - bearing).abs() < 1e-6,
            "bearing {bearing}: heading={heading} zup={zup:?} recovered={recovered_bearing}"
        );
    }
}
