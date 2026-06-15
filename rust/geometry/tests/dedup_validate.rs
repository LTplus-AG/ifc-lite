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
