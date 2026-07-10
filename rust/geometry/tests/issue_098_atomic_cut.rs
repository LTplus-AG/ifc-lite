// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #098, ATOMIC kernel repro: a clean box host minus ONE extended
//! faceted-BREP window cutter (captured from the Poroton wall's local-frame
//! cut). `ClippingProcessor::subtract_mesh` leaves the result NON-watertight —
//! the exact mesh-arrangement kernel drops constraint sub-segments it cannot
//! force as CDT edges, so the wall's big face triangle stays un-split and its
//! edge is left unpaired. This is the true root of the visible tear; the fix
//! lives in `kernel/retriangulate.rs` constraint recovery.

use ifc_lite_geometry::{ClippingProcessor, Mesh};

fn parse_mesh(json: &str) -> Mesh {
    fn nums(s: &str, key: &str) -> (usize, usize) {
        let k = s.find(key).unwrap() + key.len();
        let lo = s[k..].find('[').unwrap() + k + 1;
        let hi = s[lo..].find(']').unwrap() + lo;
        (lo, hi)
    }
    let (pl, ph) = nums(json, "\"positions\":");
    let positions: Vec<f32> = json[pl..ph]
        .split(',')
        .filter(|t| !t.trim().is_empty())
        .map(|t| t.trim().parse().unwrap())
        .collect();
    let (il, ih) = nums(json, "\"indices\":");
    let indices: Vec<u32> = json[il..ih]
        .split(',')
        .filter(|t| !t.trim().is_empty())
        .map(|t| t.trim().parse().unwrap())
        .collect();
    Mesh {
        positions,
        normals: Vec::new(),
        indices,
        rtc_applied: false,
        origin: [0.0; 3],
        instance_meta: None,
        local_bounds: None,
        local_to_world: None,
    }
}

/// Unpaired directed edges on a 0.1 mm weld grid. 0 => watertight.
fn open_edges(m: &Mesh) -> i64 {
    use std::collections::HashMap;
    let q = |i: u32| {
        let b = i as usize * 3;
        (
            (m.positions[b] * 1.0e4).round() as i64,
            (m.positions[b + 1] * 1.0e4).round() as i64,
            (m.positions[b + 2] * 1.0e4).round() as i64,
        )
    };
    let mut e: HashMap<((i64, i64, i64), (i64, i64, i64)), i64> = HashMap::new();
    for t in m.indices.chunks_exact(3) {
        let k = [q(t[0]), q(t[1]), q(t[2])];
        for (u, v) in [(0, 1), (1, 2), (2, 0)] {
            *e.entry((k[u], k[v])).or_insert(0) += 1;
            *e.entry((k[v], k[u])).or_insert(0) -= 1;
        }
    }
    e.values().map(|c| c.abs()).sum()
}

#[test]
fn atomic_box_minus_reveal_cutter_is_watertight() {
    let host = parse_mesh(include_str!("fixtures/issue_098_atomic_host.json"));
    let cutter = parse_mesh(include_str!("fixtures/issue_098_atomic_cutter.json"));
    assert_eq!(open_edges(&host), 0, "host box must be watertight");
    assert_eq!(open_edges(&cutter), 0, "cutter must be watertight");

    let clipper = ClippingProcessor::new();
    let result = clipper.subtract_mesh(&host, &cutter).expect("subtract");
    let oe = open_edges(&result);
    println!(
        "[#098 atomic] host={} cutter={} result={} openEdges={}",
        host.indices.len() / 3,
        cutter.indices.len() / 3,
        result.indices.len() / 3,
        oe
    );
    // Dump the boundary-edge locations to correlate with cutter features.
    if std::env::var("DUMP_OE").is_ok() {
        use std::collections::HashMap;
        let q = |i: u32| {
            let b = i as usize * 3;
            (
                (result.positions[b] * 1.0e4).round() as i64,
                (result.positions[b + 1] * 1.0e4).round() as i64,
                (result.positions[b + 2] * 1.0e4).round() as i64,
            )
        };
        let mut e: HashMap<((i64, i64, i64), (i64, i64, i64)), i64> = HashMap::new();
        for t in result.indices.chunks_exact(3) {
            let k = [q(t[0]), q(t[1]), q(t[2])];
            for (u, v) in [(0, 1), (1, 2), (2, 0)] {
                *e.entry((k[u], k[v])).or_insert(0) += 1;
                *e.entry((k[v], k[u])).or_insert(0) -= 1;
            }
        }
        let mut bnd: Vec<_> = e.iter().filter(|(_, &c)| c > 0).collect();
        bnd.sort_by_key(|(k, _)| (k.0 .0, k.0 .1, k.0 .2));
        for (k, _) in bnd.iter().take(40) {
            let a = k.0;
            let b = k.1;
            let len = (((a.0 - b.0).pow(2) + (a.1 - b.1).pow(2) + (a.2 - b.2).pow(2)) as f64)
                .sqrt()
                / 1.0e4;
            println!(
                "[#098 oe] ({:.3},{:.3},{:.3})->({:.3},{:.3},{:.3}) len={:.3}",
                a.0 as f64 / 1e4, a.1 as f64 / 1e4, a.2 as f64 / 1e4,
                b.0 as f64 / 1e4, b.1 as f64 / 1e4, b.2 as f64 / 1e4, len
            );
        }
    }
    assert_eq!(oe, 0, "box minus one reveal cutter must stay watertight");
}
