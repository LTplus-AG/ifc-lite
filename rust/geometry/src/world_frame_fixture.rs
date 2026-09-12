// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! World-frame test fixture corpus (Rust half).
//!
//! One defect class, four defects in a day, all invisible to green CI: code
//! that sizes a plane/normal tolerance from the max |coordinate| over ALL
//! THREE axes and then compares it against a distance along ONE axis. A
//! model 10 km out in X hands a Z-normal test a ~2.4 mm epsilon derived
//! entirely from the irrelevant X magnitude (#2598 caught pre-merge; #2600
//! and #2529 merged live; `near_band_from_extent` callers carry the milder
//! shared form). No test fed those paths large world coordinates whose
//! offset axis DIFFERS from the axis under test — an offset on the tested
//! axis coincidentally agrees with the correct projection and proves
//! nothing.
//!
//! This corpus places THE SAME operands near the origin and far out on an
//! orthogonal axis (offset baked through f32, as ingestion really is); a
//! frame-correct tolerance answers identically across the two placements.
//! The TS half (`packages/world-frame-fixtures`) additionally covers the
//! per-element RTC `MeshData.origin` cases — that concept exists only on the
//! TS `MeshData` surface; the Rust kernel API ingests baked world
//! coordinates, so the Rust corpus is `{AtOrigin, FarBaked}`.
//!
//! The expected tolerance shape is the section-cutter formulation (PR
//! #2622): f32 noise in a distance along plane normal `n` is bounded by the
//! NORMAL-PROJECTED ULP sum `sum_i |n_i| * ulp32(extent_i)` over per-axis
//! extents — see [`normal_projected_noise_bound`].

use crate::mesh::Mesh;

/// Far-from-origin offset magnitude (metres). 10 km: the f32 ULP there is
/// ~0.98 mm and `extent * 2^-22` reads ~2.4 mm — the regime of every
/// reproduced defect in the class.
pub(crate) const WORLD_FRAME_OFFSET_M: f64 = 10_000.0;

/// Corpus placement. The far case offsets along X ONLY, so tests of
/// Z-behaviour (a Z plane normal, a Z clearance) catch max-over-axes
/// tolerance overreach instead of coincidentally agreeing with it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorldFrameCase {
    /// Counter-case: near the origin. A "fix" that simply widens or
    /// tightens every tolerance fails here.
    AtOrigin,
    /// `WORLD_FRAME_OFFSET_M` out along X, baked through f32.
    FarBaked,
}

pub(crate) const WORLD_FRAME_CASES: [WorldFrameCase; 2] =
    [WorldFrameCase::AtOrigin, WorldFrameCase::FarBaked];

impl WorldFrameCase {
    pub(crate) fn offset(self) -> [f64; 3] {
        match self {
            WorldFrameCase::AtOrigin => [0.0, 0.0, 0.0],
            WorldFrameCase::FarBaked => [WORLD_FRAME_OFFSET_M, 0.0, 0.0],
        }
    }
}

/// Closed axis-aligned box mesh spanning `[min, max]`, placed per the corpus
/// case with the offset BAKED THROUGH f32 (per-face vertices, outward
/// normals) — exactly the quantization a georeferenced model's world
/// coordinates carry on ingestion.
pub(crate) fn placed_box_mesh(case: WorldFrameCase, min: [f64; 3], max: [f64; 3]) -> Mesh {
    let off = case.offset();
    let c = |sx: usize, sy: usize, sz: usize| {
        [
            (if sx == 0 { min[0] } else { max[0] }) + off[0],
            (if sy == 0 { min[1] } else { max[1] }) + off[1],
            (if sz == 0 { min[2] } else { max[2] }) + off[2],
        ]
    };
    let corners = [
        c(0, 0, 0),
        c(1, 0, 0),
        c(1, 1, 0),
        c(0, 1, 0),
        c(0, 0, 1),
        c(1, 0, 1),
        c(1, 1, 1),
        c(0, 1, 1),
    ];
    let faces: [[usize; 4]; 6] = [
        [0, 3, 2, 1],
        [4, 5, 6, 7],
        [0, 1, 5, 4],
        [2, 3, 7, 6],
        [0, 4, 7, 3],
        [1, 2, 6, 5],
    ];
    let mut m = Mesh::new();
    for f in &faces {
        let a = corners[f[0]];
        let b = corners[f[1]];
        let d = corners[f[2]];
        let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
        let n = [
            e1[1] * e2[2] - e1[2] * e2[1],
            e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0],
        ];
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt().max(1e-30);
        let nn = [(n[0] / len) as f32, (n[1] / len) as f32, (n[2] / len) as f32];
        let base = (m.positions.len() / 3) as u32;
        for &i in f {
            m.positions.extend_from_slice(&[
                corners[i][0] as f32,
                corners[i][1] as f32,
                corners[i][2] as f32,
            ]);
            m.normals.extend_from_slice(&nn);
        }
        m.indices
            .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
    m
}

/// Unit of least precision of an f32 at the given magnitude (exact, via the
/// bit pattern).
pub(crate) fn ulp32(magnitude: f64) -> f64 {
    let f = (magnitude.abs()) as f32;
    if f == 0.0 {
        return f64::from(f32::from_bits(1));
    }
    f64::from(f32::from_bits(f.to_bits() + 1)) - f64::from(f)
}

/// The CORRECT f32 noise bound for a signed distance along plane normal `n`:
/// `sum_i |n_i| * ulp32(extent_i)` with per-axis extents from the meshes'
/// world coordinates. An axis orthogonal to `n` contributes nothing however
/// far it puts the model from the origin — exactly what a max-over-axes
/// extent gets wrong. Tests use it to pick clearances that are provably
/// above any legitimate tolerance in every corpus case.
pub(crate) fn normal_projected_noise_bound(normal: [f64; 3], meshes: &[&Mesh]) -> f64 {
    let mut extent = [0.0f64; 3];
    for mesh in meshes {
        for (i, &p) in mesh.positions.iter().enumerate() {
            let a = i % 3;
            let c = f64::from(p).abs();
            if c > extent[a] {
                extent[a] = c;
            }
        }
    }
    normal[0].abs() * ulp32(extent[0])
        + normal[1].abs() * ulp32(extent[1])
        + normal[2].abs() * ulp32(extent[2])
}

/// Enclosed volume of a closed f32 mesh (divergence theorem, f64 sums) —
/// the corpus's placement-invariant observable.
pub(crate) fn mesh_volume(mesh: &Mesh) -> f64 {
    let p = |i: u32| {
        let k = i as usize * 3;
        [
            f64::from(mesh.positions[k]),
            f64::from(mesh.positions[k + 1]),
            f64::from(mesh.positions[k + 2]),
        ]
    };
    let mut v = 0.0;
    for t in mesh.indices.chunks_exact(3) {
        let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
        v += (a[0] * (b[1] * c[2] - b[2] * c[1])
            - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0]))
            / 6.0;
    }
    v.abs()
}

/// A site 5-10 km out on every axis, under `LARGE_COORD_THRESHOLD_METERS`
/// per axis so nothing upstream recentres it, and a multiple of `2^-3` so a
/// mesh baked through f32 here can be translated back to the origin without
/// changing a single bit of its relative geometry (see
/// [`translated_exactly`]).
pub(crate) const FAR_SITE_M: [f64; 3] = [9000.375, 5000.25, 300.125];

/// A UV sphere of radius `r` (`stacks` rings, `slices` segments,
/// `2·slices·(stacks−1)` outward triangles) under a fixed non-axis-aligned
/// rotation, centred at `centre`, baked through f32 as ingestion does.
///
/// Nothing about it is integer or axis-aligned. That is the point: the
/// all-integer axis-aligned boxes above keep every product in a divergence
/// sum exact in f64 whatever the offset, so they cannot see a world-origin
/// reference point at all. A rotated sphere's `a·(b×c)` terms round at
/// `|v|³·ε ≈ 1e-4` each at this site, and a thousand of them add up to a
/// per-mille error on a 0.1 m³ solid.
pub(crate) fn placed_sphere_mesh(centre: [f64; 3], r: f64, stacks: usize, slices: usize) -> Mesh {
    let point = |i: usize, j: usize| -> [f64; 3] {
        let phi = std::f64::consts::PI * i as f64 / stacks as f64;
        let theta = 2.0 * std::f64::consts::PI * j as f64 / slices as f64;
        let p = [r * phi.sin() * theta.cos(), r * phi.sin() * theta.sin(), r * phi.cos()];
        rotate_and_place(p, centre)
    };
    let mut m = Mesh::new();
    let mut push = |a: [f64; 3], b: [f64; 3], d: [f64; 3]| {
        let base = (m.positions.len() / 3) as u32;
        for p in [a, b, d] {
            m.positions.extend_from_slice(&[p[0] as f32, p[1] as f32, p[2] as f32]);
            let n: [f64; 3] = std::array::from_fn(|k| (p[k] - centre[k]) / r);
            m.normals.extend_from_slice(&[n[0] as f32, n[1] as f32, n[2] as f32]);
        }
        m.indices.extend_from_slice(&[base, base + 1, base + 2]);
    };
    for i in 0..stacks {
        for j in 0..slices {
            let (p00, p01) = (point(i, j), point(i, j + 1));
            let (p10, p11) = (point(i + 1, j), point(i + 1, j + 1));
            // The quad's two triangles; the one that degenerates at a pole
            // (two of its corners ARE the pole) is skipped there.
            if i + 1 < stacks {
                push(p00, p10, p11);
            }
            if i > 0 {
                push(p00, p11, p01);
            }
        }
    }
    m
}

/// `centre + R·p` for the corpus's fixed non-axis-aligned rotation `R`
/// (0.7 rad about the (1, 2, 3) axis, Rodrigues). A proper rotation, so
/// winding is preserved.
pub(crate) fn rotate_and_place(p: [f64; 3], centre: [f64; 3]) -> [f64; 3] {
    let (ax, ay, az) = (1.0 / 14f64.sqrt(), 2.0 / 14f64.sqrt(), 3.0 / 14f64.sqrt());
    let (s, c) = 0.7f64.sin_cos();
    let t = 1.0 - c;
    let rot = [
        [t * ax * ax + c, t * ax * ay - s * az, t * ax * az + s * ay],
        [t * ax * ay + s * az, t * ay * ay + c, t * ay * az - s * ax],
        [t * ax * az - s * ay, t * ay * az + s * ax, t * az * az + c],
    ];
    std::array::from_fn(|k| rot[k][0] * p[0] + rot[k][1] * p[1] + rot[k][2] * p[2] + centre[k])
}

/// The same mesh moved by `-offset`, bit-exact: every f32 coordinate becomes
/// `(f64::from(x) - offset)`, which is exact when `offset` is a multiple of
/// the f32 ulp at the far magnitude ([`FAR_SITE_M`] is), and the result is
/// below 1 in magnitude so it re-enters f32 unchanged. Two meshes related by
/// this are the SAME geometry; any observable that differs between them is
/// reading the reference frame, not the mesh.
pub(crate) fn translated_exactly(mesh: &Mesh, offset: [f64; 3]) -> Mesh {
    let mut out = mesh.clone();
    for chunk in out.positions.chunks_exact_mut(3) {
        for k in 0..3 {
            chunk[k] = (f64::from(chunk[k]) - offset[k]) as f32;
        }
    }
    out
}

/// Open `mesh` by ONE f32 ulp: the x of the first corner of triangle 7 moves
/// to the next representable value, so that corner no longer matches the
/// copies of the same vertex on the neighbouring triangles. This is the crack
/// ingestion really produces: two triangles' shared vertex arriving through
/// two placement transforms and rounding to adjacent f32 values. At
/// [`FAR_SITE_M`] the ulp is ~1 mm, so the sliver is 1 mm by an edge length,
/// and a divergence sum about the WORLD origin picks up that sliver's
/// boundary flux, up to `|v| × area / 3`: measured 2 % of a 0.11 m³ sphere
/// and 5 % of a 0.085 m³ prism out of a single 1 mm crack, growing linearly
/// with the distance to the reference point. Call before
/// [`translated_exactly`] so both twins carry the same crack.
pub(crate) fn crack_one_vertex(mesh: &mut Mesh) {
    let i = mesh.indices[7 * 3] as usize * 3;
    mesh.positions[i] = f32::from_bits(mesh.positions[i].to_bits() + 1);
}
