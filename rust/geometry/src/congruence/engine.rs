// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::mesh::Mesh;
use nalgebra::{Matrix3, Vector3};
use rustc_hash::FxHashMap;

/// Weld grid (metres) — coarser than f32 jitter, matching `facet_weld`'s
/// POSITION_DEDUP_GRID, so facet-soup vertex order/count differences collapse.
const WELD_EPS: f32 = 1.0e-4;
/// Largest welded vertex count we attempt correspondence on (O(n) descriptor,
/// but the bucket/verify book-keeping is bounded). Bigger meshes are reported as
/// `skipped_large` and counted as distinct (safe under-count).
const MAX_VERTS: usize = 4096;
/// Candidate verify tolerances (metres) the report sweeps to expose the residual
/// gap and tolerance sensitivity. The headline "safe" figure uses SAFE_TOL.
pub(super) const SAFE_TOL: f64 = 3.0e-5; // 30 µm — near the f32 building-scale floor

// ----------------------------------------------------------------------------
// Welded local representation + rotation-invariant signature
// ----------------------------------------------------------------------------

pub(super) struct Welded {
    /// Centred (centroid-subtracted) welded vertices, f64.
    verts: Vec<Vector3<f64>>,
    /// Triangles into `verts`.
    tris: Vec<[u32; 3]>,
    /// Per-vertex quantised distance-to-centroid descriptor (rotation+translation
    /// invariant); used to pick correspondence anchors.
    desc: Vec<i64>,
    /// Minimum inter-vertex spacing (for the ambiguous-correspondence exclusion).
    pub(super) min_spacing: f64,
    /// Centroid of the welded vertices in LOCAL coords (subtracted from `verts`).
    /// Needed to compose the canonical→local transform `C_k` for the renderer.
    pub(super) centroid: Vector3<f64>,
}

pub(super) fn build_welded(mesh: &Mesh) -> Option<Welded> {
    let w = mesh.welded_by_position(WELD_EPS);
    let nv = w.positions.len() / 3;
    if nv < 4 || nv > MAX_VERTS || w.indices.is_empty() {
        return None;
    }
    // Reject non-finite coordinates outright: a NaN/inf vertex poisons the
    // centroid and covariance (NaN eigenvalues), and verify's max-deviation
    // fold is NaN-blind (`NaN > max_dev` is false), so a malformed mesh could
    // otherwise bucket AND pass verification with a NaN canonical transform.
    if w.positions.iter().any(|v| !v.is_finite()) {
        return None;
    }
    let mut verts: Vec<Vector3<f64>> = Vec::with_capacity(nv);
    let mut c = Vector3::zeros();
    for i in 0..nv {
        let v = Vector3::new(
            w.positions[i * 3] as f64,
            w.positions[i * 3 + 1] as f64,
            w.positions[i * 3 + 2] as f64,
        );
        c += v;
        verts.push(v);
    }
    c /= nv as f64;
    for v in &mut verts {
        *v -= c;
    }
    let tris: Vec<[u32; 3]> = w
        .indices
        .chunks_exact(3)
        .map(|t| [t[0], t[1], t[2]])
        .collect();
    // distance-to-centroid descriptor (quantised at ~weld grid).
    let desc: Vec<i64> = verts
        .iter()
        .map(|v| (v.norm() / 1.0e-4).round() as i64)
        .collect();
    // min spacing via the same quantised grid hash as weld_impl (avoid O(n^2)).
    let min_spacing = min_inter_vertex_spacing(&verts);
    Some(Welded {
        verts,
        tris,
        desc,
        min_spacing,
        centroid: c,
    })
}

/// Cheap lower bound on the closest vertex pair using a spatial hash; returns the
/// smallest neighbour distance found (probing the 27 adjacent cells).
fn min_inter_vertex_spacing(verts: &[Vector3<f64>]) -> f64 {
    let cell = 1.0e-3;
    let mut grid: FxHashMap<[i64; 3], Vec<usize>> = FxHashMap::default();
    let key = |v: &Vector3<f64>| {
        [
            (v.x / cell).floor() as i64,
            (v.y / cell).floor() as i64,
            (v.z / cell).floor() as i64,
        ]
    };
    for (i, v) in verts.iter().enumerate() {
        grid.entry(key(v)).or_default().push(i);
    }
    let mut best = f64::INFINITY;
    for (i, v) in verts.iter().enumerate() {
        let k = key(v);
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    if let Some(bucket) = grid.get(&[k[0] + dx, k[1] + dy, k[2] + dz]) {
                        for &j in bucket {
                            if j != i {
                                let d = (verts[j] - v).norm();
                                if d < best {
                                    best = d;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    best
}

/// Rotation+translation+reflection-invariant bucket signature: sorted eigenvalues
/// of the (vertex) covariance, plus welded vertex/triangle counts. NEVER decides a
/// merge — only buckets. Returns a small set of quantised keys (neighbour-probe on
/// each eigenvalue) so a congruent pair straddling a quant boundary still collides.
pub(super) fn signature_keys(w: &Welded) -> Vec<u64> {
    // covariance about the (already-subtracted) centroid.
    let mut cov = Matrix3::zeros();
    for v in &w.verts {
        cov += v * v.transpose();
    }
    cov /= w.verts.len() as f64;
    let eig = cov.symmetric_eigenvalues();
    let mut ev = [eig[0], eig[1], eig[2]];
    // total_cmp: a NaN/inf vertex coordinate yields a NaN eigenvalue, and
    // partial_cmp().unwrap() would panic on it (NaN sorts deterministically
    // to one end instead).
    ev.sort_by(|a, b| a.total_cmp(b));
    // relative quantisation: eigenvalues scale with size^2; use a log-ish grid.
    let q = |x: f64| -> [i64; 2] {
        let s = (x.max(0.0)).sqrt(); // characteristic length
        let g = 1.0e-3; // 1mm grid on the characteristic length
        let base = (s / g).round() as i64;
        [base, ((s / g) + 0.5).round() as i64] // dual cell
    };
    let qe: Vec<[i64; 2]> = ev.iter().map(|&x| q(x)).collect();
    let nv = w.verts.len() as u64;
    let nt = w.tris.len() as u64;
    let mut keys = Vec::with_capacity(8);
    // neighbour-probe across the three eigenvalue cells.
    for &a in &qe[0] {
        for &b in &qe[1] {
            for &c in &qe[2] {
                let mut h = 0xcbf29ce484222325u64;
                for x in [a as u64, b as u64, c as u64, nv, nt] {
                    h ^= x.wrapping_mul(0x100000001b3);
                    h = h.rotate_left(13).wrapping_mul(0x100000001b3);
                }
                keys.push(h);
            }
        }
    }
    keys.sort_unstable();
    keys.dedup();
    keys
}

// ----------------------------------------------------------------------------
// Exact congruence verification (the sole merge authority)
// ----------------------------------------------------------------------------

/// Outcome of attempting to verify two welded locals as rigid-congruent.
pub(super) struct VerifyOutcome {
    /// A correspondence + proper rotation was established (bijection ok).
    pub(super) corresponded: bool,
    /// Max per-vertex world deviation under the recovered rotation (if corresponded).
    pub(super) max_dev: f64,
    /// Triangle-set (adjacency) matched under the correspondence.
    pub(super) connectivity_ok: bool,
    /// Reflection was the only fit (rejected — chiral pair).
    pub(super) reflection_only: bool,
    /// Recovered proper rotation R (template-centred -> candidate-centred) for the
    /// connectivity-ok match; identity when not corresponded.
    pub(super) rotation: Matrix3<f64>,
}

impl VerifyOutcome {
    const FAIL: VerifyOutcome = VerifyOutcome {
        corresponded: false,
        max_dev: f64::INFINITY,
        connectivity_ok: false,
        reflection_only: false,
        rotation: Matrix3::new(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0),
    };
}

/// Det-corrected Kabsch: rotation R with R*a_i ≈ b_i for centred anchor sets.
/// Returns (R, det_sign).
fn kabsch(a: &[Vector3<f64>], b: &[Vector3<f64>]) -> Option<(Matrix3<f64>, f64)> {
    if a.len() < 3 {
        return None;
    }
    let mut h = Matrix3::zeros();
    for (pa, pb) in a.iter().zip(b.iter()) {
        h += pa * pb.transpose();
    }
    let svd = h.svd(true, true);
    let u = svd.u?;
    let v_t = svd.v_t?;
    let v = v_t.transpose();
    let ut = u.transpose();
    let d = (v * ut).determinant().signum();
    let mut sigma = Matrix3::identity();
    sigma[(2, 2)] = d;
    let r = v * sigma * ut;
    Some((r, d))
}

/// Build a NN correspondence from `src` (rotated template) to `dst` (candidate)
/// on a spatial hash; require an injective bijection within `tol`. Returns the
/// per-src matched dst index, or None if not a clean bijection.
fn correspond(src: &[Vector3<f64>], dst: &[Vector3<f64>], tol: f64) -> Option<Vec<usize>> {
    if src.len() != dst.len() {
        return None;
    }
    let cell = (tol * 4.0).max(1.0e-6);
    let key = |v: &Vector3<f64>| {
        [
            (v.x / cell).floor() as i64,
            (v.y / cell).floor() as i64,
            (v.z / cell).floor() as i64,
        ]
    };
    let mut grid: FxHashMap<[i64; 3], Vec<usize>> = FxHashMap::default();
    for (j, v) in dst.iter().enumerate() {
        grid.entry(key(v)).or_default().push(j);
    }
    let mut used = vec![false; dst.len()];
    let mut map = vec![usize::MAX; src.len()];
    for (i, v) in src.iter().enumerate() {
        let k = key(v);
        let mut best = usize::MAX;
        let mut best_d = tol;
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    if let Some(bucket) = grid.get(&[k[0] + dx, k[1] + dy, k[2] + dz]) {
                        for &j in bucket {
                            if used[j] {
                                continue;
                            }
                            let d = (dst[j] - v).norm();
                            if d <= best_d {
                                best_d = d;
                                best = j;
                            }
                        }
                    }
                }
            }
        }
        if best == usize::MAX {
            return None; // no match within tol -> not a bijection
        }
        used[best] = true;
        map[i] = best;
    }
    Some(map)
}

/// Triangle-set (adjacency) equality under a correspondence: map each template
/// triangle's vertices through `map`, sort the triple, and compare the multisets.
fn connectivity_matches(t_tris: &[[u32; 3]], c_tris: &[[u32; 3]], map: &[usize]) -> bool {
    if t_tris.len() != c_tris.len() {
        return false;
    }
    let norm = |a: u32, b: u32, c: u32| {
        let mut t = [a, b, c];
        t.sort_unstable();
        t
    };
    let mut want: FxHashMap<[u32; 3], i32> = FxHashMap::default();
    for tri in c_tris {
        *want.entry(norm(tri[0], tri[1], tri[2])).or_insert(0) += 1;
    }
    for tri in t_tris {
        let m = norm(
            map[tri[0] as usize] as u32,
            map[tri[1] as usize] as u32,
            map[tri[2] as usize] as u32,
        );
        let e = want.entry(m).or_insert(0);
        *e -= 1;
        if *e < 0 {
            return false;
        }
    }
    want.values().all(|&v| v == 0)
}

/// Cap on enumerated correspondences (product of descriptor-group factorials).
const CAP_PERMS: u128 = 5040; // 7!
/// NN match radius for the PCA-fallback correspondence (captures the true
/// congruent residual cluster — measured ≤100µm — with margin).
const MATCH_RADIUS: f64 = 5.0e-4;
/// Below this min inter-vertex spacing, NN correspondence is ambiguous, so the
/// NN-fallback path refuses (safe missed merge). Does NOT gate the permutation
/// path (descriptor-exact pairing + connectivity make it safe regardless).
pub(super) const AMBIG_SPACING: f64 = 2.0 * MATCH_RADIUS;

fn factorial(n: u128) -> u128 {
    (1..=n).product::<u128>().max(1)
}

/// All permutations of a slice (Heap's algorithm). Bounded use only.
fn permutations(items: &[usize]) -> Vec<Vec<usize>> {
    let mut out = Vec::new();
    let mut a = items.to_vec();
    let n = a.len();
    let mut c = vec![0usize; n];
    out.push(a.clone());
    let mut i = 0;
    while i < n {
        if c[i] < i {
            if i % 2 == 0 {
                a.swap(0, i);
            } else {
                a.swap(c[i], i);
            }
            out.push(a.clone());
            c[i] += 1;
            i = 0;
        } else {
            c[i] = 0;
            i += 1;
        }
    }
    out
}

/// Evaluate one correspondence (`map[i]` = candidate vertex for template vertex i):
/// Kabsch -> proper rotation, max per-vertex deviation, triangle-set connectivity.
/// Returns (max_dev, connectivity_ok, is_reflection).
fn eval_correspondence(t: &Welded, c: &Welded, map: &[usize]) -> Option<(f64, bool, bool, Matrix3<f64>)> {
    let a: Vec<Vector3<f64>> = t.verts.clone();
    let b: Vec<Vector3<f64>> = map.iter().map(|&j| c.verts[j]).collect();
    let (r, d) = kabsch(&a, &b)?;
    if d < 0.0 {
        return Some((f64::INFINITY, false, true, r)); // reflection
    }
    let mut max_dev = 0.0f64;
    for (i, bi) in b.iter().enumerate() {
        let dev = (r * a[i] - bi).norm();
        if dev > max_dev {
            max_dev = dev;
        }
    }
    let conn = connectivity_matches(&t.tris, &c.tris, map);
    Some((max_dev, conn, false, r))
}

/// Verify whether `t` (template) and `c` (candidate) are rigid-congruent. Builds
/// candidate vertex correspondences — by enumerating permutations within
/// equal-descriptor groups when bounded (handles asymmetric steel cheaply and
/// small symmetric shapes exactly), else a PCA sign-flip frame + NN fallback
/// (large symmetric shapes may be safely under-counted). Each correspondence is
/// scored by det=+1 Kabsch (reflections rejected), max-deviation, and a
/// triangle-set connectivity check. Records the residual + connectivity even when
/// above `tol`, so the caller can build the histogram and the false-merge audit.
pub(super) fn verify(t: &Welded, c: &Welded) -> VerifyOutcome {
    // Count pre-gate (strict — congruent occurrences must weld to identical counts).
    if t.verts.len() != c.verts.len() || t.tris.len() != c.tris.len() {
        return VerifyOutcome::FAIL;
    }

    // Descriptor histograms must match (necessary for congruence; cheap reject).
    let mut th: FxHashMap<i64, i32> = FxHashMap::default();
    for &d in &t.desc {
        *th.entry(d).or_insert(0) += 1;
    }
    for &d in &c.desc {
        let e = th.entry(d).or_insert(0);
        *e -= 1;
    }
    if th.values().any(|&v| v != 0) {
        return VerifyOutcome::FAIL;
    }

    // Group vertex indices by descriptor (t and c share the histogram, checked above).
    let mut t_groups: FxHashMap<i64, Vec<usize>> = FxHashMap::default();
    let mut c_groups: FxHashMap<i64, Vec<usize>> = FxHashMap::default();
    for (i, &d) in t.desc.iter().enumerate() {
        t_groups.entry(d).or_default().push(i);
    }
    for (i, &d) in c.desc.iter().enumerate() {
        c_groups.entry(d).or_default().push(i);
    }
    let mut descs: Vec<i64> = t_groups.keys().copied().collect();
    descs.sort_unstable();

    // Total correspondences = product of group factorials.
    let mut total: u128 = 1;
    for d in &descs {
        total = total.saturating_mul(factorial(t_groups[d].len() as u128));
        if total > CAP_PERMS {
            break;
        }
    }

    let mut maps: Vec<Vec<usize>> = Vec::new();
    if total <= CAP_PERMS {
        // Exact: cartesian product of within-group permutations.
        maps.push(vec![usize::MAX; t.verts.len()]);
        for d in &descs {
            let ti = &t_groups[d];
            let cperms = permutations(&c_groups[d]);
            let mut next = Vec::new();
            'outer: for base in &maps {
                for perm in &cperms {
                    let mut m = base.clone();
                    for (k, &t_i) in ti.iter().enumerate() {
                        m[t_i] = perm[k];
                    }
                    next.push(m);
                    if next.len() as u128 > CAP_PERMS {
                        break 'outer;
                    }
                }
            }
            maps = next;
        }
    } else if t.min_spacing >= AMBIG_SPACING && c.min_spacing >= AMBIG_SPACING {
        // Fallback for large symmetric shapes: PCA sign-flip frames + NN. Gated by
        // the ambiguous-spacing exclusion (NN is only safe when no two vertices are
        // within the match radius). Safe but may under-count (acceptable: such
        // shapes are rarely the rotation-baked-steel target).
        if let (Some(ft), Some(fc)) = (pca_frame(&t.verts), pca_frame(&c.verts)) {
            for signs in [[1.0, 1.0, 1.0], [1.0, -1.0, -1.0], [-1.0, 1.0, -1.0], [-1.0, -1.0, 1.0]] {
                let mut fs = fc;
                for k in 0..3 {
                    let col = fs.column(k) * signs[k];
                    fs.set_column(k, &col);
                }
                let r = fs * ft.transpose();
                if (r.determinant() - 1.0).abs() > 1.0e-6 {
                    continue;
                }
                let rotated: Vec<Vector3<f64>> = t.verts.iter().map(|v| r * v).collect();
                if let Some(map) = correspond(&rotated, &c.verts, MATCH_RADIUS) {
                    maps.push(map);
                }
            }
        }
    }

    // Among candidate correspondences, PREFER one that preserves connectivity (the
    // safe merge), then minimise deviation. A symmetric shape can yield several
    // low-deviation correspondences whose triangulation does NOT match (a symmetry
    // the triangulation doesn't respect); we must pick the connectivity-preserving
    // one, not merely the smallest residual, or true instances fail to merge.
    let mut best_valid: Option<(f64, Matrix3<f64>)> = None; // (dev, R) among connectivity-ok
    let mut best_any: Option<f64> = None; // min dev among any corresponded candidate
    let mut reflection_seen = false;
    for map in &maps {
        if map.contains(&usize::MAX) {
            continue;
        }
        if let Some((dev, conn, refl, r)) = eval_correspondence(t, c, map) {
            if refl {
                reflection_seen = true;
                continue;
            }
            best_any = Some(best_any.map_or(dev, |d: f64| d.min(dev)));
            if conn && best_valid.is_none_or(|(d, _)| dev < d) {
                best_valid = Some((dev, r));
            }
        }
    }
    if let Some((dev, r)) = best_valid {
        VerifyOutcome {
            corresponded: true,
            max_dev: dev,
            connectivity_ok: true,
            reflection_only: false,
            rotation: r,
        }
    } else if let Some(dev) = best_any {
        VerifyOutcome {
            corresponded: true,
            max_dev: dev,
            connectivity_ok: false,
            reflection_only: false,
            ..VerifyOutcome::FAIL
        }
    } else {
        VerifyOutcome {
            reflection_only: reflection_seen,
            ..VerifyOutcome::FAIL
        }
    }
}

/// PCA eigenframe (columns = eigenvectors, ascending eigenvalue). None if degenerate.
fn pca_frame(verts: &[Vector3<f64>]) -> Option<Matrix3<f64>> {
    let mut cov = Matrix3::zeros();
    for v in verts {
        cov += v * v.transpose();
    }
    cov /= verts.len() as f64;
    let eig = nalgebra::SymmetricEigen::new(cov);
    // sort eigenvectors by eigenvalue
    let mut idx = [0usize, 1, 2];
    idx.sort_by(|&a, &b| eig.eigenvalues[a].total_cmp(&eig.eigenvalues[b]));
    let mut f: Matrix3<f64> = Matrix3::zeros();
    for (k, &i) in idx.iter().enumerate() {
        let col: Vector3<f64> = eig.eigenvectors.column(i).into_owned();
        f.set_column(k, &col);
    }
    let det = f.determinant();
    if det.abs() < 1.0e-9 {
        return None;
    }
    // Force a PROPER (det=+1) frame so the det=+1 sign-flip set in `verify`
    // spans all valid sign assignments — otherwise an improper frame puts the
    // correct rotation outside the enumerated (proper) candidates.
    if det < 0.0 {
        let col: Vector3<f64> = -f.column(2);
        f.set_column(2, &col);
    }
    Some(f)
}
