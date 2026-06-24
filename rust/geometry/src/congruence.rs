//! Phase-0 measurement spike for rotation-normalized GPU instancing.
//!
//! GOAL: answer ONE question with a real number before any renderer work — how
//! much MORE instancing dedup is *safely* available beyond the shipped exact-bit
//! tier (2.74x on merged_export), by also grouping element geometry that is
//! congruent up to a rigid rotation (orientation baked into the local
//! extrusion/profile/CSG rather than `IfcObjectPlacement`)?
//!
//! This module is MEASUREMENT-ONLY: no renderer, no production rep_identity
//! change, no cache. It operates on the PRE-PLACEMENT LOCAL meshes (the same
//! mesh state `compute_mesh_hash` saw — captured in `processing::tag_direct_instance`),
//! NOT the world-baked positions that `collate_instances` normally sees (the
//! frame-mismatch trap the design review flagged).
//!
//! SAFETY (so the measured number is an honest *lower* bound, never inflated like
//! the lossy-moments 10.66x probe): a cheap rotation-invariant signature only
//! BUCKETS candidates; an exact verifier DECIDES every merge — welded
//! vertex/triangle-count pre-gate, anchor-based correspondence, det=+1 Kabsch
//! (reflections stay separate), two-sided max (Hausdorff) deviation gate, AND a
//! triangle-set connectivity check (closes the same-cloud/different-triangulation
//! false-merge hole). A pair that cannot be PROVEN congruent stays distinct.
//!
//! Determinism is not required here (one-off native measurement), so nalgebra's
//! iterative eigensolver/SVD is fine; production would need the closed-form
//! Cardano path noted in the design.

use crate::mesh::Mesh;
use nalgebra::{Matrix3, Vector3};
use rustc_hash::FxHashMap;
use std::sync::{Mutex, OnceLock};

/// Weld grid (metres) — coarser than f32 jitter, matching `facet_weld`'s
/// POSITION_DEDUP_GRID, so facet-soup vertex order/count differences collapse.
const WELD_EPS: f32 = 1.0e-4;
/// Largest welded vertex count we attempt correspondence on (O(n) descriptor,
/// but the bucket/verify book-keeping is bounded). Bigger meshes are reported as
/// `skipped_large` and counted as distinct (safe under-count).
const MAX_VERTS: usize = 4096;
/// Candidate verify tolerances (metres) the report sweeps to expose the residual
/// gap and tolerance sensitivity. The headline "safe" figure uses SAFE_TOL.
const SAFE_TOL: f64 = 3.0e-5; // 30 µm — near the f32 building-scale floor
const TOL_SWEEP: [f64; 6] = [1.0e-6, 1.0e-5, 3.0e-5, 1.0e-4, 3.0e-4, 1.0e-3];

// ----------------------------------------------------------------------------
// Analysis collector — populated in processing::tag_direct_instance under the
// IFC_LITE_INSTANCING_ANALYSIS flag (first-wins per rep_identity local geometry).
// ----------------------------------------------------------------------------

#[allow(clippy::type_complexity)]
static ANALYSIS_LOCALS: OnceLock<Mutex<FxHashMap<u128, Mesh>>> = OnceLock::new();

fn collector() -> &'static Mutex<FxHashMap<u128, Mesh>> {
    ANALYSIS_LOCALS.get_or_init(|| Mutex::new(FxHashMap::default()))
}

/// Whether the Phase-0 analysis collector is active.
pub fn analysis_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("IFC_LITE_INSTANCING_ANALYSIS").is_ok())
}

/// Record a representation's pre-placement local mesh (first occurrence wins).
pub fn record_local(rep_identity: u128, mesh: &Mesh) {
    if mesh.positions.is_empty() {
        return;
    }
    let mut map = collector().lock().expect("analysis collector poisoned");
    map.entry(rep_identity).or_insert_with(|| mesh.clone());
}

/// Drain the collected distinct local meshes, sorted by rep_identity for
/// deterministic analysis order.
pub fn take_locals() -> Vec<(u128, Mesh)> {
    let mut map = collector().lock().expect("analysis collector poisoned");
    let mut out: Vec<(u128, Mesh)> = std::mem::take(&mut *map).into_iter().collect();
    out.sort_by_key(|(k, _)| *k);
    out
}

// ----------------------------------------------------------------------------
// Production rigid tier (IFC_LITE_RIGID_INSTANCING): a shared cache that groups
// congruent-but-not-bit-identical local meshes onto one template + a recovered
// canonical->local transform, layered ON TOP of the exact-bit tier.
// ----------------------------------------------------------------------------

/// Whether the rotation-normalized rigid instancing tier is enabled.
pub fn rigid_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("IFC_LITE_RIGID_INSTANCING").is_ok())
}

/// Result of classifying a local mesh into the rigid tier.
#[derive(Clone, Copy)]
pub struct RigidClass {
    /// The rigid template's rep_identity (shared by all congruent occurrences).
    pub rigid_id: u128,
    /// Canonical(template-local) -> this(local) transform `C_k`, row-major. `None`
    /// when this mesh IS the template (identity).
    pub canonical_transform: Option<[f64; 16]>,
}

struct RigidTemplate {
    welded: Welded,
    rigid_id: u128,
    centroid: Vector3<f64>,
}

/// A reusable rigid-template cache: classify pre-placement local meshes into
/// congruence groups, recovering each occurrence's canonical→local transform.
///
/// Holds no global state, so the production integration runs it as a rayon
/// POST-PASS over the finished mesh slice (sharded by signature, or merged) — NOT
/// inline on the parallel streaming hot path, where a shared lock serialises the
/// geometry workers (measured: stalls the 986MB stream).
#[derive(Default)]
pub struct RigidCache {
    templates: Vec<RigidTemplate>,
    buckets: FxHashMap<u64, Vec<usize>>,
}

/// Row-major canonical->local transform `C = translate(c_cand) · R · translate(-c_tmpl)`.
fn canonical_transform_row_major(
    r: &Matrix3<f64>,
    c_tmpl: &Vector3<f64>,
    c_cand: &Vector3<f64>,
) -> [f64; 16] {
    let t = c_cand - r * c_tmpl; // translation column
    [
        r[(0, 0)], r[(0, 1)], r[(0, 2)], t.x,
        r[(1, 0)], r[(1, 1)], r[(1, 2)], t.y,
        r[(2, 0)], r[(2, 1)], r[(2, 2)], t.z,
        0.0, 0.0, 0.0, 1.0,
    ]
}

impl RigidCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Classify a pre-placement LOCAL mesh: find a congruent template (exactly
    /// verified — bucket proposes, [`verify`] decides) or register this as a new
    /// one. `exact_rep` is the mesh's exact-bit rep_identity, reused as the rigid
    /// id when registering. Returns None if the mesh can't be welded (too
    /// tiny/large) — caller keeps the exact tier.
    pub fn classify(&mut self, mesh: &Mesh, exact_rep: u128) -> Option<RigidClass> {
        let w = build_welded(mesh)?;
        let keys = signature_keys(&w);
        // Search every bucket this mesh hashes into for a congruent template.
        let mut seen: rustc_hash::FxHashSet<usize> = rustc_hash::FxHashSet::default();
        for k in &keys {
            if let Some(bucket) = self.buckets.get(k) {
                for &idx in bucket {
                    if !seen.insert(idx) {
                        continue;
                    }
                    let tmpl = &self.templates[idx];
                    let out = verify(&tmpl.welded, &w);
                    if out.corresponded && out.connectivity_ok && out.max_dev <= SAFE_TOL {
                        let c = canonical_transform_row_major(
                            &out.rotation,
                            &tmpl.centroid,
                            &w.centroid,
                        );
                        return Some(RigidClass {
                            rigid_id: tmpl.rigid_id,
                            canonical_transform: Some(c),
                        });
                    }
                }
            }
        }
        // No congruent template: register this mesh as a new template (identity C).
        let idx = self.templates.len();
        let centroid = w.centroid;
        self.templates.push(RigidTemplate {
            welded: w,
            rigid_id: exact_rep,
            centroid,
        });
        for k in keys {
            self.buckets.entry(k).or_default().push(idx);
        }
        Some(RigidClass {
            rigid_id: exact_rep,
            canonical_transform: None,
        })
    }
}

/// Production POST-PASS entry point: classify the DISTINCT pre-placement local
/// meshes (one per exact-bit rep_identity — occurrences of one exact rep share
/// bit-identical local geometry, so they share a rigid group + canonical
/// transform) into an `exact_rep -> RigidClass` map. The caller applies it to
/// every occurrence's `InstanceMeta` (rep_identity := rigid_id, canonical_transform
/// := C), then collates by the rigid id.
///
/// Runs over the ~distinct set (tens of thousands), NOT every occurrence, and off
/// the streaming hot path — the architecture the inline attempt got wrong. A
/// future optimisation shards `locals` by primary signature for rayon parallelism
/// (congruent meshes share a signature bucket, so shards are independent).
pub fn build_rigid_map(locals: &[(u128, Mesh)]) -> std::collections::HashMap<u128, RigidClass> {
    let mut cache = RigidCache::new();
    let mut map = std::collections::HashMap::with_capacity(locals.len());
    for (exact_rep, mesh) in locals {
        if let Some(cls) = cache.classify(mesh, *exact_rep) {
            map.insert(*exact_rep, cls);
        }
    }
    map
}

// ----------------------------------------------------------------------------
// Welded local representation + rotation-invariant signature
// ----------------------------------------------------------------------------

struct Welded {
    /// Centred (centroid-subtracted) welded vertices, f64.
    verts: Vec<Vector3<f64>>,
    /// Triangles into `verts`.
    tris: Vec<[u32; 3]>,
    /// Per-vertex quantised distance-to-centroid descriptor (rotation+translation
    /// invariant); used to pick correspondence anchors.
    desc: Vec<i64>,
    /// Minimum inter-vertex spacing (for the ambiguous-correspondence exclusion).
    min_spacing: f64,
    /// Centroid of the welded vertices in LOCAL coords (subtracted from `verts`).
    /// Needed to compose the canonical→local transform `C_k` for the renderer.
    centroid: Vector3<f64>,
}

fn build_welded(mesh: &Mesh) -> Option<Welded> {
    let w = mesh.welded_by_position(WELD_EPS);
    let nv = w.positions.len() / 3;
    if nv < 4 || nv > MAX_VERTS || w.indices.is_empty() {
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
fn signature_keys(w: &Welded) -> Vec<u64> {
    // covariance about the (already-subtracted) centroid.
    let mut cov = Matrix3::zeros();
    for v in &w.verts {
        cov += v * v.transpose();
    }
    cov /= w.verts.len() as f64;
    let eig = cov.symmetric_eigenvalues();
    let mut ev = [eig[0], eig[1], eig[2]];
    ev.sort_by(|a, b| a.partial_cmp(b).unwrap());
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
struct VerifyOutcome {
    /// A correspondence + proper rotation was established (bijection ok).
    corresponded: bool,
    /// Max per-vertex world deviation under the recovered rotation (if corresponded).
    max_dev: f64,
    /// Triangle-set (adjacency) matched under the correspondence.
    connectivity_ok: bool,
    /// Reflection was the only fit (rejected — chiral pair).
    reflection_only: bool,
    /// Recovered proper rotation R (template-centred -> candidate-centred) for the
    /// connectivity-ok match; identity when not corresponded.
    rotation: Matrix3<f64>,
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
const AMBIG_SPACING: f64 = 2.0 * MATCH_RADIUS;

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
fn verify(t: &Welded, c: &Welded) -> VerifyOutcome {
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
    idx.sort_by(|&a, &b| eig.eigenvalues[a].partial_cmp(&eig.eigenvalues[b]).unwrap());
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

// ----------------------------------------------------------------------------
// Report
// ----------------------------------------------------------------------------

/// The Phase-0 decision metrics.
pub struct RigidDedupReport {
    pub total_occurrences: usize,
    pub distinct_exact: usize,
    pub analyzed: usize,
    pub skipped_large_or_tiny: usize,
    /// distinct templates after SAFE rigid merging (connectivity-gated).
    pub distinct_after_rigid: usize,
    pub exact_dedup: f64,
    pub safe_rigid_dedup: f64,
    /// merges accepted at SAFE_TOL with connectivity.
    pub safe_merges: usize,
    /// position-passed (<=SAFE_TOL) but connectivity FAILED — the false merges a
    /// naive position-only gate would have accepted (corruption avoided).
    pub connectivity_rejected: usize,
    /// reflection-only fits (chiral pairs correctly kept separate).
    pub reflection_only: usize,
    /// excluded for ambiguous (sub-tol) vertex spacing.
    pub ambiguous_excluded: usize,
    /// residual histogram: log10-binned max_dev of corresponded+connectivity-ok pairs.
    pub residual_hist: Vec<(String, usize)>,
    /// safe dedup at each swept tolerance (connectivity-gated).
    pub dedup_by_tol: Vec<(f64, f64)>,
    pub wall_ms: u128,
}

impl std::fmt::Display for RigidDedupReport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "===== Rigid-congruence dedup (Phase 0 measurement) =====")?;
        writeln!(
            f,
            "occurrences={} distinct_exact={} analyzed={} skipped(tiny/large)={}",
            self.total_occurrences, self.distinct_exact, self.analyzed, self.skipped_large_or_tiny
        )?;
        writeln!(
            f,
            "EXACT dedup        = {:.3}x  (baseline, shipped)",
            self.exact_dedup
        )?;
        writeln!(
            f,
            "SAFE RIGID dedup   = {:.3}x  (distinct {} -> {} after {} verified merges @ {:.0}µm + connectivity)",
            self.safe_rigid_dedup,
            self.distinct_exact,
            self.distinct_after_rigid,
            self.safe_merges,
            SAFE_TOL * 1.0e6
        )?;
        writeln!(
            f,
            "connectivity-rejected (naive false merges avoided) = {}",
            self.connectivity_rejected
        )?;
        writeln!(
            f,
            "reflection-only (chiral, kept separate) = {} | ambiguous-spacing excluded = {}",
            self.reflection_only, self.ambiguous_excluded
        )?;
        writeln!(f, "-- residual histogram (corresponded+connectivity-ok max-dev) --")?;
        for (bin, n) in &self.residual_hist {
            writeln!(f, "   {:<14} {}", bin, n)?;
        }
        writeln!(f, "-- safe dedup vs tolerance (connectivity-gated) --")?;
        for (tol, dd) in &self.dedup_by_tol {
            writeln!(f, "   tol={:>8.0}µm  -> {:.3}x", tol * 1.0e6, dd)?;
        }
        writeln!(f, "wall={}ms", self.wall_ms)?;
        write!(f, "========================================================")
    }
}

/// Run the rigid-congruence dedup measurement over the collected distinct local
/// meshes. `occ_counts` maps rep_identity -> streamed-occurrence count (from the
/// engine tally) so the dedup ratio is against true occurrences, not distinct.
pub fn analyze_rigid_dedup(
    locals: Vec<(u128, Mesh)>,
    occ_counts: &std::collections::HashMap<u128, usize>,
    elapsed_ms: u128,
) -> RigidDedupReport {
    let distinct_exact = locals.len();
    let total_occurrences: usize = locals
        .iter()
        .map(|(id, _)| occ_counts.get(id).copied().unwrap_or(1))
        .sum();

    // Build welded representations (skip tiny/large).
    let mut welded: Vec<(usize, Welded)> = Vec::new();
    let mut skipped = 0usize;
    for (i, (_, m)) in locals.iter().enumerate() {
        match build_welded(m) {
            Some(w) => welded.push((i, w)),
            None => skipped += 1,
        }
    }

    // Bucket by signature.
    let mut buckets: FxHashMap<u64, Vec<usize>> = FxHashMap::default();
    for (wi, (_, w)) in welded.iter().enumerate() {
        for k in signature_keys(w) {
            buckets.entry(k).or_default().push(wi);
        }
    }

    // Union-find over welded indices.
    let n = welded.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(parent: &mut [usize], x: usize) -> usize {
        let mut r = x;
        while parent[r] != r {
            r = parent[r];
        }
        let mut c = x;
        while parent[c] != c {
            let next = parent[c];
            parent[c] = r;
            c = next;
        }
        r
    }

    // Informational: meshes too dense for the NN-fallback path (the permutation
    // path can still verify them when bounded).
    let ambiguous_excluded = welded
        .iter()
        .filter(|(_, w)| w.min_spacing < AMBIG_SPACING)
        .count();
    let mut safe_merges = 0usize;
    let mut connectivity_rejected = 0usize;
    let mut reflection_only = 0usize;
    // residual log bins
    let bin_edges = [1e-6, 3e-6, 1e-5, 3e-5, 1e-4, 3e-4, 1e-3, 3e-3, 1e-2];
    let mut hist = vec![0usize; bin_edges.len() + 1];
    // record corresponded pairs (a<b welded idx, max_dev, connectivity_ok) for tol sweep
    let mut corr_pairs: Vec<(usize, usize, f64, bool)> = Vec::new();

    // Within each bucket, template-match: compare each member against established
    // representatives (the bucket's current union roots we've seen).
    let mut seen_in_pass: FxHashMap<u64, Vec<usize>> = FxHashMap::default();
    // Deduplicate bucket membership work: process each unordered pair at most once.
    let mut tried: std::collections::HashSet<(usize, usize)> = std::collections::HashSet::new();

    for (key, members) in &buckets {
        let reps = seen_in_pass.entry(*key).or_default();
        for &m in members {
            let mut matched = false;
            // compare against representatives already promoted in this bucket
            let reps_snapshot: Vec<usize> = reps.clone();
            for &rep in &reps_snapshot {
                let (a, b) = if rep < m { (rep, m) } else { (m, rep) };
                if a == b || !tried.insert((a, b)) {
                    continue;
                }
                let out = verify(&welded[a].1, &welded[b].1);
                if out.reflection_only {
                    reflection_only += 1;
                }
                if out.corresponded {
                    // histogram (connectivity-ok only — honest congruent residual)
                    if out.connectivity_ok {
                        let mut bi = bin_edges.len();
                        for (k, &edge) in bin_edges.iter().enumerate() {
                            if out.max_dev < edge {
                                bi = k;
                                break;
                            }
                        }
                        hist[bi] += 1;
                    }
                    corr_pairs.push((a, b, out.max_dev, out.connectivity_ok));
                    // SAFE merge decision
                    if out.max_dev <= SAFE_TOL {
                        if out.connectivity_ok {
                            let (ra, rb) = (find(&mut parent, a), find(&mut parent, b));
                            if ra != rb {
                                parent[ra] = rb;
                                safe_merges += 1;
                            }
                            matched = true;
                        } else {
                            connectivity_rejected += 1;
                        }
                    }
                }
                if matched {
                    break;
                }
            }
            if !matched {
                reps.push(m);
            }
        }
    }

    // distinct after rigid merge
    let mut roots: std::collections::HashSet<usize> = std::collections::HashSet::new();
    for i in 0..n {
        roots.insert(find(&mut parent, i));
    }
    let distinct_after_rigid = roots.len() + skipped;

    let exact_dedup = total_occurrences as f64 / distinct_exact.max(1) as f64;
    let safe_rigid_dedup = total_occurrences as f64 / distinct_after_rigid.max(1) as f64;

    // dedup by tol (connectivity-gated) via fresh union-find over corr_pairs
    let mut dedup_by_tol = Vec::new();
    for &tol in &TOL_SWEEP {
        let mut p2: Vec<usize> = (0..n).collect();
        for &(a, b, dev, conn) in &corr_pairs {
            if conn && dev <= tol {
                let ra = find(&mut p2, a);
                let rb = find(&mut p2, b);
                if ra != rb {
                    p2[ra] = rb;
                }
            }
        }
        let mut rs: std::collections::HashSet<usize> = std::collections::HashSet::new();
        for i in 0..n {
            rs.insert(find(&mut p2, i));
        }
        let distinct = rs.len() + skipped;
        dedup_by_tol.push((tol, total_occurrences as f64 / distinct.max(1) as f64));
    }

    let labels = [
        "<1µm", "1-3µm", "3-10µm", "10-30µm", "30-100µm", "100-300µm", "300µm-1mm", "1-3mm",
        "3-10mm", ">10mm",
    ];
    let residual_hist: Vec<(String, usize)> = labels
        .iter()
        .zip(hist.iter())
        .map(|(l, &n)| (l.to_string(), n))
        .collect();

    RigidDedupReport {
        total_occurrences,
        distinct_exact,
        analyzed: welded.len(),
        skipped_large_or_tiny: skipped,
        distinct_after_rigid,
        exact_dedup,
        safe_rigid_dedup,
        safe_merges,
        connectivity_rejected,
        reflection_only,
        ambiguous_excluded,
        residual_hist,
        dedup_by_tol,
        wall_ms: elapsed_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nalgebra::Rotation3;

    // A SCALENE (chiral, asymmetry-in-every-edge) tetra: all four vertices distinct
    // distances, no symmetry that would make its mirror a proper rotation.
    fn tetra() -> Mesh {
        let mut m = Mesh::new();
        m.positions = vec![
            0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.3, 0.4, 3.0,
        ];
        m.normals = vec![0.0; 12];
        m.indices = vec![0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3];
        m
    }

    fn rotate(m: &Mesh, axis: Vector3<f64>, ang: f64) -> Mesh {
        let r = Rotation3::from_axis_angle(&nalgebra::Unit::new_normalize(axis), ang);
        let mut out = m.clone();
        for v in out.positions.chunks_exact_mut(3) {
            let p = r * Vector3::new(v[0] as f64, v[1] as f64, v[2] as f64);
            v[0] = p.x as f32;
            v[1] = p.y as f32;
            v[2] = p.z as f32;
        }
        out
    }

    #[test]
    fn rotated_tetra_is_congruent() {
        let a = build_welded(&tetra()).unwrap();
        let b = build_welded(&rotate(&tetra(), Vector3::new(0.3, 1.0, 0.5), 0.9)).unwrap();
        let out = verify(&a, &b);
        assert!(out.corresponded, "should correspond");
        assert!(out.connectivity_ok, "connectivity should match");
        assert!(out.max_dev < 1.0e-4, "max_dev {} should be near f32 floor", out.max_dev);
    }

    #[test]
    fn reflected_tetra_is_not_proper_congruent() {
        let mut mirror = tetra();
        for v in mirror.positions.chunks_exact_mut(3) {
            v[0] = -v[0]; // reflect across YZ
        }
        let a = build_welded(&tetra()).unwrap();
        let b = build_welded(&mirror).unwrap();
        let out = verify(&a, &b);
        // Either flagged reflection-only, or no proper-rotation correspondence within tol.
        assert!(
            !(out.corresponded && out.connectivity_ok && out.max_dev <= SAFE_TOL),
            "a chiral mirror must not pass as a safe proper-rotation merge"
        );
    }

    #[test]
    fn different_shape_does_not_merge() {
        let mut big = tetra();
        for v in big.positions.iter_mut() {
            *v *= 2.0; // scaled tetra — congruent up to SCALE, not rigid
        }
        let a = build_welded(&tetra()).unwrap();
        let b = build_welded(&big).unwrap();
        let out = verify(&a, &b);
        assert!(
            out.max_dev > SAFE_TOL || !out.connectivity_ok || !out.corresponded,
            "a scaled (non-congruent) shape must not pass the safe gate"
        );
    }

    // ---- Adversarial fixture suite (HARD GATE: zero false merges) ----

    /// Does this pair pass the full SAFE merge gate (the production decision)?
    fn safe_merge(a: &Mesh, b: &Mesh) -> bool {
        let (wa, wb) = match (build_welded(a), build_welded(b)) {
            (Some(x), Some(y)) => (x, y),
            _ => return false,
        };
        let out = verify(&wa, &wb);
        out.corresponded && out.connectivity_ok && !out.reflection_only && out.max_dev <= SAFE_TOL
    }

    /// Axis-aligned box [0,dx]x[0,dy]x[0,dz], 8 verts / 12 triangles.
    fn box_mesh(dx: f32, dy: f32, dz: f32) -> Mesh {
        let mut m = Mesh::new();
        m.positions = vec![
            0.0, 0.0, 0.0, dx, 0.0, 0.0, dx, dy, 0.0, 0.0, dy, 0.0, // z=0
            0.0, 0.0, dz, dx, 0.0, dz, dx, dy, dz, 0.0, dy, dz, // z=dz
        ];
        m.normals = vec![0.0; 24];
        m.indices = vec![
            0, 1, 2, 0, 2, 3, // bottom
            4, 6, 5, 4, 7, 6, // top
            0, 4, 5, 0, 5, 1, // front
            1, 5, 6, 1, 6, 2, // right
            2, 6, 7, 2, 7, 3, // back
            3, 7, 4, 3, 4, 0, // left
        ];
        m
    }

    #[test]
    fn rotation_equivariance_all_rotations_merge() {
        // An asymmetric box rotated many ways must ALL be pairwise-congruent (the
        // win + determinism: every occurrence collapses to one template).
        let base = box_mesh(1.0, 2.0, 3.0);
        let angles = [
            (Vector3::new(1.0, 0.0, 0.0), 0.4),
            (Vector3::new(0.0, 1.0, 0.0), 1.1),
            (Vector3::new(0.0, 0.0, 1.0), 2.3),
            (Vector3::new(1.0, 1.0, 0.0), 0.7),
            (Vector3::new(0.2, 1.0, 0.5), 2.9),
            (Vector3::new(1.0, 0.3, 0.8), 1.7),
        ];
        let rotated: Vec<Mesh> = angles.iter().map(|(ax, a)| rotate(&base, *ax, *a)).collect();
        for (i, a) in rotated.iter().enumerate() {
            for (j, b) in rotated.iter().enumerate().skip(i + 1) {
                assert!(safe_merge(a, b), "two rotations of one box must merge ({i}-{j})");
            }
        }
    }

    #[test]
    fn thin_beam_rotations_merge() {
        // The high-value rotation-baked-steel target: a long thin member at
        // different orientations must merge.
        // Non-square cross-section (like an asymmetric steel section): distinct
        // λ1≠λ2 so the PCA frame is well-defined. Fully-square/round (degenerate)
        // sections are a documented conservative under-merge, not handled here.
        let beam = box_mesh(0.1, 0.3, 5.0);
        let a = rotate(&beam, Vector3::new(0.0, 1.0, 0.0), 1.2);
        let b = rotate(&beam, Vector3::new(0.3, 0.4, 1.0), 2.5);
        assert!(safe_merge(&a, &b), "thin beam rotations must merge");
    }

    #[test]
    fn flipped_quad_diagonal_same_cloud_stays_split() {
        // Same vertex cloud, different triangulation (split AC vs BD) — the
        // documented #1 false-merge path. The connectivity gate must reject it.
        let mut quad_ac = Mesh::new();
        quad_ac.positions = vec![
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.2, 0.0, 1.0, 0.0,
        ];
        quad_ac.normals = vec![0.0; 12];
        quad_ac.indices = vec![0, 1, 2, 0, 2, 3]; // diagonal 0-2
        let mut quad_bd = quad_ac.clone();
        quad_bd.indices = vec![0, 1, 3, 1, 2, 3]; // diagonal 1-3 (non-planar -> different surface)
        assert!(
            !safe_merge(&quad_ac, &quad_bd),
            "same cloud, different triangulation (non-planar) must NOT merge"
        );
    }

    #[test]
    fn perturbed_vertex_stays_split() {
        // A box with one corner moved 1mm is a genuinely different shape; even
        // though counts + rough size match, the max-deviation gate must reject.
        let a = box_mesh(1.0, 2.0, 3.0);
        let mut b = a.clone();
        b.positions[0] += 0.001; // move corner 0 by 1mm (>> 30µm gate)
        assert!(
            !safe_merge(&a, &b),
            "a 1mm-perturbed corner must not pass the 30µm gate"
        );
    }

    #[test]
    fn coincident_vertices_no_panic_no_false_merge() {
        // A mesh with a near-coincident vertex pair vs a genuinely different box
        // sharing vertex/triangle counts: must not panic and must not false-merge.
        let mut dense = box_mesh(1.0, 2.0, 3.0);
        dense.positions[3] = 1.0e-7; // nudge corner 1 to near-coincide with corner 0 axis
        let other = box_mesh(2.0, 2.0, 2.0);
        assert!(!safe_merge(&dense, &other), "different shapes must not merge");
    }

    #[test]
    fn rigid_cache_groups_congruent_and_separates_different() {
        let mut cache = RigidCache::new();
        // First tetra registers as a template (identity C).
        let t0 = cache.classify(&tetra(), 100).unwrap();
        assert_eq!(t0.rigid_id, 100);
        assert!(t0.canonical_transform.is_none(), "template has identity C");
        // A rotated copy must join the SAME template (rigid_id 100, not 200) with a
        // non-identity canonical transform.
        let rot = rotate(&tetra(), Vector3::new(0.4, 1.0, 0.2), 1.3);
        let t1 = cache.classify(&rot, 200).unwrap();
        assert_eq!(t1.rigid_id, 100, "rotated copy joins the template");
        assert!(t1.canonical_transform.is_some(), "rotated copy has a recovered C");
        // A scaled (non-congruent) tetra must register as a NEW template.
        let mut scaled = tetra();
        for v in scaled.positions.iter_mut() {
            *v *= 1.7;
        }
        let t2 = cache.classify(&scaled, 300).unwrap();
        assert_eq!(t2.rigid_id, 300, "non-congruent shape is a new template");
    }

    #[test]
    fn build_rigid_map_groups_distinct_locals() {
        let rot = rotate(&tetra(), Vector3::new(0.4, 1.0, 0.2), 1.3);
        let mut scaled = tetra();
        for v in scaled.positions.iter_mut() {
            *v *= 1.7;
        }
        let locals = vec![(100u128, tetra()), (200u128, rot), (300u128, scaled)];
        let map = build_rigid_map(&locals);
        // 100 and 200 are congruent -> same rigid id; 300 is its own.
        assert_eq!(map[&100].rigid_id, map[&200].rigid_id);
        assert_ne!(map[&100].rigid_id, map[&300].rigid_id);
        let distinct: std::collections::HashSet<u128> =
            map.values().map(|c| c.rigid_id).collect();
        assert_eq!(distinct.len(), 2, "3 exact locals -> 2 rigid templates");
    }

    #[test]
    fn translated_copy_merges() {
        // Pure translation (no rotation) of an asymmetric shape must merge.
        let a = tetra();
        let mut b = a.clone();
        for v in b.positions.chunks_exact_mut(3) {
            v[0] += 12.0;
            v[1] -= 7.0;
            v[2] += 3.0;
        }
        assert!(safe_merge(&a, &b), "a translated copy must merge");
    }
}
