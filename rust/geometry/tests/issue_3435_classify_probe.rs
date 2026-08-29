// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Ad hoc probe for issue #3435: classify EVERY torn host in ISSUE_068
//! (`ISSUE_068_ARK_NUS_skolebygg.ifc`) by (a) whether it was cut via the
//! analytic prism fast path or the general/exact kernel, and (b) whether its
//! open edges form a T-junction (collinear, a long edge covered by shorter
//! sub-edges on the same supporting line) — the mechanism root-caused for
//! host #628727 — or something else.
//!
//! ## The collinear-merge failure mode (and its fix)
//!
//! The first version of this classifier clustered open edges by
//! collinearity alone (point-to-line distance, see `DIST_TOL` below) with
//! no bound on how far apart two collinear edges could sit. That is wrong:
//! a wall produces many co-linear open edges at the same height along its
//! *entire* length, so "on the same line" does not mean "part of the same
//! tear". On host `#144568` this merged two unrelated tears at two
//! different doorways — collinear because both doorways sit on the same
//! wall centreline, but separated by a real 1.07 m run of intact wall
//! between them — into one phantom cluster. That cluster then showed a
//! spurious `overlap_slack` (the two doorways' sub-edge intervals, projected
//! onto the shared line, look like they double-cover part of the span) that
//! obscured the real per-doorway coverage question and could just as easily
//! have flipped a "not covered" verdict into a false "covered" one for a
//! different edge layout.
//!
//! The fix (`split_by_proximity` below) is a second pass, after collinear
//! clustering, that further splits a line-cluster wherever two consecutive
//! edges' projected intervals are separated by more than `GAP_TOL`. Every
//! genuine within-tear gap observed on this fixture (the sub-edges that
//! legitimately tile one opening's long edge) is 0 or sub-millimetre —
//! f32-mesh-export noise. Every confirmed cross-doorway separation observed
//! (including the `#144568` 1.07 m case) is >= 1 m. `GAP_TOL = 5 cm` sits
//! two orders of magnitude above the noise floor and more than an order of
//! magnitude below the smallest confirmed real separation, so it cannot
//! misclassify either side of that fixture's evidence.
//!
//! Anchors (must hold after the fix): host `#628727` classifies as a
//! T-junction; hosts `#144568` and `#893133` do not.
//!
//! Run (needs `debug_geometry` to read the prism fast-path fire counter):
//!   cargo test -p ifc-lite-geometry --features debug_geometry \
//!     --test issue_3435_classify_probe -- --ignored --nocapture classify_probe

mod census_golden;

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{propagate_voids_to_parts, take_prism_stats, GeometryRouter, Mesh};
use rustc_hash::FxHashMap;

fn crate_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}
fn repo_root() -> std::path::PathBuf {
    crate_dir().join("..").join("..")
}

fn void_index(content: &str) -> FxHashMap<u32, Vec<u32>> {
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

fn process(content: &str, host_id: u32, voids: &FxHashMap<u32, Vec<u32>>) -> Option<Mesh> {
    let ei = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, ei);
    let entity = decoder.decode_by_id(host_id).ok()?;
    let router = GeometryRouter::with_units(content, &mut decoder);
    router.process_element_with_voids(&entity, &mut decoder, voids).ok()
}

/// Returns (unique verts, tris, open-edge endpoint pairs as world coords).
fn open_edges(mesh: &Mesh) -> Vec<((f64, f64, f64), (f64, f64, f64))> {
    let q = |v: f32| (v as f64 * 1.0e3).round() as i64;
    let mut vid: FxHashMap<(i64, i64, i64), u32> = FxHashMap::default();
    let mut pos: Vec<(f64, f64, f64)> = Vec::new();
    let mut id = |i: usize| -> u32 {
        let k = (
            q(mesh.positions[i * 3]),
            q(mesh.positions[i * 3 + 1]),
            q(mesh.positions[i * 3 + 2]),
        );
        if let Some(&existing) = vid.get(&k) {
            return existing;
        }
        let n = vid.len() as u32;
        vid.insert(k, n);
        pos.push((
            mesh.positions[i * 3] as f64,
            mesh.positions[i * 3 + 1] as f64,
            mesh.positions[i * 3 + 2] as f64,
        ));
        n
    };
    let mut uses: FxHashMap<(u32, u32), (u32, u32)> = FxHashMap::default();
    for tri in mesh.indices.chunks_exact(3) {
        let (a, b, c) = (id(tri[0] as usize), id(tri[1] as usize), id(tri[2] as usize));
        if a == b || b == c || c == a {
            continue;
        }
        for (x, y) in [(a, b), (b, c), (c, a)] {
            let e = uses.entry((x.min(y), x.max(y))).or_insert((0, 0));
            if x < y {
                e.0 += 1
            } else {
                e.1 += 1
            }
        }
    }
    let mut out = Vec::new();
    for (&(a, b), &(f, r)) in uses.iter() {
        if f != r {
            out.push((pos[a as usize], pos[b as usize]));
        }
    }
    out
}

fn sub(a: (f64, f64, f64), b: (f64, f64, f64)) -> (f64, f64, f64) {
    (a.0 - b.0, a.1 - b.1, a.2 - b.2)
}
fn norm(a: (f64, f64, f64)) -> f64 {
    (a.0 * a.0 + a.1 * a.1 + a.2 * a.2).sqrt()
}
fn unit(a: (f64, f64, f64)) -> (f64, f64, f64) {
    let n = norm(a);
    if n < 1e-12 {
        (0.0, 0.0, 0.0)
    } else {
        (a.0 / n, a.1 / n, a.2 / n)
    }
}

/// Split one collinear cluster of edge indices into sub-clusters by
/// proximity along the shared line: two edges stay together only while the
/// gap between their projected intervals is <= `gap_tol`. See the module
/// doc for why collinearity alone over-merges (the host `#144568`
/// two-doorway phantom cluster) and why `gap_tol` is safe at any value
/// between the sub-mm noise floor and the >= 1 m confirmed separations.
fn split_by_proximity(
    edges: &[((f64, f64, f64), (f64, f64, f64))],
    group: Vec<usize>,
    gap_tol: f64,
) -> Vec<Vec<usize>> {
    if group.len() <= 1 {
        return vec![group];
    }
    // Reference direction: the longest edge in the group (least sensitive
    // to f32-quantization noise; see the identical rationale in the
    // per-cluster coverage pass below).
    let (long_i, _) = group
        .iter()
        .map(|&i| (i, norm(sub(edges[i].1, edges[i].0))))
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
        .unwrap();
    let (la, lb) = edges[long_i];
    let dir = unit(sub(lb, la));
    let t = |p: (f64, f64, f64)| -> f64 {
        let v = sub(p, la);
        v.0 * dir.0 + v.1 * dir.1 + v.2 * dir.2
    };
    let mut ivals: Vec<(f64, f64, usize)> = group
        .iter()
        .map(|&i| {
            let (a, b) = edges[i];
            let (ta, tb) = (t(a), t(b));
            (ta.min(tb), ta.max(tb), i)
        })
        .collect();
    ivals.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());

    let mut out: Vec<Vec<usize>> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    let mut running_hi = f64::NEG_INFINITY;
    for (lo, hi, idx) in ivals {
        if !current.is_empty() && lo - running_hi > gap_tol {
            out.push(std::mem::take(&mut current));
            running_hi = f64::NEG_INFINITY;
        }
        current.push(idx);
        running_hi = running_hi.max(hi);
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// Classify a set of open edges: T-junction iff every edge's direction is
/// parallel (cross product ~0) to a single common line direction (taken from
/// the longest edge), AND every edge's start point lies on that same line
/// through the longest edge's start point (perpendicular offset ~0).
/// Returns (is_t_junction, detail string).
fn classify_open_edges(edges: &[((f64, f64, f64), (f64, f64, f64))]) -> (bool, String) {
    if edges.is_empty() {
        return (false, "no open edges (should not happen for a torn host)".into());
    }
    // POINT-based collinearity (not direction-vector-based): a T-junction's
    // shortest sub-edge can be sub-millimetre, and dividing its (equally
    // tiny) displacement by its own length amplifies f32-quantization noise
    // into a direction vector that looks nowhere near parallel even though
    // both its endpoints sit exactly on the long edge's line. So: cluster by
    // whether each edge's OWN TWO ENDPOINTS lie on a candidate line (point-
    // to-line distance), anchored on the longest unclustered edge each round
    // (longest edges are the most reliable to derive a direction from).
    const DIST_TOL: f64 = 1e-3; // metres, point-to-line distance tolerance
    // Proximity bound for the interval-adjacency split (see module doc for
    // the phantom-merge failure mode this closes): every genuine
    // within-tear gap on this fixture is 0 or sub-mm, every confirmed
    // cross-doorway separation is >= 1 m, so 5 cm sits comfortably between
    // both without being derivable from either -- it is not tuned to a
    // specific edge, just placed in the two-orders-of-magnitude gap the
    // evidence leaves open.
    const GAP_TOL: f64 = 0.05; // metres

    let mut remaining: Vec<usize> = (0..edges.len()).collect();
    let mut clusters: Vec<Vec<usize>> = Vec::new();
    while !remaining.is_empty() {
        // Anchor = longest remaining edge.
        let (pos, &anchor_i) = remaining
            .iter()
            .enumerate()
            .max_by(|a, b| {
                let la = norm(sub(edges[*a.1].1, edges[*a.1].0));
                let lb = norm(sub(edges[*b.1].1, edges[*b.1].0));
                la.partial_cmp(&lb).unwrap()
            })
            .unwrap();
        remaining.remove(pos);
        let (aa, ab) = edges[anchor_i];
        let dir = unit(sub(ab, aa));
        let mut group = vec![anchor_i];
        remaining.retain(|&i| {
            let (a, b) = edges[i];
            let on_line = |p: (f64, f64, f64)| -> f64 {
                let v = sub(p, aa);
                let proj = v.0 * dir.0 + v.1 * dir.1 + v.2 * dir.2;
                let perp = sub(v, (dir.0 * proj, dir.1 * proj, dir.2 * proj));
                norm(perp)
            };
            if on_line(a) <= DIST_TOL && on_line(b) <= DIST_TOL {
                group.push(i);
                false // consumed
            } else {
                true // keep for a later cluster
            }
        });
        clusters.push(group);
    }

    // Second pass: split each collinear cluster further by proximity along
    // the shared line. Collinearity alone over-merges (see module doc); two
    // edges only belong in the same tear if their projected intervals are
    // within GAP_TOL of touching.
    let mut clusters: Vec<Vec<usize>> = clusters
        .into_iter()
        .flat_map(|g| split_by_proximity(edges, g, GAP_TOL))
        .collect();
    clusters.retain(|g| !g.is_empty());

    // Per cluster: T-junction covering iff the longest edge's length equals
    // the sum of every OTHER edge in the cluster (the sub-edges partition
    // the long edge with no gap/overlap) within LEN_TOL, and the cluster has
    // >= 2 edges (a lone unmatched edge is not "covered" by anything).
    let mut all_covered = true;
    let mut parts = Vec::new();
    for g in &clusters {
        // Identify the longest edge in this cluster and use ITS direction as
        // the line's parametrization axis (most reliable direction, since
        // dividing by a tiny edge's own length amplifies quantization noise
        // -- the reason a global single-reference-line test misfired on
        // #637986's 0.4mm middle segment).
        let (long_i, long_len) = g
            .iter()
            .map(|&i| (i, norm(sub(edges[i].1, edges[i].0))))
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
            .unwrap();
        let (la, lb) = edges[long_i];
        let dir = unit(sub(lb, la));
        let t = |p: (f64, f64, f64)| -> f64 {
            let v = sub(p, la);
            v.0 * dir.0 + v.1 * dir.1 + v.2 * dir.2
        };
        // Full interval = the longest edge's own span (by construction [0, long_len]).
        let mut full_lo = t(la).min(t(lb));
        let mut full_hi = t(la).max(t(lb));
        if full_lo > full_hi {
            std::mem::swap(&mut full_lo, &mut full_hi);
        }
        // Every OTHER edge's interval, merged (sorted + coalesced).
        let mut ivals: Vec<(f64, f64)> = g
            .iter()
            .filter(|&&i| i != long_i)
            .map(|&i| {
                let (a, b) = edges[i];
                let (ta, tb) = (t(a), t(b));
                (ta.min(tb), ta.max(tb))
            })
            .collect();
        ivals.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        let mut merged: Vec<(f64, f64)> = Vec::new();
        let mut overlap_slack = 0.0f64; // total double-covered length (indicates crossing sub-edges)
        for iv in ivals.iter().copied() {
            if let Some(last) = merged.last_mut() {
                if iv.0 <= last.1 + DIST_TOL {
                    if iv.1 < last.1 {
                        overlap_slack += iv.1 - iv.0; // fully engulfed
                    } else {
                        overlap_slack += (last.1 - iv.0).max(0.0);
                    }
                    last.1 = last.1.max(iv.1);
                    continue;
                }
            }
            merged.push(iv);
        }
        let merged_len: f64 = merged.iter().map(|&(a, b)| b - a).sum();
        let sum_others: f64 = ivals.iter().map(|&(a, b)| b - a).sum();
        // Scale-relative tolerance: an absolute 1mm floor is >10% of a
        // sub-cm sliver edge (#640479 has edges of a few mm), so a fixed
        // absolute tolerance would wave through a genuine partial overlap
        // as "noise". Use 2% of the long edge, floored at 0.1mm.
        let rel_tol = (long_len * 0.02).max(1e-4);
        let no_gap = merged.len() == 1
            && (merged[0].0 - full_lo).abs() <= rel_tol
            && (merged[0].1 - full_hi).abs() <= rel_tol;
        let no_overlap = overlap_slack <= rel_tol;
        let covered = g.len() >= 3 && no_gap && no_overlap;
        if !covered {
            all_covered = false;
        }
        parts.push(format!(
            "[{} edges, long={:.4}m, sum_others={:.4}m, merged_len={:.4}m, overlap_slack={:.2e}, {}]",
            g.len(),
            long_len,
            sum_others,
            merged_len,
            overlap_slack,
            if covered { "covered(no-gap,no-overlap)" } else { "NOT covered" }
        ));
    }
    let detail = format!("{} line-cluster(s): {}", clusters.len(), parts.join(" "));
    (all_covered, detail)
}

fn edge_open_count(mesh: &Mesh) -> usize {
    open_edges(mesh).len()
}

/// splitmix64: tiny deterministic PRNG so the ordering-permutation check
/// below is seed-reproducible without pulling in the `rand` crate as a
/// dev-dependency of a `#[ignore]`d probe (same construction as
/// `issue_068_void_ordering_probe.rs`'s `SplitMix64`).
struct SplitMix64(u64);
impl SplitMix64 {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }
    fn shuffle<T>(&mut self, v: &mut [T]) {
        for i in (1..v.len()).rev() {
            let j = (self.next() % (i as u64 + 1)) as usize;
            v.swap(i, j);
        }
    }
}

/// Anchor hosts pinned by the #3435 investigation: `#628727` is the
/// original T-junction reproducer; `#144568` and `#893133` are confirmed
/// NOT T-junctions (see module doc for `#144568`'s phantom-merge history).
const ANCHOR_TJUNCTION: u32 = 628727;
const ANCHOR_NOT_TJUNCTION: [u32; 2] = [144568, 893133];

/// The classifier clusters by a greedy longest-edge-first anchor pick, which
/// is itself order-independent (max-by-length, not first-seen), but the
/// input edge list order still depends on `open_edges`'s `FxHashMap`
/// iteration order, which is NOT deterministic across runs. Reproducing the
/// verdict under several explicit shuffles of the same edge set guards
/// against a hidden order dependency creeping back into the clustering (the
/// exact class of bug the collinear-merge fix above was pinned against).
fn assert_permutation_invariant(host: u32, edges: &[((f64, f64, f64), (f64, f64, f64))]) {
    let (baseline_tj, baseline_detail) = classify_open_edges(edges);
    let mut rng = SplitMix64(0x1235_5EED_C0FF_EE03 ^ host as u64);
    for trial in 0..8 {
        let mut shuffled = edges.to_vec();
        if trial == 0 {
            shuffled.reverse();
        } else {
            rng.shuffle(&mut shuffled);
        }
        let (tj, detail) = classify_open_edges(&shuffled);
        assert_eq!(
            tj, baseline_tj,
            "host #{host} trial {trial}: T-junction verdict changed under edge-order permutation \
             (baseline={baseline_detail}, shuffled={detail})"
        );
    }
}

#[test]
#[ignore = "manual probe (#3435): classify torn hosts by fast-path vs general cutter and T-junction vs other"]
fn classify_probe() {
    let rel = "tests/models/ara3d/ISSUE_068_ARK_NUS_skolebygg.ifc";
    let path = repo_root().join(rel);
    let content = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
    let voids = void_index(&content);

    let mut hosts: Vec<u32> = voids.keys().copied().collect();
    hosts.sort_unstable();
    println!("void hosts total: {}", hosts.len());

    println!(
        "{:>10} {:>5} {:>6} {:>12} {:>4}  detail",
        "host", "nvoid", "open", "path", "tjnc"
    );

    let dump_hosts: [u32; 0] = [];

    let mut torn = 0usize;
    let mut fastpath_torn = 0usize;
    let mut general_torn = 0usize;
    let mut tjunction = 0usize;
    let mut not_tjunction = 0usize;
    let unclassified = 0usize;
    let mut anchor_verdicts: FxHashMap<u32, bool> = FxHashMap::default();

    for &host in &hosts {
        let openings = voids.get(&host).cloned().unwrap_or_default();
        let _ = take_prism_stats(); // reset before this host's processing
        let Some(mesh) = process(&content, host, &voids) else {
            continue;
        };
        let (fires, _analytic, _residual) = take_prism_stats();
        let open = edge_open_count(&mesh);
        if open == 0 {
            continue;
        }
        torn += 1;
        let path = if fires > 0 { "PRISM_FAST" } else { "GENERAL" };
        if fires > 0 {
            fastpath_torn += 1;
        } else {
            general_torn += 1;
        }
        let edges = open_edges(&mesh);
        let (is_tj, detail) = classify_open_edges(&edges);
        let tj_str = if is_tj {
            tjunction += 1;
            "YES"
        } else {
            not_tjunction += 1;
            "NO"
        };
        if host == ANCHOR_TJUNCTION || ANCHOR_NOT_TJUNCTION.contains(&host) {
            anchor_verdicts.insert(host, is_tj);
            assert_permutation_invariant(host, &edges);
        }
        println!(
            "{:>10} {:>5} {:>6} {:>12} {:>4}  {}",
            host,
            openings.len(),
            open,
            path,
            tj_str,
            detail
        );
        if dump_hosts.contains(&host) {
            println!("  ---- raw open edges for host {host} ----");
            for (a, b) in &edges {
                let d = sub(*b, *a);
                println!(
                    "    A=({:.4},{:.4},{:.4}) B=({:.4},{:.4},{:.4})  len={:.4} dir={:.4},{:.4},{:.4}",
                    a.0, a.1, a.2, b.0, b.1, b.2, norm(d), d.0 / norm(d).max(1e-12), d.1 / norm(d).max(1e-12), d.2 / norm(d).max(1e-12)
                );
            }
        }
    }
    let _ = unclassified;

    println!("\n==== SUMMARY ====");
    println!("torn hosts total     : {torn}");
    println!("  via prism fast path: {fastpath_torn}");
    println!("  via general cutter : {general_torn}");
    println!("  T-junction (yes)   : {tjunction}");
    println!("  T-junction (no)    : {not_tjunction}");

    // Anchors: the corrected classifier (collinearity + proximity split)
    // must reproduce these regardless of any unrelated drift elsewhere in
    // the population.
    assert_eq!(
        anchor_verdicts.get(&ANCHOR_TJUNCTION).copied(),
        Some(true),
        "host #{ANCHOR_TJUNCTION} must classify as a T-junction"
    );
    for &host in &ANCHOR_NOT_TJUNCTION {
        assert_eq!(
            anchor_verdicts.get(&host).copied(),
            Some(false),
            "host #{host} must NOT classify as a T-junction"
        );
    }
}
