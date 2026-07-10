//! Perf harness: adapter (plato-backed) vs hand-written reference for the three
//! hot clash primitives — `signed_gap`, `intersects`, `tri_tri_intersect`.
//!
//! Each op runs 2_000_000 iterations over a fixed pool of pseudo-random cases
//! (mulberry32, seed 0xC0FFEE) and the wall time is reported as adapter/reference
//! ratio. Checksums are printed so a perf run also confirms the two paths return
//! identical values across all 2M evaluations.
//!
//! Run: `cargo run --release --bin bench`

use std::hint::black_box;
use std::time::Instant;

use clash_validate_rust::adapter;
use clash_validate_rust::reference::aabb as raabb;
use clash_validate_rust::reference::triangle as rtri;

type V3 = [f64; 3];

/// mulberry32, u32-wrapping port (same as the differential fuzz).
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
    fn next_f64(&mut self) -> f64 {
        self.next_u32() as f64 / 4294967296.0
    }
    fn coord(&mut self) -> f64 {
        self.next_f64() * 200.0 - 100.0
    }
    fn point(&mut self) -> V3 {
        [self.coord(), self.coord(), self.coord()]
    }
    /// Small jitter in [-2, 2) — keeps triangle B near triangle A so the SAT
    /// axis loop is actually exercised (not short-circuited on axis 0).
    fn jitter(&mut self) -> f64 {
        self.next_f64() * 4.0 - 2.0
    }
}

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

struct Case {
    a_ref: raabb::Aabb,
    b_ref: raabb::Aabb,
    a_ad: adapter::Aabb,
    b_ad: adapter::Aabb,
    ta: [V3; 3],
    tb: [V3; 3],
}

fn timed<F: FnMut(usize) -> u64>(iters: usize, pool: usize, mut f: F) -> (f64, u64) {
    let start = Instant::now();
    let mut acc = 0u64;
    for i in 0..iters {
        acc = acc.wrapping_add(f(i % pool));
    }
    black_box(acc);
    (start.elapsed().as_secs_f64(), acc)
}

fn main() {
    const ITERS: usize = 2_000_000;
    const POOL: usize = 4096;
    let mut rng = Mulberry32::new(0x00C0_FFEE);

    let mut cases: Vec<Case> = Vec::with_capacity(POOL);
    for _ in 0..POOL {
        let (amin, amax) = box_of(rng.point(), rng.point());
        let (bmin, bmax) = box_of(rng.point(), rng.point());
        let ta = [rng.point(), rng.point(), rng.point()];
        // Triangle B sits near A so the tri-tri SAT loop does representative work.
        let tb = [
            [ta[0][0] + rng.jitter(), ta[0][1] + rng.jitter(), ta[0][2] + rng.jitter()],
            [ta[1][0] + rng.jitter(), ta[1][1] + rng.jitter(), ta[1][2] + rng.jitter()],
            [ta[2][0] + rng.jitter(), ta[2][1] + rng.jitter(), ta[2][2] + rng.jitter()],
        ];
        cases.push(Case {
            a_ref: raabb::Aabb::new(amin, amax),
            b_ref: raabb::Aabb::new(bmin, bmax),
            a_ad: adapter::Aabb::new(amin, amax),
            b_ad: adapter::Aabb::new(bmin, bmax),
            ta,
            tb,
        });
    }
    let cases = cases; // freeze

    // Warm-up (touch every case once through both paths, discard timing).
    {
        let mut w = 0u64;
        for c in &cases {
            w ^= raabb::signed_gap(&c.a_ref, &c.b_ref).to_bits();
            w ^= adapter::signed_gap(&c.a_ad, &c.b_ad).to_bits();
            w ^= c.a_ref.intersects(&c.b_ref) as u64;
            w ^= c.a_ad.intersects(&c.b_ad) as u64;
            w ^= rtri::tri_tri_intersect(c.ta[0], c.ta[1], c.ta[2], c.tb[0], c.tb[1], c.tb[2]) as u64;
            w ^= adapter::tri_tri_intersect(c.ta[0], c.ta[1], c.ta[2], c.tb[0], c.tb[1], c.tb[2]) as u64;
        }
        black_box(w);
    }

    println!("clash perf: adapter (plato) vs reference, {ITERS} iters/op, pool {POOL}");
    println!("{:<22} {:>12} {:>12} {:>10}", "op", "ref (s)", "adapter (s)", "ratio");

    let mut overall_ref = 0.0f64;
    let mut overall_ad = 0.0f64;

    // ---- signed_gap ----
    let (ref_t, ref_c) = timed(ITERS, POOL, |i| {
        let c = &cases[i];
        black_box(raabb::signed_gap(&c.a_ref, &c.b_ref)).to_bits()
    });
    let (ad_t, ad_c) = timed(ITERS, POOL, |i| {
        let c = &cases[i];
        black_box(adapter::signed_gap(&c.a_ad, &c.b_ad)).to_bits()
    });
    overall_ref += ref_t;
    overall_ad += ad_t;
    println!(
        "{:<22} {:>12.4} {:>12.4} {:>9.3}x   checksum {}",
        "signed_gap",
        ref_t,
        ad_t,
        ad_t / ref_t,
        if ref_c == ad_c { "MATCH" } else { "MISMATCH" }
    );

    // ---- intersects ----
    let (ref_t, ref_c) = timed(ITERS, POOL, |i| {
        let c = &cases[i];
        black_box(c.a_ref.intersects(&c.b_ref)) as u64
    });
    let (ad_t, ad_c) = timed(ITERS, POOL, |i| {
        let c = &cases[i];
        black_box(c.a_ad.intersects(&c.b_ad)) as u64
    });
    overall_ref += ref_t;
    overall_ad += ad_t;
    println!(
        "{:<22} {:>12.4} {:>12.4} {:>9.3}x   true-count {}",
        "intersects",
        ref_t,
        ad_t,
        ad_t / ref_t,
        if ref_c == ad_c { format!("MATCH ({ref_c})") } else { format!("MISMATCH {ref_c} vs {ad_c}") }
    );

    // ---- tri_tri_intersect ----
    let (ref_t, ref_c) = timed(ITERS, POOL, |i| {
        let c = &cases[i];
        black_box(rtri::tri_tri_intersect(
            c.ta[0], c.ta[1], c.ta[2], c.tb[0], c.tb[1], c.tb[2],
        )) as u64
    });
    let (ad_t, ad_c) = timed(ITERS, POOL, |i| {
        let c = &cases[i];
        black_box(adapter::tri_tri_intersect(
            c.ta[0], c.ta[1], c.ta[2], c.tb[0], c.tb[1], c.tb[2],
        )) as u64
    });
    overall_ref += ref_t;
    overall_ad += ad_t;
    println!(
        "{:<22} {:>12.4} {:>12.4} {:>9.3}x   true-count {}",
        "tri_tri_intersect",
        ref_t,
        ad_t,
        ad_t / ref_t,
        if ref_c == ad_c { format!("MATCH ({ref_c})") } else { format!("MISMATCH {ref_c} vs {ad_c}") }
    );

    println!(
        "{:<22} {:>12.4} {:>12.4} {:>9.3}x",
        "TOTAL", overall_ref, overall_ad, overall_ad / overall_ref
    );
}
