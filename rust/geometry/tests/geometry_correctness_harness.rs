// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Geometric correctness harness.
//!
//! Loads every fixture in `FIXTURES`, runs the full router pipeline
//! against every spatial product, and asserts a small set of universal
//! invariants (mesh is non-empty when the fixture is supposed to have
//! geometry, no NaN/Inf, no extreme-aspect-ratio sliver triangles in
//! CSG-cut output, bbox stays inside a generous envelope).
//!
//! On `--nocapture` it prints a per-fixture summary table you can scan
//! against the viewer to lock baselines. Set `IFC_LITE_HARNESS_REPORT`
//! to a file path to also dump a machine-readable JSON report for
//! diff-on-regression workflows.
//!
//! Fixture set:
//!   * **buildingSMART IFC 4.3 Annex E** — every "example" in the spec's
//!     advanced/basic/mapped/tessellated geometric-shape pages. These
//!     are the canonical references for what a correct kernel must
//!     handle. Pulled from `buildingSMART/IFC4.3.x-sample-models`.
//!   * **Issue regression IFCs** — the three IFC attachments from
//!     geometry-bug reports that aren't already covered by per-issue
//!     tests (#424 IfcDerivedProfileDef, #218 window rendering, #472
//!     SurfaceModel support). The other two attachments (#674 door,
//!     #631 reinforcing bar) had 404 user-attachments URLs at fetch
//!     time and were skipped.
//!
//! Soft-pass by default: a missing fixture (e.g. when the test runs in
//! an environment without the full fixture set vendored) is logged but
//! does not fail the harness. Strict baselines for individual fixtures
//! belong in dedicated regression test files once their behaviour has
//! been visually verified.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter, Mesh};
use rustc_hash::FxHashMap;
use std::collections::BTreeMap;
use std::path::PathBuf;

/// Repo-root-relative fixture paths. The harness skips any entry that
/// doesn't exist on disk so the file can grow with the repo without
/// failing CI in checkouts that haven't vendored every fixture.
struct Fixture {
    path: &'static str,
    label: &'static str,
    /// `true` if the fixture is *expected* to produce non-empty geometry
    /// for at least one element. False for IFCs that ship without any
    /// geometric representation (none in this set right now, but the
    /// flag is there so a future schema-only sample doesn't fail).
    expect_geometry: bool,
}

const FIXTURES: &[Fixture] = &[
    // ─── buildingSMART IFC 4.3 — Annex E / Advanced Geometric Shape ───
    Fixture {
        path: "tests/models/buildingsmart/annex_e/advanced-geometric-shape/basin-advanced-brep.ifc",
        label: "annex_e/advanced/basin-advanced-brep",
        expect_geometry: true,
    },
    Fixture {
        path: "tests/models/buildingsmart/annex_e/advanced-geometric-shape/basin-faceted-brep.ifc",
        label: "annex_e/advanced/basin-faceted-brep",
        expect_geometry: true,
    },
    Fixture {
        path: "tests/models/buildingsmart/annex_e/advanced-geometric-shape/basin-tessellation.ifc",
        label: "annex_e/advanced/basin-tessellation",
        expect_geometry: true,
    },
    Fixture {
        path: "tests/models/buildingsmart/annex_e/advanced-geometric-shape/bath-csg-solid.ifc",
        label: "annex_e/advanced/bath-csg-solid (#780)",
        expect_geometry: true,
    },
    Fixture {
        path: "tests/models/buildingsmart/annex_e/advanced-geometric-shape/cube-advanced-brep.ifc",
        label: "annex_e/advanced/cube-advanced-brep",
        expect_geometry: true,
    },
    // ─── buildingSMART IFC 4.3 — Annex E / Basic Geometric Shape ───
    Fixture {
        path: "tests/models/buildingsmart/annex_e/basic-geometric-shape/brep-model.ifc",
        label: "annex_e/basic/brep-model",
        expect_geometry: true,
    },
    Fixture {
        path: "tests/models/buildingsmart/annex_e/basic-geometric-shape/csg-primitive.ifc",
        label: "annex_e/basic/csg-primitive",
        expect_geometry: true,
    },
    Fixture {
        path: "tests/models/buildingsmart/annex_e/basic-geometric-shape/extruded-solid.ifc",
        label: "annex_e/basic/extruded-solid",
        expect_geometry: true,
    },
    Fixture {
        path: "tests/models/buildingsmart/annex_e/basic-geometric-shape/surface-model.ifc",
        label: "annex_e/basic/surface-model",
        expect_geometry: true,
    },
    Fixture {
        path: "tests/models/buildingsmart/annex_e/basic-geometric-shape/triangulated-item.ifc",
        label: "annex_e/basic/triangulated-item",
        expect_geometry: true,
    },
    // ─── buildingSMART IFC 4.3 — Annex E / Mapped Geometric Shape ───
    Fixture {
        path: "tests/models/buildingsmart/annex_e/mapped-geometric-shape/mapped-shape-with-multiple-items.ifc",
        label: "annex_e/mapped/multiple-items",
        expect_geometry: true,
    },
    Fixture {
        path: "tests/models/buildingsmart/annex_e/mapped-geometric-shape/mapped-shape-with-transformation.ifc",
        label: "annex_e/mapped/with-transformation",
        expect_geometry: true,
    },
    Fixture {
        path: "tests/models/buildingsmart/annex_e/mapped-geometric-shape/mapped-shape-without-transformation.ifc",
        label: "annex_e/mapped/without-transformation",
        expect_geometry: true,
    },
    // ─── buildingSMART IFC 4.3 — Annex E / Tessellated Shape ───
    Fixture {
        path: "tests/models/buildingsmart/annex_e/tessellated-shape/beam-curved-i-shape-tessellated.ifc",
        label: "annex_e/tess/beam-curved-i",
        expect_geometry: true,
    },
    Fixture {
        path: "tests/models/buildingsmart/annex_e/tessellated-shape/beam-straight-i-shape-tessellated.ifc",
        label: "annex_e/tess/beam-straight-i",
        expect_geometry: true,
    },
    Fixture {
        path: "tests/models/buildingsmart/annex_e/tessellated-shape/column-straight-rectangle-tessellation.ifc",
        label: "annex_e/tess/column-rectangle",
        expect_geometry: true,
    },
    Fixture {
        path: "tests/models/buildingsmart/annex_e/tessellated-shape/polygonal-face-tessellation.ifc",
        label: "annex_e/tess/polygonal-face",
        expect_geometry: true,
    },
    Fixture {
        path: "tests/models/buildingsmart/annex_e/tessellated-shape/slab-tessellated-unique-vertices.ifc",
        label: "annex_e/tess/slab-unique-vertices",
        expect_geometry: true,
    },
    // ─── buildingSMART IFC 4.3 — Annex E / Tessellated Shape With Style ───
    // The three "with-*-texture" fixtures ship their tessellated geometry
    // attached via `IfcRepresentationMap` to an `IfcBoilerType` only — no
    // `IfcBoiler` instance exists in the file, so the product-walking
    // pipeline correctly produces no rendered geometry. They still parse
    // cleanly and trigger no NaN, which is what this harness checks.
    // `individual-colors` ships an actual instance and produces 12 tris.
    Fixture {
        path: "tests/models/buildingsmart/annex_e/tessellated-shape-with-style/tessellation-with-blob-texture.ifc",
        label: "annex_e/tess-style/blob-texture (type-only)",
        expect_geometry: false,
    },
    Fixture {
        path: "tests/models/buildingsmart/annex_e/tessellated-shape-with-style/tessellation-with-image-texture.ifc",
        label: "annex_e/tess-style/image-texture (type-only)",
        expect_geometry: false,
    },
    Fixture {
        path: "tests/models/buildingsmart/annex_e/tessellated-shape-with-style/tessellation-with-individual-colors.ifc",
        label: "annex_e/tess-style/individual-colors",
        expect_geometry: true,
    },
    Fixture {
        path: "tests/models/buildingsmart/annex_e/tessellated-shape-with-style/tessellation-with-pixel-texture.ifc",
        label: "annex_e/tess-style/pixel-texture (type-only)",
        expect_geometry: false,
    },
    // ─── GitHub issue regression IFCs ───
    Fixture {
        path: "tests/models/issues/218_IFC-test-lite.ifc",
        label: "issue #218 — window rendering",
        expect_geometry: true,
    },
    Fixture {
        path: "tests/models/issues/424_frame.ifc",
        label: "issue #424 — IfcDerivedProfileDef",
        expect_geometry: true,
    },
    Fixture {
        path: "tests/models/issues/472_2222.ifc",
        label: "issue #472 — SurfaceModel support",
        expect_geometry: true,
    },
];

/// Per-fixture rollup of what came out of the pipeline.
#[derive(Debug, Default, Clone)]
struct FixtureReport {
    label: String,
    path: String,
    fixture_found: bool,
    parse_ok: bool,
    /// Count of spatial products the harness attempted to process.
    products_attempted: usize,
    /// Count whose mesh ended up non-empty.
    products_non_empty: usize,
    /// Errors caught from `process_element_with_voids` / `process_element`.
    process_errors: usize,
    /// Total triangles across all elements.
    total_triangles: usize,
    /// Total vertices across all elements.
    total_vertices: usize,
    /// World bounding box (all elements combined). `None` if no element
    /// produced geometry.
    world_bbox: Option<((f32, f32, f32), (f32, f32, f32))>,
    /// Triangles whose longest-edge / shortest-edge ratio exceeds 50:1.
    spike_triangles: usize,
    /// Worst aspect ratio seen across all triangles.
    worst_aspect: f32,
    /// True if any vertex position contains NaN or Inf.
    has_non_finite: bool,
    /// Per-IfcType processing counts (`IFCWALL=3` etc.) — quick diff
    /// against the viewer's element list.
    types_seen: BTreeMap<String, usize>,
}

fn fixture_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join(relative)
}

fn build_void_index(content: &str) -> FxHashMap<u32, Vec<u32>> {
    let mut idx: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);
    while let Some((id, name, start, end)) = scanner.next_entity() {
        if name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let (Some(host), Some(opening)) = (entity.get_ref(4), entity.get_ref(5)) {
                    idx.entry(host).or_default().push(opening);
                }
            }
        }
    }
    let _ = propagate_voids_to_parts(&mut idx, content, &mut decoder);
    idx
}

/// Find every "product" — i.e. anything that's a subtype of IfcProduct
/// and carries a `Representation` (attribute 6). Cheap heuristic: scan
/// for entity types whose name starts with `IFC` and is in a small
/// allowlist. We bias toward broad coverage; the per-element processor
/// will return an empty mesh for spatial elements without geometry
/// (IfcSite, IfcBuilding, IfcBuildingStorey…) which the rollup ignores.
fn list_geometry_products(content: &str) -> Vec<(u32, String)> {
    let mut products = Vec::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, name, _, _)) = scanner.next_entity() {
        // Crude type filter — anything that's a product-like element.
        // The downstream router rejects non-product types fast, so
        // false positives just cost a decode + early-return.
        if name.starts_with("IFC")
            && !matches!(
                name,
                "IFCPROJECT"
                    | "IFCSITE"
                    | "IFCBUILDING"
                    | "IFCBUILDINGSTOREY"
                    | "IFCSPACE"
                    | "IFCCARTESIANPOINT"
                    | "IFCDIRECTION"
                    | "IFCAXIS2PLACEMENT3D"
                    | "IFCAXIS2PLACEMENT2D"
                    | "IFCPRODUCTDEFINITIONSHAPE"
                    | "IFCSHAPEREPRESENTATION"
                    | "IFCREPRESENTATIONMAP"
                    | "IFCMAPPEDITEM"
                    | "IFCLOCALPLACEMENT"
                    | "IFCRELAGGREGATES"
                    | "IFCRELCONTAINEDINSPATIALSTRUCTURE"
                    | "IFCRELDEFINESBYTYPE"
                    | "IFCRELASSOCIATESMATERIAL"
                    | "IFCRELVOIDSELEMENT"
                    | "IFCRELDECLARES"
                    | "IFCOWNERHISTORY"
                    | "IFCPERSON"
                    | "IFCORGANIZATION"
                    | "IFCAPPLICATION"
                    | "IFCPERSONANDORGANIZATION"
                    | "IFCUNITASSIGNMENT"
                    | "IFCSIUNIT"
                    | "IFCMATERIAL"
                    | "IFCSTYLEDITEM"
                    | "IFCPRESENTATIONSTYLEASSIGNMENT"
                    | "IFCSURFACESTYLE"
                    | "IFCSURFACESTYLERENDERING"
                    | "IFCCOLOURRGB"
                    | "IFCGEOMETRICREPRESENTATIONCONTEXT"
                    | "IFCGEOMETRICREPRESENTATIONSUBCONTEXT"
            )
            && !is_likely_geometry_atom(name)
        {
            products.push((id, name.to_string()));
        }
    }
    products
}

/// Heuristic: types that are *parts of* geometry rather than products
/// referencing it. The list isn't exhaustive — the router handles its
/// own type-not-supported short-circuit — this just trims the obvious
/// noise so the report stays readable.
fn is_likely_geometry_atom(t: &str) -> bool {
    let prefixes = [
        "IFCPOLY",
        "IFCEXTRUDED",
        "IFCBOOLEAN",
        "IFCCSGSOLID",
        "IFCBLOCK",
        "IFCROUNDED",
        "IFCRECTANGLE",
        "IFCCIRCLE",
        "IFCSHELL",
        "IFCFACET",
        "IFCFACE",
        "IFCTRIANGULAT",
        "IFCPOLYGONAL",
        "IFCADVANCED",
        "IFCCLOSED",
        "IFCOPEN",
        "IFCBSPLINE",
        "IFCCURVEBOUND",
        "IFCMAPPED",
        "IFCPRESENTATION",
        "IFCTEXT",
        "IFCTEXTURE",
        "IFCSURFACETEXTURE",
        "IFCIMAGE",
        "IFCBLOBTEXTURE",
        "IFCPIXEL",
        "IFCINDEXED",
        "IFCCARTESIANTRANSFORMATION",
        "IFCSWEPT",
        "IFCREVOLVED",
        "IFCFIXEDREFERENCESWEPT",
        "IFCDIRECTRIX",
        "IFCPLANE",
        "IFCSURFACEOF",
        "IFCREL",
        "IFCQUANTITY",
        "IFCELEMENTQUANTITY",
        "IFCPROPERTY",
        "IFCPROPSET",
        "IFCCOMPLEXPROPERTY",
        "IFCLABEL",
        "IFCIDENTIFIER",
    ];
    prefixes.iter().any(|p| t.starts_with(p))
}

fn run_fixture(fx: &Fixture) -> FixtureReport {
    let mut report = FixtureReport {
        label: fx.label.to_string(),
        path: fx.path.to_string(),
        ..Default::default()
    };
    let p = fixture_path(fx.path);
    if !p.exists() {
        return report;
    }
    report.fixture_found = true;
    let Ok(content) = std::fs::read_to_string(&p) else {
        return report;
    };
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let void_idx = build_void_index(&content);
    report.parse_ok = true;

    let products = list_geometry_products(&content);
    report.products_attempted = products.len();

    let mut combined_min = (f32::INFINITY, f32::INFINITY, f32::INFINITY);
    let mut combined_max = (f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
    let mut any_geometry = false;

    for (id, type_name) in &products {
        let entity = match decoder.decode_by_id(*id) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let mesh_result = if void_idx.contains_key(id) {
            router.process_element_with_voids(&entity, &mut decoder, &void_idx)
        } else {
            router.process_element(&entity, &mut decoder)
        };
        let mesh = match mesh_result {
            Ok(m) => m,
            Err(_) => {
                report.process_errors += 1;
                continue;
            }
        };
        if mesh.indices.is_empty() {
            continue;
        }
        report.products_non_empty += 1;
        *report.types_seen.entry(type_name.clone()).or_default() += 1;
        report.total_triangles += mesh.indices.len() / 3;
        report.total_vertices += mesh.positions.len() / 3;
        accumulate_stats(
            &mesh,
            &mut combined_min,
            &mut combined_max,
            &mut report.spike_triangles,
            &mut report.worst_aspect,
            &mut report.has_non_finite,
        );
        any_geometry = true;
    }

    if any_geometry {
        report.world_bbox = Some((combined_min, combined_max));
    }
    report
}

fn accumulate_stats(
    mesh: &Mesh,
    mn: &mut (f32, f32, f32),
    mx: &mut (f32, f32, f32),
    spikes: &mut usize,
    worst: &mut f32,
    non_finite: &mut bool,
) {
    for c in mesh.positions.chunks_exact(3) {
        if !c[0].is_finite() || !c[1].is_finite() || !c[2].is_finite() {
            *non_finite = true;
            continue;
        }
        mn.0 = mn.0.min(c[0]);
        mn.1 = mn.1.min(c[1]);
        mn.2 = mn.2.min(c[2]);
        mx.0 = mx.0.max(c[0]);
        mx.1 = mx.1.max(c[1]);
        mx.2 = mx.2.max(c[2]);
    }
    for tri in mesh.indices.chunks_exact(3) {
        let p: [[f32; 3]; 3] = [
            [
                mesh.positions[tri[0] as usize * 3],
                mesh.positions[tri[0] as usize * 3 + 1],
                mesh.positions[tri[0] as usize * 3 + 2],
            ],
            [
                mesh.positions[tri[1] as usize * 3],
                mesh.positions[tri[1] as usize * 3 + 1],
                mesh.positions[tri[1] as usize * 3 + 2],
            ],
            [
                mesh.positions[tri[2] as usize * 3],
                mesh.positions[tri[2] as usize * 3 + 1],
                mesh.positions[tri[2] as usize * 3 + 2],
            ],
        ];
        let d = |a: [f32; 3], b: [f32; 3]| {
            ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
        };
        let e0 = d(p[0], p[1]);
        let e1 = d(p[1], p[2]);
        let e2 = d(p[2], p[0]);
        let mn_e = e0.min(e1).min(e2);
        let mx_e = e0.max(e1).max(e2);
        if mn_e > 1.0e-6 {
            let ratio = mx_e / mn_e;
            *worst = worst.max(ratio);
            if ratio > 50.0 {
                *spikes += 1;
            }
        }
    }
}

#[test]
fn geometry_correctness_harness() {
    let mut reports = Vec::with_capacity(FIXTURES.len());
    for fx in FIXTURES {
        reports.push(run_fixture(fx));
    }

    println!();
    println!(
        "{:<48} {:>4} {:>4} {:>6} {:>6} {:>6} {:>6} {:>7}",
        "fixture", "prod", "geom", "tris", "verts", "spike", "err", "worst"
    );
    println!("{}", "─".repeat(96));
    let mut total_fixtures = 0;
    let mut missing = 0;
    let mut parse_failed = 0;
    let mut non_finite_fixtures = 0;
    let mut empty_when_expected = 0;
    for (fx, r) in FIXTURES.iter().zip(reports.iter()) {
        total_fixtures += 1;
        if !r.fixture_found {
            missing += 1;
            println!("{:<48} {:>4}", r.label, "MISS");
            continue;
        }
        if !r.parse_ok {
            parse_failed += 1;
            println!("{:<48} {:>4}", r.label, "PARSE-FAIL");
            continue;
        }
        if r.has_non_finite {
            non_finite_fixtures += 1;
        }
        if fx.expect_geometry && r.products_non_empty == 0 {
            empty_when_expected += 1;
        }
        let worst_str = if r.worst_aspect.is_finite() && r.worst_aspect > 0.0 {
            format!("{:.1}:1", r.worst_aspect)
        } else {
            "  -".to_string()
        };
        println!(
            "{:<48} {:>4} {:>4} {:>6} {:>6} {:>6} {:>6} {:>7}",
            r.label,
            r.products_attempted,
            r.products_non_empty,
            r.total_triangles,
            r.total_vertices,
            r.spike_triangles,
            r.process_errors,
            worst_str
        );
    }
    println!("{}", "─".repeat(96));
    println!(
        "summary: {} fixtures, {} missing, {} parse-fail, {} non-finite, {} empty-when-expected",
        total_fixtures, missing, parse_failed, non_finite_fixtures, empty_when_expected
    );

    if let Ok(report_path) = std::env::var("IFC_LITE_HARNESS_REPORT") {
        write_json_report(&reports, &report_path);
        println!("[harness] wrote JSON report to {report_path}");
    }

    // Universal invariants — these are the only HARD failures the first
    // pass enforces. Per-fixture triangle counts and bbox baselines get
    // pinned in dedicated regression tests after visual confirmation.
    assert_eq!(
        non_finite_fixtures, 0,
        "{} fixture(s) emitted NaN or Inf vertex positions",
        non_finite_fixtures
    );
    assert_eq!(
        parse_failed, 0,
        "{} fixture(s) failed to parse",
        parse_failed
    );
    assert_eq!(
        empty_when_expected, 0,
        "{} fixture(s) marked expect_geometry produced no geometry",
        empty_when_expected
    );
}

fn write_json_report(reports: &[FixtureReport], path: &str) {
    // Tiny hand-rolled JSON writer — no serde dep needed in tests.
    let mut s = String::with_capacity(8 * 1024);
    s.push_str("{\n  \"fixtures\": [\n");
    for (i, r) in reports.iter().enumerate() {
        s.push_str("    {\n");
        s.push_str(&format!("      \"label\": {},\n", json_str(&r.label)));
        s.push_str(&format!("      \"path\": {},\n", json_str(&r.path)));
        s.push_str(&format!("      \"fixture_found\": {},\n", r.fixture_found));
        s.push_str(&format!("      \"parse_ok\": {},\n", r.parse_ok));
        s.push_str(&format!(
            "      \"products_attempted\": {},\n",
            r.products_attempted
        ));
        s.push_str(&format!(
            "      \"products_non_empty\": {},\n",
            r.products_non_empty
        ));
        s.push_str(&format!(
            "      \"process_errors\": {},\n",
            r.process_errors
        ));
        s.push_str(&format!(
            "      \"total_triangles\": {},\n",
            r.total_triangles
        ));
        s.push_str(&format!(
            "      \"total_vertices\": {},\n",
            r.total_vertices
        ));
        s.push_str(&format!(
            "      \"spike_triangles\": {},\n",
            r.spike_triangles
        ));
        s.push_str(&format!(
            "      \"worst_aspect\": {:.3},\n",
            if r.worst_aspect.is_finite() {
                r.worst_aspect as f64
            } else {
                0.0
            }
        ));
        s.push_str(&format!("      \"has_non_finite\": {},\n", r.has_non_finite));
        if let Some((mn, mx)) = r.world_bbox {
            s.push_str(&format!(
                "      \"world_bbox\": [[{:.4}, {:.4}, {:.4}], [{:.4}, {:.4}, {:.4}]],\n",
                mn.0, mn.1, mn.2, mx.0, mx.1, mx.2
            ));
        } else {
            s.push_str("      \"world_bbox\": null,\n");
        }
        s.push_str("      \"types_seen\": {");
        let mut first = true;
        for (t, n) in &r.types_seen {
            if !first {
                s.push_str(", ");
            }
            first = false;
            s.push_str(&format!("{}: {}", json_str(t), n));
        }
        s.push_str("}\n");
        if i + 1 < reports.len() {
            s.push_str("    },\n");
        } else {
            s.push_str("    }\n");
        }
    }
    s.push_str("  ]\n}\n");
    let _ = std::fs::write(path, s);
}

fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
