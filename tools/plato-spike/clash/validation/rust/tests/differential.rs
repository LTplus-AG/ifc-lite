//! Differential fuzz: adapter (plato-backed) vs hand-written reference,
//! compared bit-exactly (f64::to_bits per component; bool equality).
//!
//! PRNG: mulberry32 ported to u32 wrapping arithmetic, seed 0xC0FFEE, so the
//! case stream is reproducible.
//!
//! 20000 non-NaN cases (random coords in [-100,100] plus degenerate batches:
//! zero-area triangles, identical points, exactly-touching boxes, collinear
//! triangles) MUST have zero mismatches.
//!
//! A SEPARATE NaN batch is reported but not failed: the reference uses
//! f64::max/min (NaN-skipping) where the generated code uses ordered ternaries,
//! a known representational divergence.

use clash_validate_rust::adapter;
use clash_validate_rust::reference::aabb as raabb;
use clash_validate_rust::reference::triangle as rtri;
use clash_validate_rust::reference::vec3 as rvec;

type V3 = [f64; 3];

/// mulberry32, ported from the JS one-liner with u32 wrapping arithmetic.
struct Mulberry32 {
    state: u32,
}

impl Mulberry32 {
    fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    fn next_u32(&mut self) -> u32 {
        self.state = self.state.wrapping_add(0x6D2B_79F5);
        let mut t = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        t ^ (t >> 14)
    }

    /// Uniform in [0, 1), matching `(t >>> 0) / 4294967296`.
    fn next_f64(&mut self) -> f64 {
        self.next_u32() as f64 / 4294967296.0
    }

    /// Uniform in [-100, 100).
    fn coord(&mut self) -> f64 {
        self.next_f64() * 200.0 - 100.0
    }

    fn point(&mut self) -> V3 {
        [self.coord(), self.coord(), self.coord()]
    }
}

/// Non-degenerate box from two random corners (harness-side min/max packing).
fn box_of(p: V3, q: V3) -> (V3, V3) {
    let mut min = [0.0; 3];
    let mut max = [0.0; 3];
    for i in 0..3 {
        if p[i] <= q[i] {
            min[i] = p[i];
            max[i] = q[i];
        } else {
            min[i] = q[i];
            max[i] = p[i];
        }
    }
    (min, max)
}

#[derive(Default)]
struct Counters {
    names: Vec<&'static str>,
    counts: Vec<u64>,
}

impl Counters {
    fn bump(&mut self, name: &'static str) {
        if let Some(i) = self.names.iter().position(|n| *n == name) {
            self.counts[i] += 1;
        } else {
            self.names.push(name);
            self.counts.push(1);
        }
    }

    fn total(&self) -> u64 {
        self.counts.iter().sum()
    }

    fn report(&self, label: &str) -> String {
        if self.names.is_empty() {
            return format!("{label}: 0 mismatches");
        }
        let mut s = format!("{label}: {} mismatches:", self.total());
        for (n, c) in self.names.iter().zip(&self.counts) {
            s.push_str(&format!("\n  {n}: {c}"));
        }
        s
    }
}

fn f64_eq(a: f64, b: f64) -> bool {
    a.to_bits() == b.to_bits()
}

fn v3_eq(a: V3, b: V3) -> bool {
    f64_eq(a[0], b[0]) && f64_eq(a[1], b[1]) && f64_eq(a[2], b[2])
}

fn box_eq(a: &adapter::Aabb, b: &raabb::Aabb) -> bool {
    v3_eq(a.min, b.min) && v3_eq(a.max, b.max)
}

/// Run every function under test on one input set; bump counters on mismatch.
#[allow(clippy::too_many_arguments)]
fn compare_case(
    c: &mut Counters,
    p0: V3,
    p1: V3,
    p2: V3,
    s: f64,
    amin: V3,
    amax: V3,
    bmin: V3,
    bmax: V3,
    t_a: [V3; 3],
    t_b: [V3; 3],
) {
    // vec3 surface
    if !v3_eq(adapter::sub(p0, p1), rvec::sub(p0, p1)) {
        c.bump("vec3::sub");
    }
    if !v3_eq(adapter::add(p0, p1), rvec::add(p0, p1)) {
        c.bump("vec3::add");
    }
    if !v3_eq(adapter::scale(p0, s), rvec::scale(p0, s)) {
        c.bump("vec3::scale");
    }
    if !v3_eq(adapter::cross(p0, p1), rvec::cross(p0, p1)) {
        c.bump("vec3::cross");
    }
    if !f64_eq(adapter::dot(p0, p1), rvec::dot(p0, p1)) {
        c.bump("vec3::dot");
    }
    if !f64_eq(adapter::dist_sq(p0, p1), rvec::dist_sq(p0, p1)) {
        c.bump("vec3::dist_sq");
    }
    if !v3_eq(adapter::mid(p0, p1), rvec::mid(p0, p1)) {
        c.bump("vec3::mid");
    }
    if !v3_eq(adapter::centroid(p0, p1, p2), rvec::centroid(p0, p1, p2)) {
        c.bump("vec3::centroid");
    }

    // aabb surface
    let ra = raabb::Aabb::new(amin, amax);
    let rb = raabb::Aabb::new(bmin, bmax);
    let pa = adapter::Aabb::new(amin, amax);
    let pb = adapter::Aabb::new(bmin, bmax);

    if !box_eq(&pa.inflate(s), &ra.inflate(s)) {
        c.bump("aabb::inflate");
    }
    if !v3_eq(pa.center(), ra.center()) {
        c.bump("aabb::center");
    }
    if pa.intersects(&pb) != ra.intersects(&rb) {
        c.bump("aabb::intersects");
    }
    if !f64_eq(adapter::signed_gap(&pa, &pb), raabb::signed_gap(&ra, &rb)) {
        c.bump("aabb::signed_gap");
    }
    if !box_eq(&adapter::overlap_bounds(&pa, &pb), &raabb::overlap_bounds(&ra, &rb)) {
        c.bump("aabb::overlap_bounds");
    }
    if !box_eq(&adapter::bounds_of_points(p0, p1), &raabb::bounds_of_points(p0, p1)) {
        c.bump("aabb::bounds_of_points");
    }
    if adapter::aabb_contains(&pa, &pb) != raabb::aabb_contains(&ra, &rb) {
        c.bump("aabb::aabb_contains");
    }
    if adapter::aabb_contains(&pb, &pa) != raabb::aabb_contains(&rb, &ra) {
        c.bump("aabb::aabb_contains(rev)");
    }

    // triangle surface
    let p_hit = adapter::tri_tri_intersect(t_a[0], t_a[1], t_a[2], t_b[0], t_b[1], t_b[2]);
    let r_hit = rtri::tri_tri_intersect(t_a[0], t_a[1], t_a[2], t_b[0], t_b[1], t_b[2]);
    if p_hit != r_hit {
        c.bump("triangle::tri_tri_intersect");
    }
}

const CASES: usize = 20_000;
const SEED: u32 = 0x00C0_FFEE;

#[test]
fn differential_fuzz_non_nan() {
    let mut rng = Mulberry32::new(SEED);
    let mut counters = Counters::default();

    for case in 0..CASES {
        let p0 = rng.point();
        let p1 = rng.point();
        let p2 = rng.point();
        let s = rng.coord();

        let (mut amin, amax) = box_of(rng.point(), rng.point());
        let (mut bmin, mut bmax) = box_of(rng.point(), rng.point());

        let mut t_a = [rng.point(), rng.point(), rng.point()];
        let mut t_b = [rng.point(), rng.point(), rng.point()];

        // Deterministic degenerate batches on top of the random stream.
        match case % 10 {
            7 => {
                // Zero-area triangles: duplicated vertex on A, all-identical B.
                t_a[1] = t_a[0];
                t_b = [t_b[0], t_b[0], t_b[0]];
            }
            8 => {
                // Exactly touching boxes: share the x face plane bit-exactly,
                // and share the y extents so the touch is real.
                let w = bmax[0] - bmin[0];
                bmin[0] = amax[0];
                bmax[0] = amax[0] + w.abs();
                bmin[1] = amin[1];
                bmax[1] = amax[1];
                // Identical boxes on z for good measure.
                bmin[2] = amin[2];
                bmax[2] = amax[2];
            }
            9 => {
                // Collinear triangle A (a2 on the a0-a1 line) and coincident
                // point-pair inputs for the vec/box functions.
                let t = 0.37;
                for i in 0..3 {
                    t_a[2][i] = t_a[0][i] + t * (t_a[1][i] - t_a[0][i]);
                }
                (bmin, bmax) = (amin, amax);
                amin = amax; // degenerate zero-volume box
            }
            _ => {}
        }

        compare_case(
            &mut counters,
            p0,
            p1,
            p2,
            s,
            amin,
            amax,
            bmin,
            bmax,
            t_a,
            t_b,
        );
    }

    println!("non-NaN differential ({CASES} cases, seed {SEED:#010x})");
    println!("{}", counters.report("non-NaN"));
    assert_eq!(
        counters.total(),
        0,
        "non-NaN differential mismatches:\n{}",
        counters.report("non-NaN")
    );
}

/// Separate NaN batch: divergences are REPORTED, not failed. Known cause: the
/// reference uses f64::max / f64::min (IEEE maxNum semantics: NaN-skipping)
/// while the generated code lowers Max2/Min2/FoldMin/FoldMax to ordered
/// ternaries, which propagate/select NaN differently.
#[test]
fn differential_fuzz_nan_batch_report_only() {
    const NAN_CASES: usize = 2_000;
    let mut rng = Mulberry32::new(SEED ^ 0xDEAD_BEEF);
    let mut counters = Counters::default();

    for _ in 0..NAN_CASES {
        let mut pts: Vec<f64> = (0..45).map(|_| rng.coord()).collect();
        // Poison 1-4 random slots with NaN.
        let n_poison = 1 + (rng.next_u32() % 4) as usize;
        for _ in 0..n_poison {
            let slot = (rng.next_u32() as usize) % pts.len();
            pts[slot] = f64::NAN;
        }

        let v = |i: usize| -> V3 { [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]] };
        let p0 = v(0);
        let p1 = v(1);
        let p2 = v(2);
        let s = pts[9 * 3];
        // NaN boxes are used raw (no min/max normalisation): NaN handling in
        // the box math itself is exactly what this batch probes.
        let (amin, amax) = (v(3), v(4));
        let (bmin, bmax) = (v(5), v(6));
        let t_a = [v(7), v(8), v(9)];
        let t_b = [v(10), v(11), v(12)];

        compare_case(
            &mut counters,
            p0,
            p1,
            p2,
            s,
            amin,
            amax,
            bmin,
            bmax,
            t_a,
            t_b,
        );
    }

    println!("NaN batch ({NAN_CASES} cases) - REPORT ONLY, not failed");
    println!("{}", counters.report("NaN-batch"));
    // Intentionally no assert: NaN divergences are a known representational
    // difference (f64::max NaN-skip vs ordered ternary), reported above.
}
