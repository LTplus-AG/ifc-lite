// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #2684 — `SNAP_GRID` is denominated in the CALLER's unit, not in metres.
//!
//! These tests do not fix the divergence; they make it VISIBLE and pin the
//! argument for which way it should eventually be fixed. Today the divergence
//! is invisible: nothing fails, nothing warns, and the constant's own doc
//! comment used to claim "metres" — so the only way to discover it was to
//! measure the operands, which is how #2681's watertightness census split went
//! unexplained for a while.
//!
//! WHAT IS ESTABLISHED HERE, by measurement rather than by argument:
//!
//! 1. f32 import noise is physically invariant TO WITHIN A FACTOR OF 2. The same
//!    physical point carries near-enough the same physical ULP whether the file
//!    says metres or millimetres, because f32 is a RELATIVE precision and the
//!    physical coordinate is identical. The residue is binade alignment: 1000 is
//!    not a power of two, so the two coordinates land 2^9 or 2^10 apart in
//!    exponent and the ratio is exactly 2^Δ/1000 ∈ {1.024, 1.953}. Swept over
//!    200k log-uniform magnitudes from 1 cm to 10 km: **1.024x for ~96.5% of
//!    magnitudes, 1.953x for the other ~3.5%** — the worst case landing at
//!    64.77 m, one binade below this file's 66.8 m probe. So "invariant" is the
//!    honest word only with that bound attached, which is why the assertion
//!    below is `< 2.0` and not `≈ 1`.
//!
//! 2. `SNAP_GRID` is NOT physically invariant. It is 15.26 µm in a metre file
//!    and 15.26 nm in a millimetre one — 1000x, decided by authoring convention.
//!
//! 3. Therefore the ratio that actually matters — grid ÷ noise, i.e. "is the
//!    snap coarse enough to absorb the f32 jitter it exists to absorb?" — is
//!    2.0 in a metre file (works as designed) and 0.002 in a millimetre file,
//!    where the grid is ~500x finer than the noise.
//!
//! 4. The snap therefore goes INERT past |c| = 128 CALLER UNITS, where the f32
//!    spacing becomes a multiple of the grid so every f32 is already on it.
//!    Verified by exhaustive f32 sweep, not inferred. That is 12.8 cm in a
//!    millimetre file — i.e. EVERY building coordinate — and 128 m in a metre
//!    one, so even metre files lose the snap far from the origin.
//!
//! THE CONCLUSION THAT FOLLOWS: since the noise being absorbed is physically
//! invariant, the grid absorbing it must be physically invariant too. That
//! argues for a `unit_scale`-relative grid (fixed PHYSICAL size), not the
//! current file-unit-relative one (fixed RELATIVE precision). The ≤2x binade
//! wobble in point 1 does not weaken this: it is a factor of two against a
//! factor of a thousand, and a millimetre file's grid/noise stays below 0.004
//! at every building-scale magnitude either way.
//!
//! HOW THIS FILE GOES STALE, since the tripwires below cannot see every fix.
//! Both of them probe the KERNEL-visible grid, via `subtract` and via the
//! mirrored constant. A fix at the SEAM instead — scaling operands to metres
//! inside `BooleanProcessor` before the kernel, leaving `mesh_to_tris` and
//! `SNAP_GRID` untouched — would fix production while leaving all three tests
//! green and this header quietly wrong. If you fix #2684 that way, update this
//! file by hand; nothing here will tell you to.
//!
//! WHY THAT FIX IS NOT IN THIS FILE: `SNAP_GRID` must stay a POWER OF TWO or the
//! snap `(c/G).round()*G` stops being an exact f64 op and the kernel loses
//! bit-determinism across x86_64/aarch64/wasm. A physically-fixed grid would
//! therefore have to be the power of two NEAREST the target physical size
//! (2^-16 in a metre file, 2^-6 in a millimetre one), and it must be threaded
//! through `ClippingProcessor` (which carries no `unit_scale` today) and the
//! public `subtract`/`union`/`intersection` signatures. It also moves
//! coordinates, so it perturbs both pinned determinism manifests and the
//! watertightness census by construction. That is its own PR with its own
//! corpus evidence — the same reasoning `csg/plane_eps.rs` records for the
//! clipper's epsilon floor, which carries the identical unit question.
//!
//! Run with:
//!   cargo test -p ifc-lite-geometry --test snap_grid_unit_denomination -- --nocapture

use ifc_lite_geometry::kernel::mesh_bridge::subtract;
use ifc_lite_geometry::mesh::Mesh;

/// The kernel's reconciliation grid, mirrored here because it is `pub(crate)`.
/// Guarded against drift by [`snap_grid_constant_has_not_moved`], which DERIVES
/// the real grid from the kernel instead of restating this literal.
const SNAP_GRID: f64 = 1.0 / 65536.0;

/// Push one coordinate through the kernel's own snap and read back where it
/// landed. `mesh_to_tris` is the only public surface that applies `SNAP_GRID`,
/// so this observes the real constant rather than trusting the mirror above.
fn kernel_snap(v: f32) -> f64 {
    let m = Mesh {
        positions: vec![v, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        indices: vec![0, 1, 2],
        ..Default::default()
    };
    let tris = ifc_lite_geometry::kernel::mesh_bridge::mesh_to_tris(&m);
    assert_eq!(tris.len(), 1, "probe triangle was dropped by mesh_to_tris");
    tris[0][0][0]
}

/// The grid the kernel ACTUALLY applies, derived by probing `mesh_to_tris`.
///
/// Returns the coarsest power of two `G` for which `round(v/G)*G` reproduces the
/// kernel's output on every probe. The probes are deliberately off-grid and
/// mutually non-commensurate, so a wrong `G` cannot satisfy all of them.
fn derive_kernel_grid() -> f64 {
    const PROBES: [f32; 6] = [1.0 / 3.0, 0.7071068, 66.8, 3.7500001, 0.1234567, 1234.5678];
    let mut best: Option<f64> = None;
    for k in 0..=30u32 {
        let g = 1.0 / (1u64 << k) as f64;
        if PROBES
            .iter()
            .all(|&v| ((v as f64 / g).round() * g - kernel_snap(v)).abs() < f64::EPSILON * 1024.0)
        {
            // Coarsest match wins: a finer grid also reproduces a coarser one's
            // output only by coincidence, which the probe set rules out.
            if best.is_none() {
                best = Some(g);
            }
        }
    }
    best.expect("no power-of-two grid reproduced the kernel's snap on all probes")
}

/// Metres per file unit, as `extract_length_unit_scale` reports it.
const METRE_FILE: f64 = 1.0;
const MILLIMETRE_FILE: f64 = 0.001;

/// An axis-aligned box as a watertight triangle mesh, built directly in the
/// caller's chosen unit so nothing is rescaled after construction.
fn box_mesh_at(min: [f64; 3], max: [f64; 3]) -> Mesh {
    let c = [
        [min[0], min[1], min[2]],
        [max[0], min[1], min[2]],
        [max[0], max[1], min[2]],
        [min[0], max[1], min[2]],
        [min[0], min[1], max[2]],
        [max[0], min[1], max[2]],
        [max[0], max[1], max[2]],
        [min[0], max[1], max[2]],
    ];
    const F: [[usize; 3]; 12] = [
        [0, 3, 2],
        [0, 2, 1],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [1, 2, 6],
        [1, 6, 5],
        [2, 3, 7],
        [2, 7, 6],
        [3, 0, 4],
        [3, 4, 7],
    ];
    let mut positions = Vec::with_capacity(24);
    for v in &c {
        positions.push(v[0] as f32);
        positions.push(v[1] as f32);
        positions.push(v[2] as f32);
    }
    let mut indices = Vec::with_capacity(36);
    for f in &F {
        indices.push(f[0] as u32);
        indices.push(f[1] as u32);
        indices.push(f[2] as u32);
    }
    Mesh {
        positions,
        indices,
        ..Default::default()
    }
}

/// Signed volume of a closed mesh, in the mesh's own units cubed.
fn volume(m: &Mesh) -> f64 {
    let v = |i: u32| {
        let b = i as usize * 3;
        [
            m.positions[b] as f64,
            m.positions[b + 1] as f64,
            m.positions[b + 2] as f64,
        ]
    };
    let mut acc = 0.0;
    for c in m.indices.chunks_exact(3) {
        let (a, b, d) = (v(c[0]), v(c[1]), v(c[2]));
        acc += a[0] * (b[1] * d[2] - b[2] * d[1]) - a[1] * (b[0] * d[2] - b[2] * d[0])
            + a[2] * (b[0] * d[1] - b[1] * d[0]);
    }
    acc / 6.0
}

/// One physical ULP of `coord`, expressed in METRES.
fn ulp_metres(coord: f32, unit_scale: f64) -> f64 {
    let next = f32::from_bits(coord.to_bits() + 1);
    (next - coord) as f64 * unit_scale
}

/// The panel from #2684's field measurement: 3.75 x 0.09 x 3.25 m, sitting
/// 66/41/16 m from the origin, with a 1.2 x 1.5 m opening cut through it.
///
/// `s` is file units per metre — 1.0 for `.METRE.`, 1000.0 for `.MILLI. .METRE.`
/// — applied to every coordinate exactly as an authoring tool would write it.
fn panel_with_opening(s: f64) -> (Mesh, Mesh) {
    let o = [66.0 * s, 41.0 * s, 16.0 * s];
    let host = box_mesh_at(o, [o[0] + 3.75 * s, o[1] + 0.09 * s, o[2] + 3.25 * s]);
    // Extended past both faces so it cuts clean through the 0.09 m thickness.
    let cutter = box_mesh_at(
        [o[0] + 0.8 * s, o[1] - 0.02 * s, o[2] + 0.9 * s],
        [o[0] + 2.0 * s, o[1] + 0.11 * s, o[2] + 2.4 * s],
    );
    (host, cutter)
}

#[test]
fn snap_grid_constant_has_not_moved() {
    // Guards the guard. Every number in the sibling tests is derived from the
    // mirrored SNAP_GRID above, so if the kernel's real constant moved and the
    // mirror did not, those tests would keep passing while measuring a grid the
    // kernel no longer uses.
    //
    // Asserting `SNAP_GRID == 1.0/65536.0` would be a TAUTOLOGY — both sides are
    // literals in this file, and it cannot fail no matter what the kernel does.
    // (Measured: mutating the kernel's constant to 2^-6 left that form green.)
    // So derive the grid from the kernel's observable behaviour instead.
    let actual = derive_kernel_grid();
    assert_eq!(
        actual, SNAP_GRID,
        "the kernel now snaps to {actual:e} but this file's mirror says {SNAP_GRID:e}. \
         Every threshold in the sibling tests is derived from the mirror, so they \
         are now measuring the wrong grid — update the mirror."
    );
    assert!(
        SNAP_GRID.log2().fract() == 0.0,
        "SNAP_GRID must stay a power of two or the snap stops being an exact \
         f64 op and the kernel loses cross-architecture bit-determinism"
    );
}

#[test]
fn f32_import_noise_is_physically_invariant_but_the_snap_grid_is_not() {
    // The design argument for #2684, reduced to two numbers per unit.
    //
    // HONESTY NOTE: the first two assertions here are closer to executable
    // documentation than to guards. `noise_ratio < 2.0` holds for every
    // representable coordinate (the ratio is exactly 2^Δ/1000 for Δ ∈ {9,10},
    // so 1.024 or 1.953 and nothing else), and `grid_ratio ≈ 1000` cancels
    // SNAP_GRID entirely — it reduces to METRE_FILE/MILLIMETRE_FILE. Neither
    // can realistically fail. They are here to state the premise in a form the
    // compiler checks rather than to catch a regression; the teeth of this file
    // are the third assertion below and the sibling tests, both of which were
    // mutation-verified to bite.
    let noise_m = ulp_metres(66.8, METRE_FILE);
    let noise_mm = ulp_metres(66_800.0, MILLIMETRE_FILE);

    // Same physical point, same physical noise: within a factor of 2 (they
    // differ only by which binade the mantissa lands in).
    let noise_ratio = noise_m.max(noise_mm) / noise_m.min(noise_mm);
    assert!(
        noise_ratio < 2.0,
        "f32 import noise should be physically invariant across authoring units, \
         but metre={noise_m:.4e} m vs millimetre={noise_mm:.4e} m (ratio {noise_ratio:.3}). \
         The recommendation in this file's header rests on this invariance."
    );

    // The grid, by contrast, is NOT invariant — it tracks the authoring unit.
    let grid_m = SNAP_GRID * METRE_FILE;
    let grid_mm = SNAP_GRID * MILLIMETRE_FILE;
    let grid_ratio = grid_m / grid_mm;
    assert!(
        (grid_ratio - 1000.0).abs() < 1.0,
        "expected the grid's physical size to track the authoring unit exactly \
         (1000x between metres and millimetres), got {grid_ratio:.1}x"
    );

    // The consequence: does the snap actually absorb the noise it exists for?
    let absorbs_m = grid_m / noise_m;
    let absorbs_mm = grid_mm / noise_mm;

    println!("--- #2684: is the snap coarse enough to absorb f32 import noise? ---");
    println!("  .METRE. file      : grid {grid_m:.4e} m / noise {noise_m:.4e} m = {absorbs_m:.4}");
    println!("  .MILLI. file      : grid {grid_mm:.4e} m / noise {noise_mm:.4e} m = {absorbs_mm:.4}");

    assert!(
        absorbs_m >= 1.0,
        "in a metre-authored file the snap should be at least as coarse as the \
         f32 noise it absorbs, got {absorbs_m:.4}"
    );

    // THE DEFECT. When #2684 is fixed this assertion FAILS, which is intended:
    // it is the tripwire that tells the fixer this file's header, the constant's
    // doc comment and both determinism manifests now need updating.
    assert!(
        absorbs_mm < 0.01,
        "REGRESSION OR FIX? A millimetre-authored file's snap grid used to be \
         ~500x FINER than the f32 noise it exists to absorb ({absorbs_mm:.4} << 1), \
         making the snap a no-op there. If this now fails because the ratio rose \
         toward 1, #2684 has been FIXED — update this test, the SNAP_GRID doc \
         comment in kernel/mesh_bridge.rs, csg/plane_eps.rs's KNOWN LIMITATION, \
         and regenerate both mesh_determinism manifests."
    );
}

#[test]
fn identical_physical_geometry_cuts_differently_by_authoring_unit() {
    let (host_m, cut_m) = panel_with_opening(1.0);
    let (host_mm, cut_mm) = panel_with_opening(1000.0);

    let out_m = subtract(&host_m, &cut_m);
    let out_mm = subtract(&host_mm, &cut_mm);

    // Both expressed in cubic METRES so they are directly comparable.
    let vol_m = volume(&out_m);
    let vol_mm = volume(&out_mm) / 1.0e9;
    let exact = 3.75 * 0.09 * 3.25 - 1.2 * 0.09 * 1.5;

    println!("--- #2684: same physical panel, two authoring units ---");
    println!("  exact analytic volume : {exact:.9} m^3");
    println!("  .METRE. authored      : {vol_m:.9} m^3  ({} tris)", out_m.indices.len() / 3);
    println!("  .MILLI. authored      : {vol_mm:.9} m^3  ({} tris)", out_mm.indices.len() / 3);
    println!("  divergence            : {:.12} m^3", (vol_m - vol_mm).abs());

    // Both must still be a correct cut to within the snap's own physical size —
    // this is a tolerance question, not a correctness one, and neither result is
    // "broken". What is wrong is that they DIFFER at all.
    for (label, v) in [("metre", vol_m), ("millimetre", vol_mm)] {
        assert!(
            (v - exact).abs() < 1.0e-3,
            "{label}-authored cut lost more than a litre of volume: {v:.9} vs exact {exact:.9}"
        );
    }

    // THE DEFECT, again as a tripwire: identical physical geometry produces
    // different volumes purely because of how the file was authored. The metre
    // file snaps onto a 15 µm grid and moves; the millimetre file's grid is
    // finer than f32 can express at that magnitude, so it does not.
    let divergence = (vol_m - vol_mm).abs();
    assert!(
        divergence > 1.0e-6,
        "REGRESSION OR FIX? Identical physical geometry used to cut to DIFFERENT \
         volumes depending on authoring unit (divergence was ~3.8e-5 m^3, now \
         {divergence:.3e}). If this now fails because the two agree, #2684 has \
         been FIXED — see the note in the sibling test."
    );
}
