// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! B4.4 - the M3 kernel-adjoint spike.
//!
//! Runs the **production** extrusion mesher (`extrusion::extrude_rings_into`,
//! of which `extrude_profile` is the `f64` instantiation) with a forward-mode
//! dual number as its scalar, and compares the resulting analytic gradient of
//! the divergence-theorem volume against central finite differences on a
//! seeded battery over the rectangular-extrusion family's parameter box.
//!
//! See `scripts/moonshot/b44-kernel-adjoint/DESIGN.md` for the protocol, the
//! forward-value cross-check and the verdict. Run with:
//!
//! ```text
//! cargo test -p ifc-lite-geometry --lib --release b44 -- --nocapture
//! ```

use crate::extrusion_generic::{apply_transform_generic, extrude_rings_into};
use crate::mesh::Mesh;
use crate::processors::extrusion::extrusion_local_transform;
use crate::profile_generic::rectangle_ring;
use crate::scalar::{GeomScalar, MeshSink};
use nalgebra::{Matrix4, Point2, Point3, Vector3};
use std::ops::{Add, Div, Mul, Neg, Sub};

/// Relative tolerance from the pre-committed exam.
const TOL: f64 = 1e-6;
/// Pass bar from the pre-committed exam.
const BAR: f64 = 0.95;
const NPOINTS: usize = 200;

// ---------------------------------------------------------------------------
// Forward-mode dual number
// ---------------------------------------------------------------------------

/// Forward-mode dual number carrying `N` partial derivatives.
#[derive(Copy, Clone, Debug)]
pub struct Dual<const N: usize> {
    v: f64,
    d: [f64; N],
}

impl<const N: usize> PartialEq for Dual<N> {
    fn eq(&self, other: &Self) -> bool {
        self.v == other.v && self.d == other.d
    }
}

impl<const N: usize> Dual<N> {
    fn constant(v: f64) -> Self {
        Self { v, d: [0.0; N] }
    }
    fn variable(v: f64, i: usize) -> Self {
        let mut d = [0.0; N];
        d[i] = 1.0;
        Self { v, d }
    }
}

impl<const N: usize> Add for Dual<N> {
    type Output = Self;
    fn add(self, o: Self) -> Self {
        let mut d = [0.0; N];
        for i in 0..N {
            d[i] = self.d[i] + o.d[i];
        }
        Self { v: self.v + o.v, d }
    }
}
impl<const N: usize> Sub for Dual<N> {
    type Output = Self;
    fn sub(self, o: Self) -> Self {
        let mut d = [0.0; N];
        for i in 0..N {
            d[i] = self.d[i] - o.d[i];
        }
        Self { v: self.v - o.v, d }
    }
}
impl<const N: usize> Mul for Dual<N> {
    type Output = Self;
    fn mul(self, o: Self) -> Self {
        let mut d = [0.0; N];
        for i in 0..N {
            d[i] = self.d[i] * o.v + self.v * o.d[i];
        }
        Self { v: self.v * o.v, d }
    }
}
impl<const N: usize> Div for Dual<N> {
    type Output = Self;
    fn div(self, o: Self) -> Self {
        // `self.v / o.v`, NOT `self.v * (1/o.v)`: the primal must be bit-identical
        // to what the `f64` instantiation of the mesher computes.
        let q = self.v / o.v;
        let mut d = [0.0; N];
        for i in 0..N {
            d[i] = (self.d[i] - q * o.d[i]) / o.v;
        }
        Self { v: q, d }
    }
}
impl<const N: usize> Neg for Dual<N> {
    type Output = Self;
    fn neg(self) -> Self {
        let mut d = [0.0; N];
        for i in 0..N {
            d[i] = -self.d[i];
        }
        Self { v: -self.v, d }
    }
}

impl<const N: usize> GeomScalar for Dual<N> {
    fn from_f64(v: f64) -> Self {
        Self::constant(v)
    }
    fn value(self) -> f64 {
        self.v
    }
    fn sqrt(self) -> Self {
        let s = self.v.sqrt();
        let k = 0.5 / s;
        let mut d = [0.0; N];
        for i in 0..N {
            d[i] = self.d[i] * k;
        }
        Self { v: s, d }
    }
    fn abs(self) -> Self {
        if self.v < 0.0 {
            -self
        } else {
            self
        }
    }
    fn min(self, o: Self) -> Self {
        if self.v <= o.v {
            self
        } else {
            o
        }
    }
    fn max(self, o: Self) -> Self {
        if self.v >= o.v {
            self
        } else {
            o
        }
    }
}

// ---------------------------------------------------------------------------
// A non-quantising mesh sink
// ---------------------------------------------------------------------------

/// A mesh sink that stores positions in the scalar itself.
///
/// Production's [`Mesh`] stores `f32`, which is a staircase function of its
/// inputs and therefore not differentiable; this sink is the same mesher
/// writing into full-precision storage. Normals are dropped: the
/// divergence-theorem volume is a function of positions and indices only.
struct RawMesh<S: GeomScalar> {
    positions: Vec<Point3<S>>,
    indices: Vec<u32>,
}

impl<S: GeomScalar> RawMesh<S> {
    fn new() -> Self {
        Self {
            positions: Vec::new(),
            indices: Vec::new(),
        }
    }
}

impl<S: GeomScalar> MeshSink<S> for RawMesh<S> {
    fn vertex_count(&self) -> usize {
        self.positions.len()
    }
    fn reserve(&mut self, vertices: usize, indices: usize) {
        self.positions.reserve(vertices);
        self.indices.reserve(indices);
    }
    fn add_vertex(&mut self, position: Point3<S>, _normal: Vector3<S>) {
        self.positions.push(position);
    }
    fn add_triangle(&mut self, i0: u32, i1: u32, i2: u32) {
        self.indices.push(i0);
        self.indices.push(i1);
        self.indices.push(i2);
    }
    fn position(&self, index: usize) -> Point3<S> {
        self.positions[index]
    }
    fn set_position(&mut self, index: usize, position: Point3<S>) {
        self.positions[index] = position;
    }
    fn transform_normals(&mut self, _transform: &Matrix4<S>) {}
}

// ---------------------------------------------------------------------------
// The differentiated quantity
// ---------------------------------------------------------------------------

/// Divergence-theorem volume of a triangle soup: `|1/6 sum a . (b x c)|`.
///
/// Identical in form to the reference implementation used by the M3 spike's
/// `kernel-check.mjs` (`scripts/moonshot/diff-spike/`).
fn divergence_volume<S: GeomScalar>(positions: &[Point3<S>], indices: &[u32]) -> S {
    let mut six = S::from_f64(0.0);
    for t in indices.chunks_exact(3) {
        let a = positions[t[0] as usize];
        let b = positions[t[1] as usize];
        let c = positions[t[2] as usize];
        six = six
            + (a.x * (b.y * c.z - b.z * c.y) - a.y * (b.x * c.z - b.z * c.x)
                + a.z * (b.x * c.y - b.y * c.x));
    }
    (six / S::from_f64(6.0)).abs()
}

/// The same functional over production's f32 mesh buffers.
fn divergence_volume_f32(mesh: &Mesh) -> f64 {
    let mut six = 0.0f64;
    for t in mesh.indices.chunks_exact(3) {
        let p = |i: u32| -> [f64; 3] {
            let i = i as usize * 3;
            [
                mesh.positions[i] as f64,
                mesh.positions[i + 1] as f64,
                mesh.positions[i + 2] as f64,
            ]
        };
        let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
        six += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
    (six / 6.0).abs()
}

// ---------------------------------------------------------------------------
// The rectangular-extrusion family
// ---------------------------------------------------------------------------

/// Family A: `IfcExtrudedAreaSolid` over an `IfcRectangleProfileDef`.
///
/// | i | parameter | meaning |
/// |---|---|---|
/// | 0 | `xdim`  | rectangle X dimension (m) |
/// | 1 | `ydim`  | rectangle Y dimension (m) |
/// | 2 | `depth` | extrusion depth (m) |
/// | 3 | `dirx`  | ExtrudedDirection ratio X |
/// | 4 | `diry`  | ExtrudedDirection ratio Y |
/// | 5 | `dirz`  | ExtrudedDirection ratio Z |
/// | 6 | `px`    | ObjectPlacement translation X |
/// | 7 | `py`    | ObjectPlacement translation Y |
/// | 8 | `pz`    | ObjectPlacement translation Z |
/// | 9 | `theta` | ObjectPlacement rotation about Z (rad) |
const NAMES_A: [&str; 10] = [
    "xdim", "ydim", "depth", "dirx", "diry", "dirz", "px", "py", "pz", "theta",
];
const NA: usize = 10;

/// Family B: family A plus a rectangular hole in the profile
/// (`IfcArbitraryProfileDefWithVoids` / `IfcRectangleHollowProfileDef` shape).
const NAMES_B: [&str; 14] = [
    "xdim", "ydim", "depth", "dirx", "diry", "dirz", "px", "py", "pz", "theta", "hcx", "hcy",
    "hw", "hh",
];
const NB: usize = 14;

/// The placement matrix (rotation about Z, then translation).
///
/// This step is harness-side: in production it comes out of
/// `parse_axis2_placement_3d`, which reads decoded IFC attributes and cannot be
/// made generic over the scalar. It is a rigid transform, so it contributes
/// exactly zero to the volume gradient - which is precisely why parameters
/// 6..9 are in the box: they are the battery's exact-zero controls.
fn placement<S: GeomScalar>(px: S, py: S, pz: S, theta: S) -> Matrix4<S> {
    let zero = S::from_f64(0.0);
    let one = S::from_f64(1.0);
    // cos/sin are not on GeomScalar (the mesher never needs them); evaluate the
    // rotation analytically in dual arithmetic here.
    let (c, s) = dual_cos_sin(theta);
    #[rustfmt::skip]
    let m = Matrix4::new(
        c,    -s,   zero, px,
        s,     c,   zero, py,
        zero, zero, one,  pz,
        zero, zero, zero, one,
    );
    m
}

/// `(cos t, sin t)` for any [`GeomScalar`], via a first-order expansion around
/// the primal. Exact for `f64`; exact to first order (which is all a
/// forward-mode dual carries) for `Dual`.
fn dual_cos_sin<S: GeomScalar>(t: S) -> (S, S) {
    let tv = t.value();
    let (c, s) = (tv.cos(), tv.sin());
    // d(cos)/dt = -sin, d(sin)/dt = cos; chain through t's own derivative by
    // writing the result as `const + (-sin) * (t - const_t)`.
    let dt = t - S::from_f64(tv);
    (
        S::from_f64(c) + S::from_f64(-s) * dt,
        S::from_f64(s) + S::from_f64(c) * dt,
    )
}

/// Build the profile rings for a point of the family.
///
/// The outer ring comes from the production `rectangle_ring` (shared with
/// `IfcRectangleProfileDef`). The optional hole is a CW rectangle.
fn rings<S: GeomScalar>(x: &[S], with_hole: bool) -> (Vec<Point2<S>>, Vec<Vec<Point2<S>>>) {
    let outer = rectangle_ring(x[0], x[1]);
    let mut holes = Vec::new();
    if with_hole {
        let (cx, cy, hw, hh) = (x[10], x[11], x[12], x[13]);
        // Clockwise, so the mesher's winding-sign logic faces the walls into
        // the void (the production convention for `Profile2D::holes`).
        holes.push(vec![
            Point2::new(cx - hw, cy - hh),
            Point2::new(cx - hw, cy + hh),
            Point2::new(cx + hw, cy + hh),
            Point2::new(cx + hw, cy - hh),
        ]);
    }
    (outer, holes)
}

/// The full parameters -> mesh -> volume chain, generic over the scalar.
///
/// Every step between the profile ring and the volume is production code:
/// `extrusion_local_transform` (the `ExtrudedAreaSolid` direction handling),
/// `extrude_rings_into` (the mesher: aspect-ratio veto, ear-clipped caps,
/// side walls, hole walls, placement transform) and `divergence_volume`.
fn forward<S: GeomScalar>(x: &[S], with_hole: bool) -> S {
    let (outer, holes) = rings(x, with_hole);
    let direction = Vector3::new(x[3], x[4], x[5]);
    let depth = x[2];
    let local = extrusion_local_transform(&direction, depth);
    let mut mesh = RawMesh::<S>::new();
    extrude_rings_into(&outer, &holes, depth, local, &mut mesh)
        .expect("rectangular extrusion must mesh");
    let place = placement(x[6], x[7], x[8], x[9]);
    apply_transform_generic(&mut mesh, &place);
    divergence_volume(&mesh.positions, &mesh.indices)
}

/// The same chain through the **production** entry points, ending in
/// production's `f32` [`Mesh`]. Used only for the forward-value cross-check.
fn forward_production(x: &[f64], with_hole: bool) -> f64 {
    let (outer, holes) = rings(x, with_hole);
    let mut profile = crate::profile::Profile2D::new(outer);
    for h in holes {
        profile.add_hole(h);
    }
    let direction = Vector3::new(x[3], x[4], x[5]);
    let local = extrusion_local_transform(&direction, x[2]);
    let mut mesh = crate::extrusion::extrude_profile(&profile, x[2], local).unwrap();
    crate::extrusion::apply_transform(&mut mesh, &placement(x[6], x[7], x[8], x[9]));
    divergence_volume_f32(&mesh)
}

// ---------------------------------------------------------------------------
// Seeded sampling
// ---------------------------------------------------------------------------

struct Rng(u64);
impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed | 1)
    }
    fn next_u64(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + self.unit() * (hi - lo)
    }
}

/// Draw one point of the parameter box.
///
/// Half the draws are axis-aligned extrusions (`dirx = diry = 0`, the common
/// IFC case, and for negative `dirz` the downward-opening case that adds the
/// `-depth` translation); half are sheared extrusions well clear of the
/// mesher's `|d| < 0.001` axis-alignment threshold.
fn sample(rng: &mut Rng, with_hole: bool) -> Vec<f64> {
    let mut x = vec![0.0; if with_hole { NB } else { NA }];
    x[0] = rng.range(0.2, 6.0);
    x[1] = rng.range(0.2, 6.0);
    x[2] = rng.range(0.2, 8.0);
    if rng.next_u64().is_multiple_of(2) {
        x[3] = 0.0;
        x[4] = 0.0;
        x[5] = if rng.next_u64().is_multiple_of(2) { 1.0 } else { -1.0 };
    } else {
        let sx = if rng.next_u64().is_multiple_of(2) { 1.0 } else { -1.0 };
        let sy = if rng.next_u64().is_multiple_of(2) { 1.0 } else { -1.0 };
        x[3] = sx * rng.range(0.05, 0.6);
        x[4] = sy * rng.range(0.05, 0.6);
        x[5] = rng.range(0.4, 1.2);
    }
    x[6] = rng.range(-30.0, 30.0);
    x[7] = rng.range(-30.0, 30.0);
    x[8] = rng.range(-10.0, 10.0);
    x[9] = rng.range(-std::f64::consts::PI, std::f64::consts::PI);
    if with_hole {
        // Hole strictly inside the outer rectangle, with margin.
        let hw = rng.range(0.05, 0.30) * x[0];
        let hh = rng.range(0.05, 0.30) * x[1];
        let free_x = x[0] / 2.0 - hw;
        let free_y = x[1] / 2.0 - hh;
        x[10] = rng.range(-0.6 * free_x, 0.6 * free_x);
        x[11] = rng.range(-0.6 * free_y, 0.6 * free_y);
        x[12] = hw;
        x[13] = hh;
    }
    x
}

// ---------------------------------------------------------------------------
// The battery
// ---------------------------------------------------------------------------


/// Parameters the divergence functional is **provably invariant** under, declared
/// a priori from the mathematics rather than from the results:
///
/// * `px`, `py`, `pz`, `theta` - the placement is a rigid motion, and the
///   divergence functional of a closed surface is invariant under rigid motions
///   (`d/dt` of a translation contributes `t . closed(n) dA = 0`).
/// * `hcx`, `hcy` (family B) - translating a void inside the profile changes no
///   area, hence no volume.
///
/// Their analytic gradient is exactly zero, and **central finite differences
/// cannot adjudicate a zero derivative**: the FD estimate is pure cancellation
/// noise of size `~ eps * C / h` (C = the conditioning of the divergence sum,
/// which at world-scale placement is `~|p|^3 * ntri` >> the volume itself), so
/// any relative comparison against it is a comparison against noise. This is
/// the same effect that produced 22 of `diff-spike/battery.mjs`'s 23 failures;
/// here it is declared up front and tested with the criterion that is actually
/// meaningful (the analytic gradient must BE zero, to `TOL` of the gradient
/// vector's own scale), with the FD noise reported alongside.
fn invariant_mask(nparams: usize) -> Vec<bool> {
    let mut m = vec![false; nparams];
    for i in 6..10 {
        m[i] = true; // px, py, pz, theta
    }
    if nparams == NB {
        m[10] = true; // hcx
        m[11] = true; // hcy
    }
    m
}

#[derive(Default, Clone)]
struct Stats {
    npoints: usize,
    nparams: usize,
    /// Points where every component passed the pre-registered criterion.
    passed: usize,
    /// Points where every component passed the strict `diff-spike` metric
    /// (`|ad-fd| / max(|ad|,|fd|,1e-6) <= 1e-6`), including the invariant ones.
    passed_strict: usize,
    /// Points where every ACTIVE component passed the strict `diff-spike`
    /// metric - the apples-to-apples comparison with B3.3's 97.7%.
    passed_strict_active: usize,
    /// Active (volume-bearing) components, graded by strict relative agreement
    /// with central finite differences. This is the headline number.
    active: usize,
    active_passed: usize,
    max_rel_err_active: f64,
    max_rel_err_active_where: String,
    /// Invariant components, graded by "the analytic gradient is zero".
    invariant: usize,
    invariant_passed: usize,
    max_invariant_ad_ratio: f64,
    /// Largest |fd| observed on an invariant component (pure FD noise).
    max_invariant_fd: f64,
    failures: Vec<String>,
    /// Forward-value cross-checks.
    max_fwd_abs_dev_f64: f64,
    max_fwd_rel_dev_production: f64,
    max_fwd_rel_dev_production_local: f64,
    max_oracle_rel_dev: f64,
}

/// Closed form of the divergence functional the mesher's emitted mesh carries.
///
/// Family A (solid): `det(shear) * xdim * ydim * depth`, i.e. the true volume.
/// Family B (with a void): `det(shear) * depth * (A_outer + A_hole / 3)`.
/// The `+ A_hole/3` is **not** a typo and not the solid's volume: see DESIGN.md
/// section "the hole-wall orientation finding". Verified below to 1e-13.
fn oracle(x: &[f64], with_hole: bool) -> f64 {
    let dirn = (x[3] * x[3] + x[4] * x[4] + x[5] * x[5]).sqrt();
    let det = (x[5] / dirn).abs();
    let a_outer = x[0] * x[1];
    let a_hole = if with_hole { 4.0 * x[12] * x[13] } else { 0.0 };
    det * x[2] * (a_outer + a_hole / 3.0)
}

fn run_family<const N: usize>(seed: u64, npoints: usize, with_hole: bool, names: &[&str]) -> Stats {
    let mut rng = Rng::new(seed);
    let inv = invariant_mask(N);
    let mut st = Stats {
        nparams: N,
        ..Default::default()
    };

    for k in 0..npoints {
        let x = sample(&mut rng, with_hole);

        // --- analytic gradient through the real mesher ---------------------
        let dual_x: Vec<Dual<N>> = x
            .iter()
            .enumerate()
            .map(|(i, v)| Dual::<N>::variable(*v, i))
            .collect();
        let out = forward(&dual_x, with_hole);
        let ad = out.d;
        let v_dual = out.v;
        let ad_scale = ad.iter().fold(0.0f64, |a, b| a.max(b.abs()));

        // --- forward-value cross-checks ------------------------------------
        // (1) the same generic mesher at f64, non-quantising: must be exact.
        let v_f64 = forward(&x, with_hole);
        st.max_fwd_abs_dev_f64 = st.max_fwd_abs_dev_f64.max((v_f64 - v_dual).abs());
        // (2) the production path, ending in the f32 `Mesh`, at world placement.
        let v_prod = forward_production(&x, with_hole);
        st.max_fwd_rel_dev_production = st
            .max_fwd_rel_dev_production
            .max((v_prod - v_dual).abs() / v_dual.abs().max(1e-30));
        // (3) the same, in the element's local frame (placement zeroed), which
        //     is how production actually stores world-placed meshes (`Mesh::origin`).
        let mut xl = x.clone();
        xl[6] = 0.0;
        xl[7] = 0.0;
        xl[8] = 0.0;
        xl[9] = 0.0;
        let v_local_dual = forward(&xl, with_hole);
        let v_local_prod = forward_production(&xl, with_hole);
        st.max_fwd_rel_dev_production_local = st
            .max_fwd_rel_dev_production_local
            .max((v_local_prod - v_local_dual).abs() / v_local_dual.abs().max(1e-30));
        // (4) the closed-form oracle for the family.
        let v_oracle = oracle(&x, with_hole);
        st.max_oracle_rel_dev = st
            .max_oracle_rel_dev
            .max((v_oracle - v_dual).abs() / v_oracle.abs().max(1e-30));

        // --- central finite differences ------------------------------------
        let mut point_ok = true;
        let mut point_ok_strict = true;
        let mut point_ok_strict_active = true;
        for i in 0..N {
            let h = 1e-5 * x[i].abs().max(1.0);
            let mut xp = x.clone();
            xp[i] += h;
            let mut xm = x.clone();
            xm[i] -= h;
            let fd = (forward(&xp, with_hole) - forward(&xm, with_hole)) / (2.0 * h);
            let a = ad[i];
            let diff = (a - fd).abs();

            // Strict `diff-spike` metric, reported for comparability with B3.3.
            if diff / a.abs().max(fd.abs()).max(1e-6) > TOL {
                point_ok_strict = false;
                if !inv[i] {
                    point_ok_strict_active = false;
                }
            }

            let ok = if inv[i] {
                st.invariant += 1;
                st.max_invariant_fd = st.max_invariant_fd.max(fd.abs());
                let ratio = if ad_scale > 0.0 { a.abs() / ad_scale } else { a.abs() };
                st.max_invariant_ad_ratio = st.max_invariant_ad_ratio.max(ratio);
                let ok = ratio <= TOL;
                if ok {
                    st.invariant_passed += 1;
                }
                ok
            } else {
                st.active += 1;
                let rel = diff / a.abs().max(fd.abs()).max(1e-300);
                let ok = diff <= TOL * a.abs().max(fd.abs());
                if ok {
                    st.active_passed += 1;
                }
                if rel > st.max_rel_err_active {
                    st.max_rel_err_active = rel;
                    st.max_rel_err_active_where =
                        format!("point {k} / {} (ad {a:.9e}, fd {fd:.9e})", names[i]);
                }
                ok
            };

            if !ok {
                point_ok = false;
                if st.failures.len() < 20 {
                    st.failures.push(format!(
                        "point {k} / {} ({}): |ad-fd| {diff:.3e}, ad {a:.9e}, fd {fd:.9e}",
                        names[i],
                        if inv[i] { "invariant" } else { "active" }
                    ));
                }
            }
        }
        if point_ok {
            st.passed += 1;
        }
        if point_ok_strict {
            st.passed_strict += 1;
        }
        if point_ok_strict_active {
            st.passed_strict_active += 1;
        }
        st.npoints += 1;
    }
    st
}

fn report(label: &str, st: &Stats) -> String {
    let frac = st.passed as f64 / st.npoints as f64;
    let mut s = String::new();
    s.push_str(&format!("\n=== {label} ===\n"));
    s.push_str(&format!(
        "{} points x {} params = {} components ({} active, {} invariant)\n",
        st.npoints,
        st.nparams,
        st.npoints * st.nparams,
        st.active,
        st.invariant
    ));
    s.push_str(&format!(
        "POINTS PASSED: {}/{} = {:.2}%   [bar {:.0}%]  -> {}\n",
        st.passed,
        st.npoints,
        frac * 100.0,
        BAR * 100.0,
        if frac >= BAR { "PASS" } else { "FAIL" }
    ));
    s.push_str(&format!(
        "  active components (strict relative vs central FD, tol {TOL:.0e}): {}/{} passed, max rel err {:.3e} at {}\n",
        st.active_passed, st.active, st.max_rel_err_active, st.max_rel_err_active_where
    ));
    s.push_str(&format!(
        "  invariant components (analytic gradient must be 0): {}/{} passed, max |ad|/||ad||_inf {:.3e}; max |fd| (FD noise) {:.3e}\n",
        st.invariant_passed, st.invariant, st.max_invariant_ad_ratio, st.max_invariant_fd
    ));
    s.push_str(&format!(
        "  diff-spike metric (floor 1e-6), ACTIVE components only: {}/{} points = {:.2}%\n",
        st.passed_strict_active,
        st.npoints,
        st.passed_strict_active as f64 / st.npoints as f64 * 100.0
    ));
    s.push_str(&format!(
        "  diff-spike metric (floor 1e-6), ALL components: {}/{} points = {:.2}% (see DESIGN.md: FD cannot adjudicate a zero derivative)\n",
        st.passed_strict,
        st.npoints,
        st.passed_strict as f64 / st.npoints as f64 * 100.0
    ));
    s.push_str(&format!(
        "forward x-check  dual primal vs generic-f64 mesher : max abs dev {:.3e}\n",
        st.max_fwd_abs_dev_f64
    ));
    s.push_str(&format!(
        "forward x-check  vs PRODUCTION f32 mesh (world)    : max rel dev {:.3e}\n",
        st.max_fwd_rel_dev_production
    ));
    s.push_str(&format!(
        "forward x-check  vs PRODUCTION f32 mesh (local frm): max rel dev {:.3e}\n",
        st.max_fwd_rel_dev_production_local
    ));
    s.push_str(&format!(
        "forward x-check  vs closed-form oracle             : max rel dev {:.3e}\n",
        st.max_oracle_rel_dev
    ));
    for w in &st.failures {
        s.push_str(&format!("  FAIL {w}\n"));
    }
    s
}

fn json(label: &str, st: &Stats) -> String {
    let frac = st.passed as f64 / st.npoints as f64;
    format!(
        concat!(
            r#"{{"family":"{}","npoints":{},"nparams":{},"passed":{},"fraction":{:.6},"#,
            r#""passedStrictDiffSpikeAll":{},"passedStrictDiffSpikeActive":{},"activeComponents":{},"activePassed":{},"#,
            r#""maxRelErrActive":{:.6e},"invariantComponents":{},"invariantPassed":{},"#,
            r#""maxInvariantAdRatio":{:.6e},"maxInvariantFdNoise":{:.6e},"#,
            r#""maxFwdAbsDevDualVsF64":{:.6e},"maxFwdRelDevProductionWorld":{:.6e},"#,
            r#""maxFwdRelDevProductionLocal":{:.6e},"maxOracleRelDev":{:.6e},"#,
            r#""bar":{},"verdict":"{}"}}"#
        ),
        label,
        st.npoints,
        st.nparams,
        st.passed,
        frac,
        st.passed_strict,
        st.passed_strict_active,
        st.active,
        st.active_passed,
        st.max_rel_err_active,
        st.invariant,
        st.invariant_passed,
        st.max_invariant_ad_ratio,
        st.max_invariant_fd,
        st.max_fwd_abs_dev_f64,
        st.max_fwd_rel_dev_production,
        st.max_fwd_rel_dev_production_local,
        st.max_oracle_rel_dev,
        BAR,
        if frac >= BAR { "PASS" } else { "FAIL" }
    )
}

#[test]
fn b44_kernel_adjoint_battery() {
    let runs = [
        ("A/seed-20260727", run_family::<NA>(20260727, NPOINTS, false, &NAMES_A)),
        ("B/seed-20260727", run_family::<NB>(20260727, NPOINTS, true, &NAMES_B)),
        ("A/seed-7", run_family::<NA>(7, NPOINTS, false, &NAMES_A)),
        ("B/seed-7", run_family::<NB>(7, NPOINTS, true, &NAMES_B)),
        ("A/seed-2026", run_family::<NA>(2026, NPOINTS, false, &NAMES_A)),
        ("B/seed-2026", run_family::<NB>(2026, NPOINTS, true, &NAMES_B)),
    ];
    for (label, st) in &runs {
        println!("{}", report(label, st));
    }
    println!("B44_JSON_BEGIN");
    let body: Vec<String> = runs.iter().map(|(l, s)| json(l, s)).collect();
    println!("[{}]", body.join(","));
    println!("B44_JSON_END");

    for (label, st) in &runs {
        let frac = st.passed as f64 / st.npoints as f64;
        assert!(frac >= BAR, "family {label}: {frac:.4} below the {BAR} bar");
    }
}

/// The dual instantiation of the mesher must reproduce the `f64` instantiation's
/// positions **bit for bit** in its primal part - otherwise the adjoints belong
/// to a different function than the one production computes.
#[test]
fn b44_dual_primal_is_bit_identical_to_f64_mesher() {
    let mut rng = Rng::new(4242);
    for with_hole in [false, true] {
        for _ in 0..200 {
            let x = sample(&mut rng, with_hole);
            let (outer, holes) = rings(&x, with_hole);
            let mut m64 = RawMesh::<f64>::new();
            extrude_rings_into(
                &outer,
                &holes,
                x[2],
                extrusion_local_transform(&Vector3::new(x[3], x[4], x[5]), x[2]),
                &mut m64,
            )
            .unwrap();
            apply_transform_generic(&mut m64, &placement(x[6], x[7], x[8], x[9]));

            let dx: Vec<Dual<NB>> = x
                .iter()
                .enumerate()
                .map(|(i, v)| Dual::<NB>::variable(*v, i))
                .collect();
            let (douter, dholes) = rings(&dx, with_hole);
            let mut md = RawMesh::<Dual<NB>>::new();
            extrude_rings_into(
                &douter,
                &dholes,
                dx[2],
                extrusion_local_transform(&Vector3::new(dx[3], dx[4], dx[5]), dx[2]),
                &mut md,
            )
            .unwrap();
            apply_transform_generic(
                &mut md,
                &placement(dx[6], dx[7], dx[8], dx[9]),
            );

            assert_eq!(m64.indices, md.indices, "index buffers must match");
            assert_eq!(m64.positions.len(), md.positions.len());
            for (i, (p, q)) in m64.positions.iter().zip(md.positions.iter()).enumerate() {
                assert_eq!(p.x.to_bits(), q.x.value().to_bits(), "vertex {i}.x");
                assert_eq!(p.y.to_bits(), q.y.value().to_bits(), "vertex {i}.y");
                assert_eq!(p.z.to_bits(), q.z.value().to_bits(), "vertex {i}.z");
            }
        }
    }
}

/// The emitted mesh for a holed profile is winding-INCONSISTENT: `create_side_walls`
/// orients every loop's walls outward from that loop's own interior, so a hole's
/// walls face into the solid instead of into the void. The divergence functional of
/// the emitted mesh is therefore `depth * det * (A_outer + A_hole/3)`, not the solid
/// volume `depth * det * (A_outer - A_hole)`. Production compensates downstream
/// (`extrude_profile_watertight` runs `orient_mesh_outward`; the exact CSG kernel
/// re-orients), so this is a property of the raw mesher, not a shipped defect.
/// Pinned here because the B4.4 oracle depends on it.
#[test]
fn b44_holed_extrusion_is_winding_inconsistent() {
    let x = vec![
        4.0, 0.75, 6.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.1, -0.05, 1.0, 0.2,
    ];
    let emitted = forward(&x, true);
    let a_outer = x[0] * x[1];
    let a_hole = 4.0 * x[12] * x[13];
    let solid = x[2] * (a_outer - a_hole);
    let inconsistent = x[2] * (a_outer + a_hole / 3.0);
    assert!(
        (emitted - inconsistent).abs() / inconsistent < 1e-12,
        "emitted {emitted} != winding-inconsistent closed form {inconsistent}"
    );
    assert!(
        (emitted - solid).abs() / solid > 0.1,
        "emitted {emitted} unexpectedly equals the solid volume {solid}"
    );
}

/// Emit a seeded set of parameter points with the instrumented forward value,
/// for the end-to-end cross-check against the real wasm pipeline
/// (`scripts/moonshot/b44-kernel-adjoint/kernel-cross-check.mjs`).
#[test]
fn b44_emit_cross_check_points() {
    let mut rng = Rng::new(20260727);
    let mut rows: Vec<String> = Vec::new();
    for _ in 0..24 {
        let x = sample(&mut rng, false);
        let instrumented = forward(&x, false);
        let production = forward_production(&x, false);
        rows.push(format!(
            r#"{{"x":[{}],"instrumentedVolume":{:.17e},"productionF32Volume":{:.17e}}}"#,
            x.iter()
                .map(|v| format!("{v:.17e}"))
                .collect::<Vec<_>>()
                .join(","),
            instrumented,
            production
        ));
    }
    println!("B44_XCHECK_BEGIN");
    println!("[{}]", rows.join(","));
    println!("B44_XCHECK_END");
}
