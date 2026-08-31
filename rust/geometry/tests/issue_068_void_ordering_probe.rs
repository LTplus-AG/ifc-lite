// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Ad hoc probe for issue #3435: for EVERY torn host in ISSUE_068
//! (`ISSUE_068_ARK_NUS_skolebygg.ifc`), apply its recorded
//! `IfcRelVoidsElement` openings in several different orders and record the
//! resulting `open`-edge count, to answer one question: does a single
//! ordering rule make the tears go away, and for how many of the 29 hosts?
//!
//! Reuses the same machinery as `issue_053_heavy_csg_probe.rs`
//! (`void_index`, `process`, `process_no_voids`, `edge_stats`), duplicated
//! here rather than shared across two separate test-binary crates.
//!
//! Run:
//!   cargo test -p ifc-lite-geometry --test issue_068_void_ordering_probe \
//!     -- --ignored --nocapture void_ordering_probe
//!
//! `--ignored`: manual probe, not gated CI. Debug build (no `--release`) —
//! this worktree's shared `.cargo/config.toml` collides with
//! `panic = "abort"` under `--release`.

mod census_golden;

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter, Mesh};
use rustc_hash::FxHashMap;

fn crate_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn repo_root() -> std::path::PathBuf {
    crate_dir().join("..").join("..")
}

/// `true` when the catalogued fixture is on disk.
///
/// An absent fixture must SKIP, never panic (AGENTS.md "Test fixtures"); CI
/// runs `pnpm fixtures` before tests, so it always has the full set.
/// `try_exists`, not `exists`: `Path::exists` collapses a permission error
/// into `false`, which would quietly skip on a broken checkout while
/// reporting green. Only a definite "not there" skips; an undecidable answer
/// is a broken setup and still panics.
fn fixture_present(path: &std::path::Path) -> bool {
    match path.try_exists() {
        Ok(true) => true,
        Ok(false) => {
            eprintln!(
                "skipping: fixture {} not present -- run `pnpm fixtures` to download (sha256 in tests/models/manifest.json)",
                path.display()
            );
            false
        }
        Err(e) => panic!("cannot determine whether fixture {} exists: {e}", path.display()),
    }
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

fn process_no_voids(content: &str, host_id: u32) -> Option<Mesh> {
    let ei = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, ei);
    let entity = decoder.decode_by_id(host_id).ok()?;
    let router = GeometryRouter::with_units(content, &mut decoder);
    router.process_element(&entity, &mut decoder).ok()
}

struct EdgeStats {
    open: usize,
}

fn edge_stats(mesh: &Mesh) -> EdgeStats {
    let q = |v: f32| (v as f64 * 1.0e3).round() as i64;
    let mut vid: FxHashMap<(i64, i64, i64), u32> = FxHashMap::default();
    let mut id = |i: usize| -> u32 {
        let k = (
            q(mesh.positions[i * 3]),
            q(mesh.positions[i * 3 + 1]),
            q(mesh.positions[i * 3 + 2]),
        );
        let n = vid.len() as u32;
        *vid.entry(k).or_insert(n)
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
                e.0 += 1;
            } else {
                e.1 += 1;
            }
        }
    }
    EdgeStats { open: uses.values().filter(|&&(f, r)| f != r).count() }
}

/// Signed-tetrahedron-sum volume (divergence theorem), magnitude only. Not
/// gated on `is_trustworthy_solid()` like `geom_closure::volume()` — this is
/// a ranking key for an ordering heuristic, not a certified measurement, and
/// every opening here is a simple swept/extruded solid that processes fine
/// standalone.
fn mesh_volume(mesh: &Mesh) -> f64 {
    let mut sum = 0.0f64;
    for tri in mesh.indices.chunks_exact(3) {
        let p = |i: u32| {
            let i = i as usize;
            [
                mesh.positions[i * 3] as f64,
                mesh.positions[i * 3 + 1] as f64,
                mesh.positions[i * 3 + 2] as f64,
            ]
        };
        let [ax, ay, az] = p(tri[0]);
        let [bx, by, bz] = p(tri[1]);
        let [cx, cy, cz] = p(tri[2]);
        // 6x signed volume of the tetrahedron (origin, a, b, c)
        sum += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    }
    (sum / 6.0).abs()
}

fn mesh_centroid(mesh: &Mesh) -> [f64; 3] {
    let (mn, mx) = mesh.bounds();
    [
        (mn.x as f64 + mx.x as f64) / 2.0,
        (mn.y as f64 + mx.y as f64) / 2.0,
        (mn.z as f64 + mx.z as f64) / 2.0,
    ]
}

fn mesh_aabb_min(mesh: &Mesh) -> [f64; 3] {
    let (mn, _) = mesh.bounds();
    [mn.x as f64, mn.y as f64, mn.z as f64]
}

/// splitmix64: tiny deterministic PRNG so permutations are seed-reproducible
/// without pulling in the `rand` crate as a dev-dependency of a
/// `#[ignore]`d probe.
struct SplitMix64(u64);
impl SplitMix64 {
    fn new(seed: u64) -> Self {
        Self(seed)
    }
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }
    fn shuffle<T>(&mut self, v: &mut [T]) {
        // Fisher-Yates
        for i in (1..v.len()).rev() {
            let j = (self.next() % (i as u64 + 1)) as usize;
            v.swap(i, j);
        }
    }
}

/// Fixed global seed for every random permutation in this probe. Printed at
/// the top of the run so the whole experiment reproduces byte-for-byte.
const PROBE_SEED: u64 = 0x1235_5EED_C0FF_EE01;
/// Random permutations tried per host, beyond declaration/reversed/canonical.
const RANDOM_PERMS_PER_HOST: usize = 6;

struct HostResult {
    host: u32,
    n: usize,
    declaration: usize,
    reversed: usize,
    random: Vec<usize>,
    desc_volume: usize,
    asc_volume: usize,
    axis: usize,
    aabb_min: usize,
    // determinism: declaration order re-run
    declaration_rerun: usize,
}

#[test]
#[ignore = "manual probe (#3435): does void-application order explain the ISSUE_068 boolean tears"]
fn void_ordering_probe() {
    let rel = "tests/models/ara3d/ISSUE_068_ARK_NUS_skolebygg.ifc";
    let path = repo_root().join(rel);
    if !fixture_present(&path) {
        return;
    }
    let content = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));

    let voids = void_index(&content);
    let mut hosts: Vec<u32> = voids.keys().copied().collect();
    hosts.sort_unstable();

    println!("PROBE_SEED = 0x{PROBE_SEED:016X}");
    println!("random permutations per host = {RANDOM_PERMS_PER_HOST}");
    println!("void hosts total: {}", hosts.len());

    // First pass: find every torn host under DECLARATION order (the
    // baseline / current behaviour), matching the census's definition.
    let mut torn_hosts: Vec<(u32, usize)> = Vec::new(); // (host, declaration open)
    for &host in &hosts {
        let openings = voids.get(&host).unwrap();
        let Some(mesh) = process(&content, host, &voids) else { continue };
        let s = edge_stats(&mesh);
        if s.open > 0 {
            torn_hosts.push((host, s.open));
        }
        let _ = openings;
    }
    println!("torn hosts (declaration order): {}", torn_hosts.len());

    let mut results: Vec<HostResult> = Vec::new();

    for &(host, decl_open) in &torn_hosts {
        let openings = voids.get(&host).unwrap().clone();
        let n = openings.len();

        let check = |subset: &[u32]| -> usize {
            let mut m: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
            m.insert(host, subset.to_vec());
            match process(&content, host, &m) {
                Some(mesh) => edge_stats(&mesh).open,
                None => usize::MAX,
            }
        };

        // 1. declaration (already have it, but recompute via `check` for
        // apples-to-apples with the rest, and to get a determinism re-run).
        let declaration = check(&openings);
        let declaration_rerun = check(&openings);

        // 2. reversed
        let reversed_order: Vec<u32> = openings.iter().rev().copied().collect();
        let reversed = check(&reversed_order);

        // 3. random permutations, seeded deterministically per host so the
        // WHOLE experiment reproduces from PROBE_SEED + host id.
        let mut rng = SplitMix64::new(PROBE_SEED ^ (host as u64).wrapping_mul(0x9E3779B1));
        let mut random = Vec::with_capacity(RANDOM_PERMS_PER_HOST);
        for _ in 0..RANDOM_PERMS_PER_HOST {
            let mut perm = openings.clone();
            rng.shuffle(&mut perm);
            random.push(check(&perm));
        }

        // 4. canonical orders: geometry-derived keys per opening, computed
        // via `process_no_voids` on the opening entity itself (unclipped,
        // standalone solid) — same source `heavy_csg_void_ddmin_probe` uses
        // for its AABB characterisation.
        let mut keyed: Vec<(u32, f64, f64, [f64; 3], [f64; 3])> = Vec::new(); // (id, volume, axis_centroid, centroid, aabb_min)
        for &op in &openings {
            match process_no_voids(&content, op) {
                Some(m) => {
                    let vol = mesh_volume(&m);
                    let c = mesh_centroid(&m);
                    let amin = mesh_aabb_min(&m);
                    keyed.push((op, vol, 0.0, c, amin));
                }
                None => keyed.push((op, 0.0, 0.0, [0.0; 3], [0.0; 3])),
            }
        }

        // Host's own principal axis: the axis of largest extent of the
        // UNCUT host's own bounding box. Approximation — assumes the host's
        // local "length" axis is world-axis-aligned, which is not always
        // true for a rotated wall; caveated in the report.
        let axis_idx: usize = match process_no_voids(&content, host) {
            Some(hm) => {
                let (mn, mx) = hm.bounds();
                let ext = [
                    (mx.x - mn.x).abs() as f64,
                    (mx.y - mn.y).abs() as f64,
                    (mx.z - mn.z).abs() as f64,
                ];
                if ext[0] >= ext[1] && ext[0] >= ext[2] {
                    0
                } else if ext[1] >= ext[2] {
                    1
                } else {
                    2
                }
            }
            None => 0,
        };
        for (id, _, axis_c, c, _) in keyed.iter_mut() {
            *axis_c = c[axis_idx];
            let _ = id;
        }

        let mut by_desc_vol = keyed.clone();
        by_desc_vol.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
        let desc_volume = check(&by_desc_vol.iter().map(|k| k.0).collect::<Vec<_>>());

        let mut by_asc_vol = keyed.clone();
        by_asc_vol.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
        let asc_volume = check(&by_asc_vol.iter().map(|k| k.0).collect::<Vec<_>>());

        let mut by_axis = keyed.clone();
        by_axis.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap());
        let axis = check(&by_axis.iter().map(|k| k.0).collect::<Vec<_>>());

        let mut by_aabb_min = keyed.clone();
        by_aabb_min.sort_by(|a, b| {
            a.4.partial_cmp(&b.4).unwrap_or(std::cmp::Ordering::Equal)
        });
        let aabb_min = check(&by_aabb_min.iter().map(|k| k.0).collect::<Vec<_>>());

        println!(
            "HOST #{host}  n={n}  decl={declaration}(rerun={declaration_rerun})  rev={reversed}  \
             rand={random:?}  desc_vol={desc_volume}  asc_vol={asc_volume}  axis(={})={axis}  aabb_min={aabb_min}",
            ['x', 'y', 'z'][axis_idx]
        );

        results.push(HostResult {
            host,
            n,
            declaration,
            reversed,
            random,
            desc_volume,
            asc_volume,
            axis,
            aabb_min,
            declaration_rerun,
        });
        let _ = decl_open;
    }

    println!("\n=== SUMMARY ({} torn hosts probed) ===", results.len());
    println!(
        "{:<10} {:>4} {:>6} {:>6} {:>6} {:>20} {:>10} {:>10} {:>10} {:>10}",
        "host", "n", "decl", "rerun", "rev", "random(6)", "desc_vol", "asc_vol", "axis", "aabb_min"
    );
    for r in &results {
        println!(
            "{:<10} {:>4} {:>6} {:>6} {:>6} {:>20} {:>10} {:>10} {:>10} {:>10}",
            r.host,
            r.n,
            r.declaration,
            r.declaration_rerun,
            r.reversed,
            format!("{:?}", r.random),
            r.desc_volume,
            r.asc_volume,
            r.axis,
            r.aabb_min
        );
    }

    let any_clean = |r: &HostResult| -> bool {
        r.declaration == 0
            || r.reversed == 0
            || r.random.contains(&0)
            || r.desc_volume == 0
            || r.asc_volume == 0
            || r.axis == 0
            || r.aabb_min == 0
    };
    let clean_under_some_ordering = results.iter().filter(|r| any_clean(r)).count();
    let torn_under_every_ordering: Vec<u32> =
        results.iter().filter(|r| !any_clean(r)).map(|r| r.host).collect();

    let canon_clean = |r: &HostResult| r.desc_volume == 0;
    let desc_vol_clean_count = results.iter().filter(|r| canon_clean(r)).count();
    let asc_vol_clean_count = results.iter().filter(|r| r.asc_volume == 0).count();
    let axis_clean_count = results.iter().filter(|r| r.axis == 0).count();
    let aabb_min_clean_count = results.iter().filter(|r| r.aabb_min == 0).count();

    println!("\nhosts probed                                   : {}", results.len());
    println!("clean under AT LEAST ONE ordering tried        : {clean_under_some_ordering}");
    println!("torn under EVERY ordering tried                : {}", torn_under_every_ordering.len());
    println!("  -> {:?}", torn_under_every_ordering);
    println!("clean under descending-volume order            : {desc_vol_clean_count}/{}", results.len());
    println!("clean under ascending-volume order              : {asc_vol_clean_count}/{}", results.len());
    println!("clean under axis-centroid order                 : {axis_clean_count}/{}", results.len());
    println!("clean under AABB-min-lexicographic order        : {aabb_min_clean_count}/{}", results.len());

    let decl_rerun_stable = results.iter().all(|r| r.declaration == r.declaration_rerun);
    println!(
        "\ndeclaration-order determinism (rerun == first run) for ALL probed hosts: {decl_rerun_stable}"
    );
}
