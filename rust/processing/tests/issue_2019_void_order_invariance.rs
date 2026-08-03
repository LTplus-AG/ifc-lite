// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression for #2019: the world geometry hash must be invariant to the
//! order `IFCRELVOIDSELEMENT` statements appear in the file.
//!
//! `void_index` (host element id -> Vec<opening id>) used to be built by
//! scanning the file's `IFCRELVOIDSELEMENT` relationships in the order they
//! are written, then pushed straight into `Vec<u32>` with no
//! canonicalisation (`rust/processing/src/prepass.rs`, the `spans.void_rels`
//! loop). The wall CSG kernel subtracts openings from a host SEQUENTIALLY
//! when they cannot join the disjoint-cutter batch or the coaxial-overlap
//! union pass, and each intermediate cut's f64->f32->snap round trip can
//! re-jitter carve vertices — so cutting the SAME set of openings in a
//! different order can produce a numerically (or even topologically)
//! different mesh. The fix sorts each host's opening ids by express id once,
//! at `resolve_prepass` construction time, so accumulation order is a
//! property of the model rather than of the file's byte layout.
//!
//! `tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc` is a ~2 KB
//! hand-authored fixture: one `IFCWALL` and THREE `IFCOPENINGELEMENT`s whose
//! footprints mutually overlap at three different angles (0°, ~37°, ~53°) so
//! none can join the disjoint-cutter batch. Two tests:
//!
//! - [`sequential_cut_order_is_not_associative`] confirms the MECHANISM: with
//!   every analytic fast path forced off, feeding the raw (uncanonicalised)
//!   opening order straight into the mesh pipeline in different permutations
//!   produces different triangle counts / hashes. This is a property of the
//!   CSG kernel this issue does not ask to change, so it is asserted as
//!   "diverges", not "must match" — it is expected to stay true forever and
//!   is here to document WHY the fix lives at the void_index construction
//!   site rather than in the kernel.
//! - [`world_geometry_hash_is_invariant_to_reordered_void_rel_statements`] is
//!   the actual regression: it goes through the REAL production entry point
//!   (`resolve_prepass`, via a hand-built `PrepassSpans` scan — the exact
//!   mechanism both the native and wasm pipelines share) against the
//!   original file and a byte-identical copy with only the three
//!   `IFCRELVOIDSELEMENT` statements reordered, and asserts the resolved
//!   `void_index` and the resulting hash/AABB are identical either way.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::GeometryRouter;
use ifc_lite_processing::element::{
    produce_element_meshes, ElementJobKind, ElementMeshJob, GeometryHashConfig,
    MeshProductionContext, MeshProductionOptions,
};
use ifc_lite_processing::prepass::{resolve_prepass, PrepassSpans, ResolveOptions};
use rustc_hash::FxHashMap;

const FIXTURE: &str = "tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc";
const WALL_ID: u32 = 30;

/// Force every analytic fast path off (parametric rect, 2D re-extrude, prism
/// cut, coaxial-overlap union) so mutually-overlapping openings fall all the
/// way to the per-opening sequential exact kernel — the same accumulation
/// the issue's own harness caught in the wild.
///
/// SAFETY: single-threaded within this test binary, called before any
/// production code reads these (each gate caches via `OnceLock`).
fn force_sequential_exact_kernel() {
    unsafe {
        std::env::set_var("IFC_LITE_VOID_UNION", "0");
        std::env::set_var("IFC_LITE_RECT_FAST", "0");
        std::env::set_var("IFC_LITE_VOID_2D", "0");
        std::env::set_var("IFC_LITE_PRISM_CUT", "0");
    }
}

/// The REAL production entry point: scan the file into `PrepassSpans` (the
/// exact mechanical span-stash both the native and wasm pipelines run) and
/// resolve it with `resolve_prepass`, returning the resolved `void_index`.
fn production_void_index(content: &str, decoder: &mut EntityDecoder) -> FxHashMap<u32, Vec<u32>> {
    let mut spans = PrepassSpans::default();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        match type_name {
            "IFCRELVOIDSELEMENT" => spans.void_rels.push((id, start, end)),
            "IFCRELFILLSELEMENT" => spans.fills_rels.push((id, start, end)),
            "IFCRELAGGREGATES" => spans.aggregate_rels.push((id, start, end)),
            _ => {}
        }
    }
    let resolved = resolve_prepass(&spans, decoder, ResolveOptions::default());
    resolved.void_index
}

/// Byte-identical copy of `content` except every `IFCRELVOIDSELEMENT`
/// statement line is written in REVERSE order — same ids, same everything
/// else, only the file's statement order changes. Mirrors the issue's own
/// isolation control ("statement order reversed, nothing else").
fn with_void_rel_statements_reversed(content: &str) -> String {
    let mut lines: Vec<&str> = content.lines().collect();
    let rel_line_indices: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| l.contains("IFCRELVOIDSELEMENT"))
        .map(|(i, _)| i)
        .collect();
    let mut texts: Vec<&str> = rel_line_indices.iter().map(|&i| lines[i]).collect();
    texts.reverse();
    for (slot, text) in rel_line_indices.into_iter().zip(texts.into_iter()) {
        lines[slot] = text;
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

/// Produce the world geometry hash + AABB + total triangle count for
/// `WALL_ID` given a caller-built `void_index` (host -> ordered opening ids).
fn hash_and_aabb_for(
    content: &str,
    void_index: &FxHashMap<u32, Vec<u32>>,
) -> (Option<u64>, Option<[f64; 6]>, usize) {
    let index = std::sync::Arc::new(build_entity_index(content));
    let mut decoder = EntityDecoder::with_arc_index(content.as_bytes(), index.clone());
    let router = GeometryRouter::with_units(content, &mut decoder);
    decoder.seed_unit_scales(router.unit_scale(), 1.0);

    let geometry_style_index = FxHashMap::default();
    let indexed_colour_full = FxHashMap::default();
    let element_material_colors = FxHashMap::default();
    let texture_index = FxHashMap::default();
    let ctx = MeshProductionContext {
        void_index,
        geometry_style_index: &geometry_style_index,
        indexed_colour_full: &indexed_colour_full,
        element_material_colors: &element_material_colors,
        texture_index: &texture_index,
        site_local_rotation: None,
    };
    let opts = MeshProductionOptions {
        geometry_hash: Some(GeometryHashConfig {
            tolerance: ifc_lite_geometry::DEFAULT_GEOM_HASH_TOLERANCE,
            world_rtc: [0.0; 3],
        }),
    };

    let entity = decoder.decode_by_id(WALL_ID).expect("wall entity decodes");
    let ifc_type = entity.ifc_type;
    let produced = produce_element_meshes(
        &ElementMeshJob {
            id: WALL_ID,
            ifc_type,
            entity: &entity,
            kind: ElementJobKind::Product,
            element_color: None,
            metadata: None,
        },
        &ctx,
        &opts,
        &mut decoder,
        &router,
    );
    let tris: usize = produced.meshes.iter().map(|m| m.indices.len() / 3).sum();
    (produced.geometry_hash, produced.geometry_aabb, tris)
}

/// MECHANISM CHECK — kept as a permanent, expected-to-pass sanity test: the
/// per-opening sequential exact kernel really is order sensitive for
/// mutually-overlapping, non-coaxial cutters. Not a regression test for this
/// issue (the kernel's own accumulation is explicitly out of scope for the
/// fix); it documents why canonicalising the INPUT order is the right fix
/// site.
#[test]
fn sequential_cut_order_is_not_associative() {
    force_sequential_exact_kernel();
    let content = std::fs::read_to_string(FIXTURE)
        .unwrap_or_else(|e| panic!("failed to read fixture {FIXTURE}: {e}"));

    let orders: [[u32; 3]; 2] = [[50, 70, 100], [100, 50, 70]];
    let mut seen = Vec::new();
    for order in orders {
        let mut idx: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
        idx.insert(WALL_ID, order.to_vec());
        let (hash, _aabb, tris) = hash_and_aabb_for(&content, &idx);
        eprintln!("order {order:?}: hash={hash:?} tris={tris}");
        seen.push((hash, tris));
    }

    assert_ne!(
        seen[0], seen[1],
        "expected the sequential exact kernel to be order-sensitive for these \
         mutually-overlapping cutters (that is the mechanism #2019's fix \
         works around by canonicalising void_index's order, not by changing \
         the kernel) — if this now matches, the fixture or the env-var gates \
         drifted and this test's premise needs re-checking"
    );
}

/// THE REGRESSION for #2019, through the real production entry point.
#[test]
fn world_geometry_hash_is_invariant_to_reordered_void_rel_statements() {
    force_sequential_exact_kernel();
    let content = std::fs::read_to_string(FIXTURE)
        .unwrap_or_else(|e| panic!("failed to read fixture {FIXTURE}: {e}"));
    let reordered = with_void_rel_statements_reversed(&content);
    assert_ne!(content, reordered, "the reorder helper must actually change the file bytes");

    let mut decoder_a = EntityDecoder::new(&content);
    let void_index_a = production_void_index(&content, &mut decoder_a);
    let mut decoder_b = EntityDecoder::new(&reordered);
    let void_index_b = production_void_index(&reordered, &mut decoder_b);

    let openings_a = void_index_a.get(&WALL_ID).cloned().unwrap_or_default();
    let openings_b = void_index_b.get(&WALL_ID).cloned().unwrap_or_default();
    eprintln!("resolve_prepass(original)  void_index[{WALL_ID}] = {openings_a:?}");
    eprintln!("resolve_prepass(reordered) void_index[{WALL_ID}] = {openings_b:?}");
    assert_eq!(
        openings_a, openings_b,
        "resolve_prepass produced a DIFFERENT opening order for the wall from a \
         file that only reordered its IFCRELVOIDSELEMENT statements — void_index \
         is not canonicalised (#2019)"
    );
    assert_eq!(openings_a.len(), 3, "fixture rot: expected 3 openings on wall #{WALL_ID}");

    let (hash_uncut, _aabb_uncut, tris_uncut) = hash_and_aabb_for(&content, &FxHashMap::default());
    let (hash_a, aabb_a, tris_a) = hash_and_aabb_for(&content, &void_index_a);
    let (hash_b, aabb_b, tris_b) = hash_and_aabb_for(&reordered, &void_index_b);

    eprintln!("original:  hash={hash_a:?} aabb={aabb_a:?} tris={tris_a}");
    eprintln!("reordered: hash={hash_b:?} aabb={aabb_b:?} tris={tris_b}");

    assert_ne!(
        (hash_a, tris_a),
        (hash_uncut, tris_uncut),
        "sanity check failed: the original file produced the SAME hash/tri \
         count as the uncut wall -- the openings never cut anything, so this \
         test would prove nothing"
    );

    assert_eq!(
        hash_a, hash_b,
        "wall #{WALL_ID}: world geometry hash changed for a file that only \
         reordered its IFCRELVOIDSELEMENT statements — the hash is not a \
         stable content address for opening-cut geometry (#2019)"
    );
    assert_eq!(
        aabb_a, aabb_b,
        "wall #{WALL_ID}: world AABB changed for a file that only reordered \
         its IFCRELVOIDSELEMENT statements (#2019)"
    );
}
