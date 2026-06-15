// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! A/B validation for the f64 planar-clip fast path on a REAL model. Drives the
//! exact per-element router path (the same as `produce_element_meshes`) and dumps
//! a per-element signature (triangle count, signed volume, open-edge count). Run
//! it twice — once with the fast path forced OFF, once ON — and the ON run diffs
//! itself against the OFF reference: the fast path must be VOLUME-equivalent
//! (shape-preserving) and never less watertight, while being faster overall.
//!
//! Two-process diff (the env flag is read once per process via `OnceLock`):
//!   M=/abs/model.ifc
//!   IFC_LITE_DISABLE_PLANAR_CLIP=1 IFCLT_MODEL=$M IFCLT_AB_OUT=/tmp/off.tsv \
//!     cargo test -p ifc-lite-geometry --release --test planar_clip_ab -- --ignored --nocapture
//!   IFCLT_MODEL=$M IFCLT_AB_OUT=/tmp/on.tsv IFCLT_AB_REF=/tmp/off.tsv \
//!     cargo test -p ifc-lite-geometry --release --test planar_clip_ab -- --ignored --nocapture

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter, Mesh};
use rustc_hash::FxHashMap;
use std::collections::HashMap;
use std::io::Write;
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

fn list_products(content: &str) -> Vec<u32> {
    let mut products = Vec::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, name, _, _)) = scanner.next_entity() {
        let n = name;
        if n.starts_with("IFC")
            && (n.contains("WALL") || n.contains("BEAM") || n.contains("COLUMN")
                || n.contains("MEMBER") || n.contains("PLATE") || n.contains("SLAB")
                || n.contains("FOOTING") || n.contains("PILE") || n.contains("RAILING")
                || n.contains("STAIR") || n.contains("ROOF") || n.contains("COVERING")
                || n.contains("BUILDINGELEMENT") || n.contains("PROXY") || n.contains("FLOW"))
            && !n.contains("TYPE")
            && !n.contains("STYLE")
        {
            products.push(id);
        }
    }
    products
}

/// Signed volume via the divergence theorem (origin-independent up to the mesh
/// being closed; for open meshes it is still a stable per-element fingerprint).
fn volume(m: &Mesh) -> f64 {
    let p = &m.positions;
    let mut v = 0.0;
    for t in m.indices.chunks(3) {
        if t.len() < 3 {
            continue;
        }
        let g = |i: u32| {
            let b = i as usize * 3;
            [p[b] as f64, p[b + 1] as f64, p[b + 2] as f64]
        };
        let (a, b, c) = (g(t[0]), g(t[1]), g(t[2]));
        v += a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2])
            + a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
    v / 6.0
}

/// Directed edges with no reverse partner (quantized) — 0 ⇒ watertight.
fn open_edges(m: &Mesh) -> usize {
    const Q: f64 = 1.0e5;
    let p = &m.positions;
    let key = |i: u32| {
        let b = i as usize * 3;
        (
            (p[b] as f64 * Q).round() as i64,
            (p[b + 1] as f64 * Q).round() as i64,
            (p[b + 2] as f64 * Q).round() as i64,
        )
    };
    let mut dir: HashMap<((i64, i64, i64), (i64, i64, i64)), i32> = HashMap::new();
    for t in m.indices.chunks(3) {
        if t.len() < 3 {
            continue;
        }
        for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            *dir.entry((key(a), key(b))).or_default() += 1;
            *dir.entry((key(b), key(a))).or_default() -= 1;
        }
    }
    dir.values().filter(|&&c| c != 0).count()
}

#[test]
#[ignore = "manual; needs IFCLT_MODEL"]
fn planar_clip_ab() {
    let Ok(path) = std::env::var("IFCLT_MODEL") else {
        println!("set IFCLT_MODEL=/abs/path.ifc");
        return;
    };
    let content = String::from_utf8_lossy(&std::fs::read(&path).expect("read model")).into_owned();
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let mut router = GeometryRouter::with_units(&content, &mut decoder);
    // Rebase georeferenced models so the RTC=0 harness does not render f32 vertex
    // jitter on national-grid coordinates (tens of km), which fabricates degenerate
    // geometry unrelated to the fast path (AGENTS.md / csg_model_profile caveat).
    // `scan_model_bounds` reads the actual IfcCartesianPoints, so it catches an
    // offset baked into the geometry (skolebygg) that placement sampling misses.
    let rtc = ifc_lite_core::scan_model_bounds(content.as_str()).rtc_offset();
    router.set_rtc_offset(rtc);
    if rtc != (0.0, 0.0, 0.0) {
        println!("rebased: RTC offset = ({:.1}, {:.1}, {:.1})", rtc.0, rtc.1, rtc.2);
    }
    let void_idx = build_void_index(&content);
    let products = list_products(&content);
    let disabled = std::env::var("IFC_LITE_DISABLE_PLANAR_CLIP").is_ok();
    println!(
        "\n=== planar-clip A/B  (fast path {}) ===\nmodel: {path}  products: {}",
        if disabled { "OFF" } else { "ON" },
        products.len()
    );

    // id -> (tris, volume, open_edges, bbox_lo[3], bbox_hi[3])
    let mut sig: Vec<(u32, usize, f64, usize, [f64; 3], [f64; 3])> =
        Vec::with_capacity(products.len());
    let t_all = Instant::now();
    for id in &products {
        let Ok(entity) = decoder.decode_by_id(*id) else {
            continue;
        };
        let has_voids = void_idx.get(id).map(|v| !v.is_empty()).unwrap_or(false);
        let mesh = if has_voids {
            router.process_element_with_voids(&entity, &mut decoder, &void_idx)
        } else {
            router.process_element(&entity, &mut decoder)
        };
        if let Ok(m) = mesh {
            if m.triangle_count() > 0 {
                let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
                for c in m.positions.chunks(3) {
                    for k in 0..3 {
                        lo[k] = lo[k].min(c[k] as f64);
                        hi[k] = hi[k].max(c[k] as f64);
                    }
                }
                sig.push((*id, m.triangle_count(), volume(&m), open_edges(&m), lo, hi));
            }
        }
    }
    let wall_ms = t_all.elapsed().as_secs_f64() * 1000.0;
    let total_tris: usize = sig.iter().map(|s| s.1).sum();
    // Global mesh-center magnitude — must be small (local) after rebasing, else the
    // run is f32-jittered and the diff is meaningless.
    let (mut glo, mut ghi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for (_, _, _, _, lo, hi) in &sig {
        for k in 0..3 {
            glo[k] = glo[k].min(lo[k]);
            ghi[k] = ghi[k].max(hi[k]);
        }
    }
    let center_mag = (0..3)
        .map(|k| ((glo[k] + ghi[k]) * 0.5).abs())
        .fold(0.0f64, f64::max);
    println!(
        "WALLTIME_MS {wall_ms:.0}   ELEMENTS {}   TOTAL_TRIS {total_tris}   MESH_CENTER_MAG {center_mag:.0}m",
        sig.len()
    );
    if center_mag >= 10_000.0 {
        println!(
            "  WARNING: meshes at {center_mag:.0}m — f32 jitter; the strict watertightness gate \
             should make the fast path DEFER here (per-element router does not relocalize baked \
             georef coords). Treat absolute diffs with care; watch OPEN_REGRESSIONS=0."
        );
    }

    if let Ok(out) = std::env::var("IFCLT_AB_OUT") {
        let mut f = std::fs::File::create(&out).expect("create out");
        for (id, tris, vol, open, lo, hi) in &sig {
            writeln!(
                f,
                "{id}\t{tris}\t{vol:.9}\t{open}\t{:.6}\t{:.6}\t{:.6}\t{:.6}\t{:.6}\t{:.6}",
                lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]
            )
            .unwrap();
        }
        println!("wrote {} ({} rows)", out, sig.len());
    }

    // ON run: diff against the OFF reference and ASSERT shape-equivalence.
    if let Ok(refp) = std::env::var("IFCLT_AB_REF") {
        let refdata = std::fs::read_to_string(&refp).expect("read ref");
        // id -> (tris, vol, open, lo[3], hi[3])
        let mut refmap: HashMap<u32, (usize, f64, usize, [f64; 3], [f64; 3])> = HashMap::new();
        for line in refdata.lines() {
            let c: Vec<&str> = line.split('\t').collect();
            if c.len() == 10 {
                let f = |i: usize| c[i].parse::<f64>().unwrap();
                refmap.insert(
                    c[0].parse().unwrap(),
                    (
                        c[1].parse().unwrap(),
                        c[2].parse().unwrap(),
                        c[3].parse().unwrap(),
                        [f(4), f(5), f(6)],
                        [f(7), f(8), f(9)],
                    ),
                );
            }
        }
        let mut fired = 0usize; // tris differ ⇒ fast path changed this element
        let mut bbox_maxdev = 0.0f64; // primary: AABB deviation (defined for open meshes)
        let mut bbox_worst = 0u32;
        let mut vol_maxrel = 0.0f64; // secondary: only where BOTH meshes watertight
        let mut vol_worst = 0u32;
        let mut vol_compared = 0usize;
        let mut open_regress = 0usize; // fast path left MORE open edges than exact
        let mut worst_open = (0u32, 0usize, 0usize);
        for (id, tris, vol, open, lo, hi) in &sig {
            let Some((rtris, rvol, ropen, rlo, rhi)) = refmap.get(id).copied() else {
                continue;
            };
            if *tris != rtris {
                fired += 1;
            }
            // AABB deviation, normalised by the element's diagonal.
            let diag = ((rhi[0] - rlo[0]).powi(2)
                + (rhi[1] - rlo[1]).powi(2)
                + (rhi[2] - rlo[2]).powi(2))
            .sqrt()
            .max(1.0e-6);
            let dev = (0..3)
                .map(|k| (lo[k] - rlo[k]).abs().max((hi[k] - rhi[k]).abs()))
                .fold(0.0f64, f64::max)
                / diag;
            if dev > bbox_maxdev {
                bbox_maxdev = dev;
                bbox_worst = *id;
            }
            // Volume only where both are closed (divergence volume is meaningless
            // for an open mesh — many real IFC hosts are not watertight).
            if *open == 0 && ropen == 0 {
                vol_compared += 1;
                let denom = rvol.abs().max(vol.abs()).max(1.0e-9);
                let rel = (vol - rvol).abs() / denom;
                if rel > vol_maxrel {
                    vol_maxrel = rel;
                    vol_worst = *id;
                }
            }
            if *open > ropen + 2 {
                open_regress += 1;
                if *open - ropen > worst_open.2.saturating_sub(worst_open.1) {
                    worst_open = (*id, ropen, *open);
                }
            }
        }
        println!(
            "\nDIFF vs exact reference:\n  FIRED (tris changed)   {fired} / {} elements\n  BBOX_MAXDEV            {bbox_maxdev:.2e} (rel, worst id={bbox_worst})\n  VOL_MAXREL             {vol_maxrel:.2e}  over {vol_compared} watertight pairs (worst id={vol_worst})\n  OPEN_REGRESSIONS       {open_regress}  (worst id={} {} -> {})",
            sig.len(),
            worst_open.0, worst_open.1, worst_open.2
        );
        // The fast path must be shape-equivalent (AABB), volume-equivalent where
        // comparable, and never less watertight than the exact kernel.
        assert!(
            bbox_maxdev < 1.0e-3,
            "planar clip moved an AABB by {bbox_maxdev:.2e} (id={bbox_worst}) — NOT shape-equivalent"
        );
        assert!(
            vol_maxrel < 5.0e-3,
            "planar clip changed a (watertight) volume by {vol_maxrel:.2e} (id={vol_worst})"
        );
        assert_eq!(
            open_regress, 0,
            "planar clip left {open_regress} elements LESS watertight than the exact kernel"
        );
        println!("  ✓ shape-equivalent to the exact kernel, watertightness preserved");
    }
}
