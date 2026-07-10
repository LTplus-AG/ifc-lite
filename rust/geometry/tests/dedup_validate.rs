// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Content-dedup A/B validation on a real model: drives the SUBMESH path (the
//! production `produce_element_meshes` entry, where the dedup lives — NOT the
//! `process_element` path the calibration harness uses) with dedup ON and OFF,
//! asserts the per-element geometry is BYTE-IDENTICAL between the two, and prints
//! the wall-time of each so the speedup is measurable.
//!
//! Two independent routers each start cold, so the timings are a fair cold-cache
//! comparison and a content-hash false-merge would surface as a fingerprint
//! mismatch (the OFF run is the ground truth — it rebuilds every element).
//!
//! IFCLT_MODEL=/abs/path.ifc cargo test -p ifc-lite-geometry --release \
//!   --test dedup_validate -- --ignored --nocapture

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter, SubMeshCollection};
use rustc_hash::FxHashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::Instant;

/// Simulate an N-worker partition: greedily pack each key's cost onto the
/// least-loaded worker (a good static-affinity scheduler), return the wall time =
/// the busiest worker's total cost. `groups` are reordered.
fn partition_wall(mut groups: Vec<f64>, workers: usize) -> f64 {
    // Sort heaviest-first so least-loaded packing approaches optimal makespan.
    groups.sort_by(|a, b| b.partial_cmp(a).unwrap());
    let mut load = vec![0.0f64; workers];
    for g in groups {
        let w = (0..workers).min_by(|&a, &b| load[a].partial_cmp(&load[b]).unwrap()).unwrap();
        load[w] += g;
    }
    load.into_iter().fold(0.0, f64::max)
}

/// The wall time the ACTUAL dispatcher gets: assign each key round-robin in
/// FIRST-APPEARANCE order (cost-blind), `groups` already in appearance order.
fn partition_wall_roundrobin(groups: &[f64], workers: usize) -> f64 {
    let mut load = vec![0.0f64; workers];
    for (i, g) in groups.iter().enumerate() {
        load[i % workers] += g;
    }
    load.into_iter().fold(0.0, f64::max)
}

/// TRUE per-worker-cache simulation for a given routing key: `workers` routers,
/// each its OWN dedup cache (exactly the viewer's separate WASM realms). Assign
/// each element to a worker by its routing key (round-robin sticky) and ACTUALLY
/// mesh it there, so an item shared by element-geometries on different workers is
/// re-meshed on each. Returns (per-worker mesh ms, total items meshed across all
/// workers — vs the global unique count, the cross-worker redundancy).
fn worker_sim(
    content: &str,
    void_idx: &FxHashMap<u32, Vec<u32>>,
    all_jobs: &[u32],
    key_of: &FxHashMap<u32, u128>,
    workers: usize,
) -> (Vec<f64>, usize) {
    let mut k2w: FxHashMap<u128, usize> = FxHashMap::default();
    let mut nxt = 0usize;
    let mut wr: Vec<GeometryRouter> = Vec::new();
    let mut wd: Vec<EntityDecoder> = Vec::new();
    for _ in 0..workers {
        let mut d = EntityDecoder::with_index(content, build_entity_index(content));
        wr.push(GeometryRouter::with_units(content, &mut d));
        wd.push(d);
    }
    let mut wtime = vec![0.0f64; workers];
    for id in all_jobs {
        let key = *key_of.get(id).unwrap_or(&(*id as u128));
        let w = *k2w.entry(key).or_insert_with(|| {
            let v = nxt;
            nxt = (nxt + 1) % workers;
            v
        });
        let e = match wd[w].decode_by_id(*id) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let openings = void_idx.get(id).map(|v| v.len()).unwrap_or(0);
        let t = Instant::now();
        let _ = if openings > 0 {
            wr[w].process_element_with_submeshes_and_voids(&e, &mut wd[w], void_idx)
        } else {
            wr[w].process_element_with_submeshes(&e, &mut wd[w])
        };
        wtime[w] += t.elapsed().as_secs_f64() * 1000.0;
    }
    let meshed: usize = wr.iter().map(|r| r.dedup_unique_count()).sum();
    (wtime, meshed)
}

/// What-routing-key analysis (#1131 follow-up): for a real model, how does the
/// 4-worker wall time of content-dedup'd meshing depend on the routing key — by
/// ObjectType (the cheap PR #1131 proxy) vs by exact geometry hash (the dedup
/// unit) vs the interleaved baseline? Measures the per-UNIQUE-geometry mesh cost
/// once, then packs the unique costs under each grouping.
///
/// IFCLT_MODEL=/abs/path.ifc cargo test -p ifc-lite-geometry --release \
///   --test dedup_validate analyze_affinity -- --ignored --nocapture
#[test]
#[ignore = "manual; needs IFCLT_MODEL"]
fn analyze_affinity_partition() {
    const WORKERS: usize = 4;
    let path = match std::env::var("IFCLT_MODEL") {
        Ok(p) => p,
        Err(_) => {
            println!("set IFCLT_MODEL=/abs/path.ifc");
            return;
        }
    };
    let content = std::fs::read_to_string(&path).expect("read model");
    let void_idx = build_void_index(&content);
    let products = list_products(&content);

    let mut decoder = EntityDecoder::with_index(&content, build_entity_index(&content));
    let router = GeometryRouter::with_units(&content, &mut decoder);

    // Per UNIQUE geometry (cache miss): (mesh_ms, object_type, element_id).
    let mut uniques: Vec<(f64, Option<String>, u32)> = Vec::new();
    let mut total_ms = 0.0;
    let mut prev_unique = 0usize;
    for (id, _ty) in &products {
        let entity = match decoder.decode_by_id(*id) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let obj_type = entity
            .get(4)
            .and_then(|a| a.as_string())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let openings = void_idx.get(id).map(|v| v.len()).unwrap_or(0);
        let t = Instant::now();
        let _ = if openings > 0 {
            router.process_element_with_submeshes_and_voids(&entity, &mut decoder, &void_idx)
        } else {
            router.process_element_with_submeshes(&entity, &mut decoder)
        };
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        total_ms += ms;
        // A cache MISS (the cache grew) means this element meshed a new unique
        // geometry — its time is the cost that routing must spread.
        let now_unique = router.dedup_unique_count();
        if now_unique > prev_unique {
            uniques.push((ms, obj_type, *id));
            prev_unique = now_unique;
        }
    }

    let unique_ms: f64 = uniques.iter().map(|u| u.0).sum();
    println!("\n=== affinity routing analysis ({WORKERS} workers) ===");
    println!("model: {path}");
    println!("elements: {}  unique geometries: {}", products.len(), uniques.len());
    println!("total serial mesh: {total_ms:.0}ms   unique-only (dedup floor): {unique_ms:.0}ms");

    // Group cost by ObjectType (empty ⇒ its own group, mirroring the id fallback).
    let mut by_type: FxHashMap<String, f64> = FxHashMap::default();
    for (ms, ot, id) in &uniques {
        let key = ot.clone().unwrap_or_else(|| format!("__id_{id}"));
        *by_type.entry(key).or_default() += ms;
    }
    let object_types = by_type.values().filter(|_| true).count();
    let real_types = by_type.keys().filter(|k| !k.starts_with("__id_")).count();
    println!("distinct ObjectTypes (routing buckets): {object_types} ({real_types} real, rest id-fallback)");

    // Walls: ideal lower bound (unique_ms / workers), per-geometry routing (each
    // unique its own bucket), per-ObjectType routing (PR #1131), and serial.
    let ideal = unique_ms / WORKERS as f64;
    let geo_costs: Vec<f64> = uniques.iter().map(|u| u.0).collect(); // appearance order
    let by_geometry_opt = partition_wall(geo_costs.clone(), WORKERS);
    let by_geometry_rr = partition_wall_roundrobin(&geo_costs, WORKERS);
    let by_objtype = partition_wall(by_type.values().copied().collect(), WORKERS);

    println!("\nprojected 4-worker wall (unique meshing only):");
    println!("  ideal (perfect split):           {ideal:.0}ms");
    println!("  by GEOMETRY hash, OPTIMAL pack:   {by_geometry_opt:.0}ms");
    println!("  by GEOMETRY hash, ROUND-ROBIN:    {by_geometry_rr:.0}ms  <- actual dispatcher");
    println!("  by OBJECTTYPE, optimal pack:      {by_objtype:.0}ms");
    println!("  serial (1 worker):               {unique_ms:.0}ms");

    // Cost concentration: how much of the floor is in the heaviest few uniques?
    let mut sorted = geo_costs.clone();
    sorted.sort_by(|a, b| b.partial_cmp(a).unwrap());
    let topn = |n: usize| sorted.iter().take(n).sum::<f64>();
    println!(
        "\ncost concentration: top1={:.0}ms top5={:.0}ms top10={:.0}ms top25={:.0}ms top50={:.0}ms (of {:.0}ms)",
        topn(1), topn(5), topn(10), topn(25), topn(50), unique_ms
    );

    // Prepass cost of computing the geometry routing key (hash only, no meshing),
    // from a COLD router — this is what the streaming pre-pass would add to emit
    // an exact-geometry affinity key instead of the ObjectType proxy.
    let mut hk_decoder = EntityDecoder::with_index(&content, build_entity_index(&content));
    let hk_router = GeometryRouter::with_units(&content, &mut hk_decoder);
    let t = Instant::now();
    let mut keyed = 0usize;
    for (id, _ty) in &products {
        if let Ok(e) = hk_decoder.decode_by_id(*id) {
            if hk_router.geometry_routing_key(&e, &mut hk_decoder).is_some() {
                keyed += 1;
            }
        }
    }
    let hash_ms = t.elapsed().as_secs_f64() * 1000.0;
    println!(
        "\nrouting-key (geometry hash) prepass cost: {hash_ms:.0}ms for {keyed} elements"
    );
    println!(
        "  → projected total, round-robin routing: ~{:.0}ms (prepass {hash_ms:.0} + parallel {by_geometry_rr:.0})",
        hash_ms + by_geometry_rr
    );

    // ── REALISTIC dispatcher simulation over EVERY geometry job ──
    // The above used the narrow `list_products` filter; the viewer's pre-pass
    // emits a job for every `has_geometry_by_name` entity. Re-run over the full
    // set with a COLD router, routing by the exact geometry key the dispatcher
    // uses, and accumulate REAL per-element time (build OR hit) onto the assigned
    // worker — the wall the viewer actually pays.
    let mut all_jobs: Vec<u32> = Vec::new();
    {
        let mut scanner = EntityScanner::new(&content);
        while let Some((id, name, _, _)) = scanner.next_entity() {
            if ifc_lite_core::has_geometry_by_name(name) {
                all_jobs.push(id);
            }
        }
    }
    let mut d2 = EntityDecoder::with_index(&content, build_entity_index(&content));
    let r2 = GeometryRouter::with_units(&content, &mut d2);
    let mut per_elem: Vec<(u128, f64)> = Vec::with_capacity(all_jobs.len());
    let mut rkeys: FxHashMap<u128, usize> = FxHashMap::default();
    let mut all_ms = 0.0;
    for id in &all_jobs {
        let e = match d2.decode_by_id(*id) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let rkey = r2.geometry_routing_key(&e, &mut d2).unwrap_or(*id as u128);
        let openings = void_idx.get(id).map(|v| v.len()).unwrap_or(0);
        let t = Instant::now();
        let _ = if openings > 0 {
            r2.process_element_with_submeshes_and_voids(&e, &mut d2, &void_idx)
        } else {
            r2.process_element_with_submeshes(&e, &mut d2)
        };
        all_ms += t.elapsed().as_secs_f64() * 1000.0;
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        per_elem.push((rkey, ms));
        *rkeys.entry(rkey).or_default() += 1;
    }
    let unique_items = r2.dedup_unique_count();
    println!("\n=== REALISTIC sim over ALL {} geometry jobs ===", all_jobs.len());
    println!(
        "distinct routing keys (PDS hash): {}   unique item geometries (dedup): {}   {}",
        rkeys.len(),
        unique_items,
        if rkeys.len() > unique_items * 12 / 10 {
            "<- MISALIGNED: routing splits shared geometry"
        } else {
            "(aligned)"
        }
    );
    println!("total serial mesh (incl hits): {all_ms:.0}ms   global floor (/{WORKERS}): {:.0}ms", all_ms / WORKERS as f64);

    // Build the routing key per element and run the TRUE per-worker sim. The
    // redundancy ≈ 1.0× confirms the affinity routing reaches the meshing floor
    // (each item meshed once across the pool); the WALL is the native floor — the
    // browser pays this × the wasm exact-arithmetic slowdown.
    let mut key_of: FxHashMap<u32, u128> = FxHashMap::default();
    {
        let mut dk = EntityDecoder::with_index(&content, build_entity_index(&content));
        let rk = GeometryRouter::with_units(&content, &mut dk);
        for id in &all_jobs {
            if let Ok(e) = dk.decode_by_id(*id) {
                key_of.insert(*id, rk.geometry_routing_key(&e, &mut dk).unwrap_or(*id as u128));
            }
        }
    }
    let (wtime, meshed) = worker_sim(&content, &void_idx, &all_jobs, &key_of, WORKERS);
    let wall = wtime.iter().cloned().fold(0.0, f64::max);
    println!(
        "\nTRUE per-worker sim ({WORKERS} caches, geometry-hash routing):\n  per-worker mesh (ms): {:?}   WALL: {wall:.0}ms\n  items meshed across workers: {meshed} (global unique {unique_items}, redundancy {:.2}x)",
        wtime.iter().map(|v| *v as u64).collect::<Vec<_>>(),
        meshed as f64 / unique_items.max(1) as f64,
    );
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

fn list_products(content: &str) -> Vec<(u32, String)> {
    let mut products = Vec::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, name, _, _)) = scanner.next_entity() {
        let n = name;
        if n.starts_with("IFC")
            && (n.contains("WALL") || n.contains("BEAM") || n.contains("COLUMN")
                || n.contains("MEMBER") || n.contains("PLATE") || n.contains("SLAB")
                || n.contains("FOOTING") || n.contains("PILE") || n.contains("RAILING")
                || n.contains("STAIR") || n.contains("ROOF") || n.contains("COVERING")
                || n.contains("BUILDINGELEMENT") || n.contains("PROXY") || n.contains("FLOW")
                || n.contains("DISCRETE") || n.contains("FURNISH")
                || n == "IFCDOOR" || n == "IFCWINDOW")
        {
            products.push((id, n.to_string()));
        }
    }
    products
}

/// Deterministic content fingerprint of a placed sub-mesh collection — every bit
/// that the renderer consumes (geometry id, f32 positions/normals, indices, and
/// the f64 local-frame origin), in submesh order.
fn fingerprint(sm: &SubMeshCollection) -> u64 {
    let mut h = DefaultHasher::new();
    sm.sub_meshes.len().hash(&mut h);
    for s in &sm.sub_meshes {
        s.geometry_id.hash(&mut h);
        s.mesh.positions.len().hash(&mut h);
        for &p in &s.mesh.positions {
            p.to_bits().hash(&mut h);
        }
        for &n in &s.mesh.normals {
            n.to_bits().hash(&mut h);
        }
        for &i in &s.mesh.indices {
            i.hash(&mut h);
        }
        for &o in &s.mesh.origin {
            o.to_bits().hash(&mut h);
        }
    }
    h.finish()
}

/// Process every product through the submesh path, returning (per-element
/// fingerprint, total triangles) and the wall-time.
fn run(
    router: &GeometryRouter,
    products: &[(u32, String)],
    void_idx: &FxHashMap<u32, Vec<u32>>,
    content: &str,
    index: FxHashMap<u32, (usize, usize)>,
) -> (Vec<(u32, u64)>, usize, f64) {
    // Sentinel fingerprints for the non-mesh outcomes, so EVERY product yields an
    // entry — ON and OFF stay 1:1 aligned and a config-dependent decode/mesh
    // divergence surfaces as a fingerprint mismatch instead of silently shrinking
    // the compared set.
    const FP_DECODE_ERR: u64 = u64::MAX;
    const FP_MESH_ERR: u64 = u64::MAX - 1;

    let mut decoder = EntityDecoder::with_index(content, index);
    let mut fps: Vec<(u32, u64)> = Vec::with_capacity(products.len());
    let mut tris = 0usize;
    let t = Instant::now();
    for (id, _ty) in products {
        let entity = match decoder.decode_by_id(*id) {
            Ok(e) => e,
            Err(_) => {
                fps.push((*id, FP_DECODE_ERR));
                continue;
            }
        };
        let openings = void_idx.get(id).map(|v| v.len()).unwrap_or(0);
        let sm = if openings > 0 {
            router.process_element_with_submeshes_and_voids(&entity, &mut decoder, void_idx)
        } else {
            router.process_element_with_submeshes(&entity, &mut decoder)
        };
        match sm {
            Ok(sm) => {
                tris += sm.sub_meshes.iter().map(|s| s.mesh.indices.len() / 3).sum::<usize>();
                fps.push((*id, fingerprint(&sm)));
            }
            Err(_) => fps.push((*id, FP_MESH_ERR)),
        }
    }
    (fps, tris, t.elapsed().as_secs_f64() * 1000.0)
}

/// Two `IfcBuildingElementProxy` with byte-identical FacetedBrep geometry (a
/// triangle, renumbered) at DIFFERENT placements, plus a third with a larger,
/// distinct triangle. The two duplicates must collapse to ONE cached item mesh;
/// the third stays separate.
fn synthetic_duplicates_ifc() -> String {
    r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('dedup.ifc','2025-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('proj',$,'P','',$,$,$,(#12),#7);
#7=IFCUNITASSIGNMENT((#8));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#12=IFCGEOMETRICREPRESENTATIONCONTEXT('3D','Model',3,1.E-6,#14,$);
#14=IFCAXIS2PLACEMENT3D(#15,$,$);
#15=IFCCARTESIANPOINT((0.,0.,0.));
#40=IFCLOCALPLACEMENT($,#41);
#41=IFCAXIS2PLACEMENT3D(#42,$,$);
#42=IFCCARTESIANPOINT((0.,0.,0.));
#50=IFCBUILDINGELEMENTPROXY('a1',$,'A1','',$,#40,#51,$,$);
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#52));
#52=IFCSHAPEREPRESENTATION(#12,'Body','Brep',(#53));
#53=IFCFACETEDBREP(#54);
#54=IFCCLOSEDSHELL((#55));
#55=IFCFACE((#56));
#56=IFCFACEOUTERBOUND(#57,.T.);
#57=IFCPOLYLOOP((#58,#59,#60));
#58=IFCCARTESIANPOINT((0.,0.,0.));
#59=IFCCARTESIANPOINT((1.,0.,0.));
#60=IFCCARTESIANPOINT((0.,1.,0.));
#70=IFCLOCALPLACEMENT($,#71);
#71=IFCAXIS2PLACEMENT3D(#72,$,$);
#72=IFCCARTESIANPOINT((10.,0.,0.));
#80=IFCBUILDINGELEMENTPROXY('a2',$,'A2','',$,#70,#81,$,$);
#81=IFCPRODUCTDEFINITIONSHAPE($,$,(#82));
#82=IFCSHAPEREPRESENTATION(#12,'Body','Brep',(#83));
#83=IFCFACETEDBREP(#84);
#84=IFCCLOSEDSHELL((#85));
#85=IFCFACE((#86));
#86=IFCFACEOUTERBOUND(#87,.T.);
#87=IFCPOLYLOOP((#88,#89,#90));
#88=IFCCARTESIANPOINT((0.,0.,0.));
#89=IFCCARTESIANPOINT((1.,0.,0.));
#90=IFCCARTESIANPOINT((0.,1.,0.));
#100=IFCLOCALPLACEMENT($,#101);
#101=IFCAXIS2PLACEMENT3D(#102,$,$);
#102=IFCCARTESIANPOINT((0.,10.,0.));
#110=IFCBUILDINGELEMENTPROXY('b',$,'B','',$,#100,#111,$,$);
#111=IFCPRODUCTDEFINITIONSHAPE($,$,(#112));
#112=IFCSHAPEREPRESENTATION(#12,'Body','Brep',(#113));
#113=IFCFACETEDBREP(#114);
#114=IFCCLOSEDSHELL((#115));
#115=IFCFACE((#116));
#116=IFCFACEOUTERBOUND(#117,.T.);
#117=IFCPOLYLOOP((#118,#119,#120));
#118=IFCCARTESIANPOINT((0.,0.,0.));
#119=IFCCARTESIANPOINT((2.,0.,0.));
#120=IFCCARTESIANPOINT((0.,2.,0.));
ENDSEC;
END-ISO-10303-21;
"#
    .to_string()
}

/// A single cylinder (circle-profile extrusion) — curved, so its triangle count
/// scales with tessellation quality.
fn curved_extrusion_ifc() -> String {
    r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('curve.ifc','2025-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('proj',$,'P','',$,$,$,(#12),#7);
#7=IFCUNITASSIGNMENT((#8));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#12=IFCGEOMETRICREPRESENTATIONCONTEXT('3D','Model',3,1.E-6,#14,$);
#14=IFCAXIS2PLACEMENT3D(#15,$,$);
#15=IFCCARTESIANPOINT((0.,0.,0.));
#40=IFCLOCALPLACEMENT($,#41);
#41=IFCAXIS2PLACEMENT3D(#42,$,$);
#42=IFCCARTESIANPOINT((0.,0.,0.));
#50=IFCBUILDINGELEMENTPROXY('c',$,'C','',$,#40,#51,$,$);
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#52));
#52=IFCSHAPEREPRESENTATION(#12,'Body','SweptSolid',(#53));
#53=IFCEXTRUDEDAREASOLID(#54,#57,#60,1.);
#54=IFCCIRCLEPROFILEDEF(.AREA.,$,#55,0.5);
#55=IFCAXIS2PLACEMENT2D(#56,$);
#56=IFCCARTESIANPOINT((0.,0.));
#57=IFCAXIS2PLACEMENT3D(#58,$,$);
#58=IFCCARTESIANPOINT((0.,0.,0.));
#60=IFCDIRECTION((0.,0.,1.));
ENDSEC;
END-ISO-10303-21;
"#
    .to_string()
}

/// CI guard for #976 × dedup: the shared cache persists across
/// `setTessellationQuality` changes, so the cache KEY must fold in the quality —
/// otherwise the first-meshed quality is served for every later one. Two routers
/// sharing ONE cache at different qualities must still tessellate the curve
/// differently.
#[test]
fn content_dedup_keys_on_tessellation_quality() {
    use ifc_lite_geometry::TessellationQuality;
    let content = curved_extrusion_ifc();
    let cache = GeometryRouter::new_dedup_cache();

    let tris = |quality: TessellationQuality| -> usize {
        let mut d = EntityDecoder::with_index(&content, build_entity_index(&content));
        let mut r = GeometryRouter::with_scale_and_quality(1.0, quality);
        r.enable_content_dedup_shared(cache.clone()); // SAME cache across qualities
        let e = d.decode_by_id(50).expect("decode element");
        let sm = r
            .process_element_with_submeshes(&e, &mut d)
            .expect("mesh element");
        sm.sub_meshes.iter().map(|s| s.mesh.indices.len() / 3).sum()
    };

    let low = tris(TessellationQuality::Lowest);
    let high = tris(TessellationQuality::Highest);
    assert!(low > 0 && high > 0, "curved extrusion produced no geometry");
    assert!(
        high > low,
        "higher quality must tessellate finer despite the shared dedup cache (low={low}, high={high})"
    );
}

/// CI guard (no external fixture): content-dedup must produce BYTE-IDENTICAL
/// geometry to the non-deduped path, collapse structurally-identical items to one
/// cached mesh, and keep placement per-instance.
#[test]
fn content_dedup_byte_identical_on_synthetic_duplicates() {
    let content = synthetic_duplicates_ifc();
    let ids = [50u32, 80, 110];

    // ON: content-dedup armed via with_units.
    let mut d_on = EntityDecoder::with_index(&content, build_entity_index(&content));
    let on_router = GeometryRouter::with_units(&content, &mut d_on);
    let mut on = Vec::new();
    for &id in &ids {
        let e = d_on.decode_by_id(id).expect("decode element");
        let sm = on_router
            .process_element_with_submeshes(&e, &mut d_on)
            .expect("mesh element");
        assert!(!sm.sub_meshes.is_empty(), "element #{id} produced no geometry");
        on.push(fingerprint(&sm));
    }
    // #50 and #80 share one structural hash; #110 is distinct ⇒ 2 unique meshes.
    assert_eq!(
        on_router.dedup_unique_count(),
        2,
        "expected exactly 2 unique item meshes (2 duplicates collapse to 1)"
    );

    // OFF: same router family, dedup disabled ⇒ every element rebuilt.
    let mut d_off = EntityDecoder::with_index(&content, build_entity_index(&content));
    let mut off_router = GeometryRouter::with_units(&content, &mut d_off);
    off_router.disable_content_dedup();
    let mut off = Vec::new();
    for &id in &ids {
        let e = d_off.decode_by_id(id).expect("decode element");
        let sm = off_router
            .process_element_with_submeshes(&e, &mut d_off)
            .expect("mesh element");
        off.push(fingerprint(&sm));
    }

    assert_eq!(on, off, "deduped geometry differs from the freshly-built geometry");
    // The two duplicate instances are at different placements, so their world
    // meshes — and thus fingerprints — must differ: placement stays per-instance.
    assert_ne!(on[0], on[1], "per-instance placement was lost to the shared cache");
}

#[test]
#[ignore = "manual; needs IFCLT_MODEL"]
fn dedup_byte_identical_and_faster() {
    let path = match std::env::var("IFCLT_MODEL") {
        Ok(p) => p,
        Err(_) => {
            println!("set IFCLT_MODEL=/abs/path.ifc");
            return;
        }
    };
    let content = std::fs::read_to_string(&path).expect("read model");
    println!("\n=== content-dedup A/B (submesh path) ===");
    println!("model: {path}  ({} bytes)", content.len());

    let void_idx = build_void_index(&content);
    let products = list_products(&content);
    println!("products: {}  (voided hosts: {})\n", products.len(), void_idx.len());

    // --- OFF: ground truth, rebuilds every element ---
    let off_router = {
        let mut d = EntityDecoder::with_index(&content, build_entity_index(&content));
        let mut r = GeometryRouter::with_units(&content, &mut d);
        r.disable_content_dedup();
        r
    };
    let (off_fps, off_tris, off_ms) =
        run(&off_router, &products, &void_idx, &content, build_entity_index(&content));
    println!("OFF (no dedup): {off_ms:.0}ms  tris={off_tris}");

    // --- ON: content-dedup armed ---
    let on_router = {
        let mut d = EntityDecoder::with_index(&content, build_entity_index(&content));
        GeometryRouter::with_units(&content, &mut d)
    };
    let (on_fps, on_tris, on_ms) =
        run(&on_router, &products, &void_idx, &content, build_entity_index(&content));
    println!(
        "ON  (dedup):    {on_ms:.0}ms  tris={on_tris}  unique-geometries={}",
        on_router.dedup_unique_count()
    );

    let speedup = if on_ms > 0.0 { off_ms / on_ms } else { 0.0 };
    println!("\nspeedup: {speedup:.1}x   ({off_ms:.0}ms → {on_ms:.0}ms)");

    // --- correctness: per-element fingerprints must be byte-identical ---
    assert_eq!(off_fps.len(), on_fps.len(), "element count diverged ON vs OFF");
    let mut mismatches = 0usize;
    for ((off_id, off_fp), (on_id, on_fp)) in off_fps.iter().zip(on_fps.iter()) {
        assert_eq!(off_id, on_id, "element order diverged");
        if off_fp != on_fp {
            if mismatches < 10 {
                println!("  MISMATCH element #{off_id}: off={off_fp:x} on={on_fp:x}");
            }
            mismatches += 1;
        }
    }
    println!(
        "fingerprint mismatches: {mismatches} / {} elements",
        off_fps.len()
    );
    assert_eq!(on_tris, off_tris, "triangle totals diverged ON vs OFF");
    assert_eq!(mismatches, 0, "content-dedup produced different geometry");
    println!("✓ dedup is byte-identical to the non-deduped path");
}

/// Two geometrically-IDENTICAL voided walls (same 2x0.3x3 swept section, same
/// 0.5x0.5x1 opening at the same wall-relative offset) at DIFFERENT placements,
/// plus a third wall with a DISTINCT (0.8x0.8) opening. Exercises the VOID path
/// (`process_element_with_submeshes_and_voids`), which the calibration snapshot
/// harness (`process_element` only) cannot see — the parity gate for the
/// element-level void-cut dedup work (#1286).
fn synthetic_voided_duplicates_ifc() -> String {
    r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('voided.ifc','2025-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('proj',$,'P','',$,$,$,(#12),#7);
#7=IFCUNITASSIGNMENT((#8));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#12=IFCGEOMETRICREPRESENTATIONCONTEXT('3D','Model',3,1.E-6,#14,$);
#14=IFCAXIS2PLACEMENT3D(#15,$,$);
#15=IFCCARTESIANPOINT((0.,0.,0.));
#40=IFCLOCALPLACEMENT($,#41);
#41=IFCAXIS2PLACEMENT3D(#42,$,$);
#42=IFCCARTESIANPOINT((0.,0.,0.));
#50=IFCWALL('w1',$,'W1','',$,#40,#51,$,$);
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#52));
#52=IFCSHAPEREPRESENTATION(#12,'Body','SweptSolid',(#53));
#53=IFCEXTRUDEDAREASOLID(#54,#57,#60,3.);
#54=IFCRECTANGLEPROFILEDEF(.AREA.,$,#55,2.,0.3);
#55=IFCAXIS2PLACEMENT2D(#56,$);
#56=IFCCARTESIANPOINT((0.,0.));
#57=IFCAXIS2PLACEMENT3D(#58,$,$);
#58=IFCCARTESIANPOINT((0.,0.,0.));
#60=IFCDIRECTION((0.,0.,1.));
#140=IFCLOCALPLACEMENT($,#141);
#141=IFCAXIS2PLACEMENT3D(#142,$,$);
#142=IFCCARTESIANPOINT((0.,0.,1.));
#150=IFCOPENINGELEMENT('o1',$,'O1','',$,#140,#151,$,$);
#151=IFCPRODUCTDEFINITIONSHAPE($,$,(#152));
#152=IFCSHAPEREPRESENTATION(#12,'Body','SweptSolid',(#153));
#153=IFCEXTRUDEDAREASOLID(#154,#157,#160,1.);
#154=IFCRECTANGLEPROFILEDEF(.AREA.,$,#155,0.5,0.5);
#155=IFCAXIS2PLACEMENT2D(#156,$);
#156=IFCCARTESIANPOINT((0.,0.));
#157=IFCAXIS2PLACEMENT3D(#158,$,$);
#158=IFCCARTESIANPOINT((0.,0.,0.));
#160=IFCDIRECTION((0.,0.,1.));
#201=IFCRELVOIDSELEMENT('rv1',$,$,$,#50,#150);
#240=IFCLOCALPLACEMENT($,#241);
#241=IFCAXIS2PLACEMENT3D(#242,$,$);
#242=IFCCARTESIANPOINT((10.,0.,0.));
#250=IFCWALL('w2',$,'W2','',$,#240,#251,$,$);
#251=IFCPRODUCTDEFINITIONSHAPE($,$,(#252));
#252=IFCSHAPEREPRESENTATION(#12,'Body','SweptSolid',(#253));
#253=IFCEXTRUDEDAREASOLID(#254,#257,#260,3.);
#254=IFCRECTANGLEPROFILEDEF(.AREA.,$,#255,2.,0.3);
#255=IFCAXIS2PLACEMENT2D(#256,$);
#256=IFCCARTESIANPOINT((0.,0.));
#257=IFCAXIS2PLACEMENT3D(#258,$,$);
#258=IFCCARTESIANPOINT((0.,0.,0.));
#260=IFCDIRECTION((0.,0.,1.));
#340=IFCLOCALPLACEMENT($,#341);
#341=IFCAXIS2PLACEMENT3D(#342,$,$);
#342=IFCCARTESIANPOINT((10.,0.,1.));
#350=IFCOPENINGELEMENT('o2',$,'O2','',$,#340,#351,$,$);
#351=IFCPRODUCTDEFINITIONSHAPE($,$,(#352));
#352=IFCSHAPEREPRESENTATION(#12,'Body','SweptSolid',(#353));
#353=IFCEXTRUDEDAREASOLID(#354,#357,#360,1.);
#354=IFCRECTANGLEPROFILEDEF(.AREA.,$,#355,0.5,0.5);
#355=IFCAXIS2PLACEMENT2D(#356,$);
#356=IFCCARTESIANPOINT((0.,0.));
#357=IFCAXIS2PLACEMENT3D(#358,$,$);
#358=IFCCARTESIANPOINT((0.,0.,0.));
#360=IFCDIRECTION((0.,0.,1.));
#202=IFCRELVOIDSELEMENT('rv2',$,$,$,#250,#350);
#440=IFCLOCALPLACEMENT($,#441);
#441=IFCAXIS2PLACEMENT3D(#442,$,$);
#442=IFCCARTESIANPOINT((0.,10.,0.));
#450=IFCWALL('w3',$,'W3','',$,#440,#451,$,$);
#451=IFCPRODUCTDEFINITIONSHAPE($,$,(#452));
#452=IFCSHAPEREPRESENTATION(#12,'Body','SweptSolid',(#453));
#453=IFCEXTRUDEDAREASOLID(#454,#457,#460,3.);
#454=IFCRECTANGLEPROFILEDEF(.AREA.,$,#455,2.,0.3);
#455=IFCAXIS2PLACEMENT2D(#456,$);
#456=IFCCARTESIANPOINT((0.,0.));
#457=IFCAXIS2PLACEMENT3D(#458,$,$);
#458=IFCCARTESIANPOINT((0.,0.,0.));
#460=IFCDIRECTION((0.,0.,1.));
#540=IFCLOCALPLACEMENT($,#541);
#541=IFCAXIS2PLACEMENT3D(#542,$,$);
#542=IFCCARTESIANPOINT((0.,10.,1.));
#550=IFCOPENINGELEMENT('o3',$,'O3','',$,#540,#551,$,$);
#551=IFCPRODUCTDEFINITIONSHAPE($,$,(#552));
#552=IFCSHAPEREPRESENTATION(#12,'Body','SweptSolid',(#553));
#553=IFCEXTRUDEDAREASOLID(#554,#557,#560,1.);
#554=IFCRECTANGLEPROFILEDEF(.AREA.,$,#555,0.8,0.8);
#555=IFCAXIS2PLACEMENT2D(#556,$);
#556=IFCCARTESIANPOINT((0.,0.));
#557=IFCAXIS2PLACEMENT3D(#558,$,$);
#558=IFCCARTESIANPOINT((0.,0.,0.));
#560=IFCDIRECTION((0.,0.,1.));
#203=IFCRELVOIDSELEMENT('rv3',$,$,$,#450,#550);
ENDSEC;
END-ISO-10303-21;
"#
    .to_string()
}

/// CI parity gate (#1286): content-dedup must be BYTE-IDENTICAL to the
/// non-deduped path through the VOID submesh path, keep placement per-instance,
/// and keep a distinct void distinct. Guards the element-level void-cut dedup.
#[test]
fn content_dedup_byte_identical_on_voided_duplicates() {
    let content = synthetic_voided_duplicates_ifc();
    let wall_ids = [50u32, 250, 450];
    let void_idx = build_void_index(&content);
    // every wall must actually carry a void, else the path under test is skipped.
    for id in &wall_ids {
        assert!(
            void_idx.get(id).map(|v| !v.is_empty()).unwrap_or(false),
            "wall #{id} has no void in the index"
        );
    }

    let run_path = |dedup: bool| -> Vec<u64> {
        let mut d = EntityDecoder::with_index(&content, build_entity_index(&content));
        let mut router = GeometryRouter::with_units(&content, &mut d);
        if !dedup {
            router.disable_content_dedup();
        }
        wall_ids
            .iter()
            .map(|&id| {
                let e = d.decode_by_id(id).expect("decode wall");
                let sm = router
                    .process_element_with_submeshes_and_voids(&e, &mut d, &void_idx)
                    .expect("void mesh");
                assert!(!sm.sub_meshes.is_empty(), "wall #{id} produced no voided geometry");
                fingerprint(&sm)
            })
            .collect()
    };

    let on = run_path(true);
    let off = run_path(false);

    assert_eq!(
        on, off,
        "void-path content-dedup geometry differs from the freshly-built path"
    );
    // walls 1 and 2 are geometrically identical but at different placements:
    // their WORLD fingerprints must differ (placement stays per-instance).
    assert_ne!(on[0], on[1], "per-instance placement was lost on the void path");
    // wall 3 has a distinct opening: it must not collapse into the duplicates.
    assert_ne!(on[0], on[2], "a distinct void wrongly matched the duplicates");
}

/// Two identical IfcTriangulatedFaceSet proxies at different placements + one
/// distinct, to validate the flagged EXTRA-type dedup (Phase 3 / #1286): with the
/// flag ON the duplicates must collapse to one cached item and stay byte-identical
/// to the freshly-built path.
fn synthetic_faceset_duplicates_ifc() -> String {
    r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('fs.ifc','2025-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('proj',$,'P','',$,$,$,(#12),#7);
#7=IFCUNITASSIGNMENT((#8));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#12=IFCGEOMETRICREPRESENTATIONCONTEXT('3D','Model',3,1.E-6,#14,$);
#14=IFCAXIS2PLACEMENT3D(#15,$,$);
#15=IFCCARTESIANPOINT((0.,0.,0.));
#40=IFCLOCALPLACEMENT($,#41);
#41=IFCAXIS2PLACEMENT3D(#42,$,$);
#42=IFCCARTESIANPOINT((0.,0.,0.));
#50=IFCBUILDINGELEMENTPROXY('a1',$,'A1','',$,#40,#51,$,$);
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#52));
#52=IFCSHAPEREPRESENTATION(#12,'Body','Tessellation',(#53));
#53=IFCTRIANGULATEDFACESET(#54,$,$,((1,2,3),(1,3,4)),$);
#54=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(1.,1.,0.),(0.,1.,0.)));
#70=IFCLOCALPLACEMENT($,#71);
#71=IFCAXIS2PLACEMENT3D(#72,$,$);
#72=IFCCARTESIANPOINT((10.,0.,0.));
#80=IFCBUILDINGELEMENTPROXY('a2',$,'A2','',$,#70,#81,$,$);
#81=IFCPRODUCTDEFINITIONSHAPE($,$,(#82));
#82=IFCSHAPEREPRESENTATION(#12,'Body','Tessellation',(#83));
#83=IFCTRIANGULATEDFACESET(#84,$,$,((1,2,3),(1,3,4)),$);
#84=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(1.,1.,0.),(0.,1.,0.)));
#100=IFCLOCALPLACEMENT($,#101);
#101=IFCAXIS2PLACEMENT3D(#102,$,$);
#102=IFCCARTESIANPOINT((0.,10.,0.));
#110=IFCBUILDINGELEMENTPROXY('b',$,'B','',$,#100,#111,$,$);
#111=IFCPRODUCTDEFINITIONSHAPE($,$,(#112));
#112=IFCSHAPEREPRESENTATION(#12,'Body','Tessellation',(#113));
#113=IFCTRIANGULATEDFACESET(#114,$,$,((1,2,3),(1,3,4)),$);
#114=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(2.,0.,0.),(2.,2.,0.),(0.,2.,0.)));
ENDSEC;
END-ISO-10303-21;
"#
    .to_string()
}

/// RAII scope for the process-global dedup-extra override
/// (`GeometryRouter::set_build_dedup_extra_override`): serializes every test
/// that forces the override (a static mutex held for the guard's lifetime, so
/// two such tests can't interleave under the parallel test runner) and restores
/// the env-default (`None`) on drop, INCLUDING on a panicking assert, so a
/// failure can't leak the forced state into later tests. `None` is the correct
/// restore value (not a saved snapshot): the only writers are guard scopes, so
/// outside any scope the override is always at its env-default.
struct DedupExtraOverrideGuard {
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl DedupExtraOverrideGuard {
    fn set(v: bool) -> Self {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        GeometryRouter::set_build_dedup_extra_override(Some(v));
        Self { _lock: lock }
    }
}

impl Drop for DedupExtraOverrideGuard {
    fn drop(&mut self) {
        GeometryRouter::set_build_dedup_extra_override(None);
    }
}

#[test]
fn content_dedup_extra_facesets_byte_identical_when_flagged() {
    let content = synthetic_faceset_duplicates_ifc();
    let ids = [50u32, 80, 110];

    // Flag ON: faceset items become dedup candidates. Guard restores the
    // env-default override on every exit path (assert panics included).
    let _extra_on = DedupExtraOverrideGuard::set(true);
    let mut d_on = EntityDecoder::with_index(&content, build_entity_index(&content));
    let on_router = GeometryRouter::with_units(&content, &mut d_on);
    let mut on = Vec::new();
    for &id in &ids {
        let e = d_on.decode_by_id(id).expect("decode element");
        let sm = on_router
            .process_element_with_submeshes(&e, &mut d_on)
            .expect("mesh element");
        assert!(!sm.sub_meshes.is_empty(), "element #{id} produced no geometry");
        on.push(fingerprint(&sm));
    }
    let unique_on = on_router.dedup_unique_count();

    // Ground truth: dedup fully disabled ⇒ every faceset rebuilt (the override
    // value is irrelevant on this path, so the guard can stay in scope).
    let mut d_off = EntityDecoder::with_index(&content, build_entity_index(&content));
    let mut off_router = GeometryRouter::with_units(&content, &mut d_off);
    off_router.disable_content_dedup();
    let mut off = Vec::new();
    for &id in &ids {
        let e = d_off.decode_by_id(id).expect("decode element");
        let sm = off_router
            .process_element_with_submeshes(&e, &mut d_off)
            .expect("mesh element");
        off.push(fingerprint(&sm));
    }

    assert_eq!(on, off, "extra-type (faceset) dedup is not byte-identical to fresh build");
    assert_ne!(on[0], on[1], "per-instance placement lost on the extra-type path");
    assert_eq!(unique_on, 2, "the two identical facesets must collapse to 1 (+1 distinct = 2)");
}
