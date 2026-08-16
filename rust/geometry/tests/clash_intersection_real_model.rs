// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Measurement harness: `intersection_solid` on a real model.
//!
//! Runs the production geometry pipeline over the buildingSMART Infra-Bridge
//! model, hands the resulting WORLD-SPACE element meshes to the real clash
//! engine (`ifc-lite-clash`, the same `ClashSession::ingest` + `run_rule` the
//! product uses), and then calls [`intersection_solid`] on every reported
//! clash pair, recording the outcome, the operand sizes and the wall-clock cost
//! of the boolean itself.
//!
//! This is an instrument, not an assertion suite: it prints a table under
//! `--nocapture` and asserts only that the run happened (pairs were found and
//! no call panicked). It is `#[ignore]`d because it parses a 1.9 MB IFC and
//! runs an exact CSG boolean per pair.
//!
//! ```text
//! cargo test --release -p ifc-lite-geometry \
//!     --test clash_intersection_real_model -- --ignored --nocapture
//! ```

use ifc_lite_clash::{ClashSession, ClashStatus};
use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{
    intersection_solid, propagate_voids_to_parts, DegenerateReason, GeometryRouter,
    IntersectionSolid, Mesh,
};
use rustc_hash::FxHashMap;
use std::path::PathBuf;
use std::time::Instant;

/// Candidate locations for the model, tried in order. The repo vendors it under
/// `tests/models/`; a worktree that has not fetched the model set still carries
/// the byte-identical viewer sample.
const MODEL_CANDIDATES: [&str; 2] = [
    "tests/models/buildingsmart/Infra-Bridge.ifc",
    "apps/viewer/public/samples/infra-bridge.ifc",
];

/// The product's default hard-clash rule settings (`packages/clash/src/types.ts`).
const TOLERANCE_M: f64 = 0.002;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

fn model_path() -> Option<PathBuf> {
    MODEL_CANDIDATES
        .iter()
        .map(|r| repo_root().join(r))
        .find(|p| p.exists())
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

/// One element with geometry, in the common world frame.
struct Element {
    id: u32,
    ifc_type: String,
    mesh: Mesh,
    aabb: [f32; 6],
}

/// Bake `mesh.origin` (the optional per-element local frame) into `positions`,
/// so every element ends up in ONE world frame. On native the router defaults to
/// absolute world coordinates (`origin == 0`) and this is a no-op, but relying on
/// that default silently would make the whole measurement meaningless under
/// `IFC_LITE_LOCAL_FRAME`.
fn to_world_frame(mut mesh: Mesh) -> Mesh {
    let o = mesh.origin;
    if o != [0.0, 0.0, 0.0] {
        for c in mesh.positions.chunks_exact_mut(3) {
            c[0] = (c[0] as f64 + o[0]) as f32;
            c[1] = (c[1] as f64 + o[1]) as f32;
            c[2] = (c[2] as f64 + o[2]) as f32;
        }
        mesh.origin = [0.0; 3];
    }
    mesh
}

fn aabb_of(mesh: &Mesh) -> [f32; 6] {
    let mut lo = [f32::INFINITY; 3];
    let mut hi = [f32::NEG_INFINITY; 3];
    for c in mesh.positions.chunks_exact(3) {
        for k in 0..3 {
            lo[k] = lo[k].min(c[k]);
            hi[k] = hi[k].max(c[k]);
        }
    }
    [lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]]
}

/// Element types that carry product geometry. An explicit allowlist beats the
/// broad "anything IFC*" scan here: this test feeds the clash engine, and a
/// stray non-product entity would show up as a phantom clash pair.
fn is_product_type(t: &str) -> bool {
    const SKIP_EXACT: [&str; 6] = [
        "IFCPROJECT",
        "IFCSITE",
        "IFCBUILDING",
        "IFCBUILDINGSTOREY",
        "IFCSPACE",
        "IFCOPENINGELEMENT",
    ];
    if !t.starts_with("IFC") || SKIP_EXACT.contains(&t) {
        return false;
    }
    const PRODUCT_SUFFIXES: [&str; 6] = [
        "ELEMENT",
        "SEGMENT",
        "PART",
        "PROXY",
        "TERMINAL",
        "FITTING",
    ];
    const PRODUCT_EXACT: [&str; 26] = [
        "IFCBEAM",
        "IFCCOLUMN",
        "IFCSLAB",
        "IFCWALL",
        "IFCWALLSTANDARDCASE",
        "IFCMEMBER",
        "IFCPLATE",
        "IFCRAILING",
        "IFCROOF",
        "IFCSTAIR",
        "IFCSTAIRFLIGHT",
        "IFCRAMP",
        "IFCRAMPFLIGHT",
        "IFCDOOR",
        "IFCWINDOW",
        "IFCPILE",
        "IFCFOOTING",
        "IFCBEARING",
        "IFCCOVERING",
        "IFCCURTAINWALL",
        "IFCPIPESEGMENT",
        "IFCDUCTSEGMENT",
        "IFCREINFORCINGBAR",
        "IFCFURNISHINGELEMENT",
        "IFCCHIMNEY",
        "IFCSHADINGDEVICE",
    ];
    PRODUCT_EXACT.contains(&t) || PRODUCT_SUFFIXES.iter().any(|s| t.ends_with(s))
}

fn load_elements(content: &str) -> Vec<Element> {
    let entity_index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, entity_index);
    let router = GeometryRouter::with_units(content, &mut decoder);
    let void_idx = build_void_index(content);

    let mut candidates: Vec<(u32, String)> = Vec::new();
    {
        let mut scanner = EntityScanner::new(content);
        while let Some((id, name, _, _)) = scanner.next_entity() {
            if is_product_type(name) {
                candidates.push((id, name.to_string()));
            }
        }
    }

    let mut out = Vec::new();
    for (id, ifc_type) in candidates {
        let Ok(entity) = decoder.decode_by_id(id) else {
            continue;
        };
        let mesh_result = if void_idx.contains_key(&id) {
            router.process_element_with_voids(&entity, &mut decoder, &void_idx)
        } else {
            router.process_element(&entity, &mut decoder)
        };
        let Ok(mesh) = mesh_result else { continue };
        if mesh.indices.len() < 3 {
            continue;
        }
        let mesh = to_world_frame(mesh);
        let aabb = aabb_of(&mesh);
        out.push(Element {
            id,
            ifc_type,
            mesh,
            aabb,
        });
    }
    out
}

/// Short label: `IFCBEAM` -> `IfcBeam`.
fn pretty_type(t: &str) -> String {
    let mut s = String::with_capacity(t.len());
    for (i, ch) in t.chars().enumerate() {
        if i < 3 {
            s.push(if i == 0 { ch } else { ch.to_ascii_lowercase() });
        } else if i == 3 {
            s.push(ch);
        } else {
            s.push(ch.to_ascii_lowercase());
        }
    }
    s
}

fn outcome_label(s: &IntersectionSolid) -> String {
    match s {
        IntersectionSolid::Solid { volume_m3, .. } => format!("Solid {volume_m3:.9} m³"),
        IntersectionSolid::Degenerate(DegenerateReason::EmptyOperand) => "EmptyOperand".into(),
        IntersectionSolid::Degenerate(DegenerateReason::NoOverlap) => "NoOverlap".into(),
        IntersectionSolid::Degenerate(DegenerateReason::BudgetExhausted) => "BudgetExhausted".into(),
        IntersectionSolid::Degenerate(DegenerateReason::BelowKernelResolution {
            thickness_m,
            required_m,
        }) => format!("BelowKernelResolution t={thickness_m:.3e} need={required_m:.3e}"),
    }
}

struct Row {
    a_type: String,
    b_type: String,
    a_id: u32,
    b_id: u32,
    a_tris: usize,
    b_tris: usize,
    status: ClashStatus,
    outcome: String,
    volume: Option<f64>,
    solid_tris: usize,
    ms: f64,
}

#[test]
#[ignore = "parses a 1.9 MB IFC and runs an exact CSG boolean per clash pair"]
fn intersection_solid_on_the_infra_bridge_model() {
    let Some(path) = model_path() else {
        panic!("model not found; looked for {MODEL_CANDIDATES:?} under {:?}", repo_root());
    };
    println!("model: {}", path.display());

    let t0 = Instant::now();
    let content = std::fs::read_to_string(&path).expect("read model");
    let elements = load_elements(&content);
    println!(
        "parsed + meshed {} elements with geometry in {:.2} s",
        elements.len(),
        t0.elapsed().as_secs_f64()
    );
    assert!(!elements.is_empty(), "no element geometry produced");

    // ── Real clash engine: same ingest/run_rule the product uses ───────────
    let mut positions: Vec<f32> = Vec::new();
    let mut pos_ranges: Vec<u32> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut idx_ranges: Vec<u32> = Vec::new();
    let mut aabbs: Vec<f32> = Vec::new();
    for e in &elements {
        pos_ranges.push(positions.len() as u32);
        pos_ranges.push(e.mesh.positions.len() as u32);
        positions.extend_from_slice(&e.mesh.positions);
        idx_ranges.push(indices.len() as u32);
        idx_ranges.push(e.mesh.indices.len() as u32);
        indices.extend_from_slice(&e.mesh.indices);
        aabbs.extend_from_slice(&e.aabb);
    }
    let mut session = ClashSession::new();
    session.ingest(&positions, &pos_ranges, &indices, &idx_ranges, &aabbs);
    let all: Vec<u32> = (0..elements.len() as u32).collect();
    let t_clash = Instant::now();
    // mode 0 = hard, self-clash (empty group_b), product default tolerance.
    let result = session.run_rule(&all, &[], 0, TOLERANCE_M, 0.0, false);
    println!(
        "clash engine: {} records in {:.3} s (hard, tolerance {TOLERANCE_M} m, self-clash)",
        result.records.len(),
        t_clash.elapsed().as_secs_f64()
    );

    // ── intersection_solid per pair ────────────────────────────────────────
    let mut rows: Vec<Row> = Vec::new();
    for rec in &result.records {
        let a = &elements[rec.a as usize];
        let b = &elements[rec.b as usize];
        let t = Instant::now();
        let solid = intersection_solid(&a.mesh, &b.mesh);
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        rows.push(Row {
            a_type: pretty_type(&a.ifc_type),
            b_type: pretty_type(&b.ifc_type),
            a_id: a.id,
            b_id: b.id,
            a_tris: a.mesh.indices.len() / 3,
            b_tris: b.mesh.indices.len() / 3,
            status: rec.status,
            outcome: outcome_label(&solid),
            volume: solid.volume_m3(),
            solid_tris: solid.triangle_count(),
            ms,
        });
    }

    // ── Table ──────────────────────────────────────────────────────────────
    println!();
    println!(
        "{:>4}  {:<20} {:<20} {:>8} {:>8} {:>9} {:>8} {:>9}  outcome",
        "#", "A", "B", "#A id", "#B id", "trisA/B", "solidTri", "ms"
    );
    for (i, r) in rows.iter().enumerate() {
        println!(
            "{:>4}  {:<20} {:<20} {:>8} {:>8} {:>4}/{:<4} {:>8} {:>9.3}  {} [{:?}]",
            i,
            r.a_type,
            r.b_type,
            r.a_id,
            r.b_id,
            r.a_tris,
            r.b_tris,
            r.solid_tris,
            r.ms,
            r.outcome,
            r.status
        );
    }

    // ── Summary ────────────────────────────────────────────────────────────
    let mut n_solid = 0usize;
    let mut n_no_overlap = 0usize;
    let mut n_below = 0usize;
    let mut n_empty = 0usize;
    let mut n_budget = 0usize;
    for r in &rows {
        if r.volume.is_some() {
            n_solid += 1;
        } else if r.outcome.starts_with("NoOverlap") {
            n_no_overlap += 1;
        } else if r.outcome.starts_with("BelowKernelResolution") {
            n_below += 1;
        } else if r.outcome.starts_with("EmptyOperand") {
            n_empty += 1;
        } else {
            n_budget += 1;
        }
    }
    println!();
    println!("pairs examined:        {}", rows.len());
    println!("  Solid:               {n_solid}");
    println!("  NoOverlap:           {n_no_overlap}");
    println!("  BelowKernelResolution: {n_below}");
    println!("  EmptyOperand:        {n_empty}");
    println!("  BudgetExhausted:     {n_budget}");

    let mut vols: Vec<f64> = rows.iter().filter_map(|r| r.volume).collect();
    vols.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if !vols.is_empty() {
        println!(
            "volumes m³: min {:.9}  median {:.9}  max {:.9}  sum {:.9}",
            vols[0],
            vols[vols.len() / 2],
            vols[vols.len() - 1],
            vols.iter().sum::<f64>()
        );
    }

    let mut times: Vec<f64> = rows.iter().map(|r| r.ms).collect();
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if !times.is_empty() {
        println!(
            "intersection_solid ms: min {:.3}  median {:.3}  max {:.3}  total {:.1}",
            times[0],
            times[times.len() / 2],
            times[times.len() - 1],
            times.iter().sum::<f64>()
        );
    }

    println!();
    println!("IfcBeam × IfcBeam pairs:");
    let beams: Vec<&Row> = rows
        .iter()
        .filter(|r| r.a_type == "IfcBeam" && r.b_type == "IfcBeam")
        .collect();
    println!("  count: {}", beams.len());
    for r in &beams {
        println!(
            "  #{}×#{}  tris {}/{}  {:.3} ms  {}  [{:?}]",
            r.a_id, r.b_id, r.a_tris, r.b_tris, r.ms, r.outcome, r.status
        );
    }

    // Pair-type histogram, so the report can say what the 81 clashes actually are.
    let mut by_pair: std::collections::BTreeMap<String, usize> = Default::default();
    for r in &rows {
        let (x, y) = if r.a_type <= r.b_type {
            (&r.a_type, &r.b_type)
        } else {
            (&r.b_type, &r.a_type)
        };
        *by_pair.entry(format!("{x} × {y}")).or_default() += 1;
    }
    println!();
    println!("pair-type histogram:");
    for (k, v) in &by_pair {
        println!("  {k}: {v}");
    }

    assert!(!rows.is_empty(), "the clash engine found no pairs to measure");
    for r in &rows {
        if let Some(v) = r.volume {
            assert!(
                v.is_finite() && v >= 0.0,
                "absurd volume {v} for #{}×#{}",
                r.a_id,
                r.b_id
            );
        }
    }
}
