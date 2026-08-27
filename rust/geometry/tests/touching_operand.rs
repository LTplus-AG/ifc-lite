// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #3341: a cutter that only TOUCHES the host must not tear it open.
//!
//! Two boxes that share a face have zero-volume intersection, so `A - B` is
//! exactly `A`. The exact arrangement kernel instead drops a whole face of `A`
//! on some of these configurations, leaving a non-watertight shell. Because the
//! shell is open, its signed volume is meaningless — the first case below reads
//! as "1.0 m3 removed" when in truth one 1.28 m2 face went missing.
//!
//! The nine pinned cases are real failures: the first is what the CSG property
//! test shrank to on main, the rest come from a seeded sweep of 40000 random
//! face-touching pairs (9 of which tore, a rate of about 0.02%). They are
//! pinned explicitly because the sweep's rate is far too low for a bounded
//! random run to be a reliable gate on its own.

use ifc_lite_geometry::kernel::mesh_volume::mesh_volume;
use nalgebra::{Point3, Vector3};
use ifc_lite_geometry::{ClippingProcessor, Mesh};
use std::collections::HashMap;

/// Outward-wound axis-aligned box, built HERE rather than reusing
/// `arrangement::box_mesh`. The tessellation is load-bearing: the nine cases
/// below were found against this diagonal split, and swapping in the kernel's
/// (which splits two quads the other way) moves every face centroid, so the
/// pinned cases stop triggering and the whole file passes on unfixed code.
/// Verified by trying it: with `box_mesh` the suite went green against pristine
/// main. Do not "simplify" this away.
fn boxed(min: [f64; 3], size: [f64; 3]) -> Mesh {
    let mx = [min[0] + size[0], min[1] + size[1], min[2] + size[2]];
    let c = |i: usize| -> [f64; 2] { [min[i], mx[i]] };
    let corners: Vec<Point3<f64>> = [
        (0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0),
        (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1),
    ]
    .iter()
    .map(|&(i, j, k)| Point3::new(c(0)[i], c(1)[j], c(2)[k]))
    .collect();
    let faces: [[usize; 4]; 6] = [
        [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
        [2, 3, 7, 6], [0, 4, 7, 3], [1, 2, 6, 5],
    ];
    let mut m = Mesh::with_capacity(24, 36);
    for f in &faces {
        let e1 = corners[f[1]] - corners[f[0]];
        let e2 = corners[f[2]] - corners[f[0]];
        let n = e1.cross(&e2).try_normalize(1e-12).unwrap_or(Vector3::z());
        let b = m.vertex_count() as u32;
        for &i in f {
            m.add_vertex(corners[i], n);
        }
        m.add_triangle(b, b + 1, b + 2);
        m.add_triangle(b, b + 2, b + 3);
    }
    m
}

/// Watertightness, counting the two directions SEPARATELY after welding by
/// position. A net-signed tally is not enough: an edge used twice forward and
/// twice reverse cancels to zero, so a non-manifold seam would be certified
/// closed. This repo already has that finding written down, with a bowtie
/// fixture, in `processors/boolean/chain_cycle_tests.rs`.
fn open_edges(m: &Mesh) -> Result<usize, String> {
    if m.is_empty() {
        // A deleted host is not a closed one. Saying "0 open edges" here would
        // let the topology test wave through the worst possible regression.
        return Err("host was deleted entirely".to_string());
    }
    let welded = m.welded_by_position(1e-6);
    let mut edges: HashMap<(u32, u32), (u32, u32)> = HashMap::new();
    for tri in welded.indices.chunks_exact(3) {
        for k in 0..3 {
            let (a, b) = (tri[k], tri[(k + 1) % 3]);
            if a == b {
                return Err(format!("degenerate edge: triangle repeats welded vertex {a}"));
            }
            let e = edges.entry((a.min(b), a.max(b))).or_insert((0, 0));
            if a < b {
                e.0 += 1;
            } else {
                e.1 += 1;
            }
        }
    }
    Ok(edges.values().filter(|&&(f, r)| f != 1 || r != 1).count())
}

struct Case {
    name: &'static str,
    a_min: [f64; 3],
    a_size: [f64; 3],
    b_min: [f64; 3],
    b_size: [f64; 3],
}

const CASES: &[Case] = &[
    Case {
        name: "proptest_shrunk",
        a_min: [-2.3397775407181403, -2.080822215875493, -6.453953867772596],
        a_size: [2.0898582766763107, 0.31340997700849643, 4.09485121574599],
        b_min: [-2.3397775407181403, -2.080822215875493, -2.359102652026606],
        b_size: [1.7383850838313901, 4.040893317475825, 3.241876485757496],
    },
    Case {
        name: "sweep_a",
        a_min: [-1.1528565257675085, -2.425987347566422, -3.21068053137042],
        a_size: [2.4542726789665847, 1.7477755681211595, 1.0584941386485873],
        b_min: [-1.1528565257675085, -2.425987347566422, -2.1521863927218328],
        b_size: [2.704319117571696, 4.772339029260933, 3.601410819414733],
    },
    Case {
        name: "sweep_b",
        a_min: [-1.0114563086656303, -2.6981824927947695, -4.358805542220266],
        a_size: [1.2388014221996586, 0.15569787327410728, 3.022282079558228],
        b_min: [-1.0114563086656303, -2.6981824927947695, -1.3365234626620381],
        b_size: [3.653690200031092, 4.865367477740311, 4.172346358316836],
    },
    Case {
        name: "sweep_c",
        a_min: [-1.816449578799666, -3.0811432853213727, -3.773561312639152],
        a_size: [1.9959174958012336, 2.780019243685017, 2.6128316415152866],
        b_min: [-1.7618254890411282, -2.753174491483415, -1.1607296711238653],
        b_size: [4.4969951216743915, 3.8060607920172633, 4.217959250358222],
    },
    Case {
        name: "sweep_d",
        a_min: [-2.89393379549424, -3.026035873405599, -4.908516315662164],
        a_size: [3.3797100391928057, 1.7919612402731941, 4.760925957103353],
        b_min: [-2.89393379549424, -2.749202369161343, -0.1475903585588103],
        b_size: [4.923952545841213, 4.474867092187776, 3.3949224826769844],
    },
    Case {
        name: "sweep_e",
        a_min: [-1.3405762035263367, -3.3506246642601614, -2.4973780002989896],
        a_size: [1.6370775504215107, 3.110570290092493, 1.3064372037721639],
        b_min: [-1.3405762035263367, -0.24005437416766817, -2.0411000532554042],
        b_size: [3.988444765217193, 3.14941980148606, 4.951465736946503],
    },
    Case {
        name: "sweep_f",
        a_min: [-3.157379407153398, -2.1583789630047114, -3.214362737944476],
        a_size: [3.690783688936461, 2.353865539174382, 4.166907502117657],
        b_min: [0.5334042817830631, -2.381536456594136, -2.7452654410577826],
        b_size: [1.4652871857705994, 4.354155692260597, 4.803767201908592],
    },
    Case {
        name: "sweep_g",
        a_min: [-3.244446874816096, -2.4608710746890017, -3.169680424610901],
        a_size: [2.0960735483287523, 0.6059972963000422, 1.730809519754173],
        b_min: [-2.8793683763319784, -2.681896691183977, -1.438870904856728],
        b_size: [3.311440646667884, 4.838559885902333, 4.5676717665192585],
    },
    Case {
        name: "sweep_h",
        a_min: [-2.944337068165037, -3.2660796744149434, -4.90945333692286],
        a_size: [3.393189822529806, 1.2896867157736276, 1.6342417261377087],
        b_min: [-2.944337068165037, -3.2660796744149434, -3.275211610785152],
        b_size: [4.9683459064432185, 4.808369852325381, 4.218708464152033],
    },
];

/// The property, asserted on TOPOLOGY rather than volume: a touching cutter
/// leaves the host closed. Volume is deliberately not the primary assertion
/// here — an open shell's signed volume is not a volume at all.
#[test]
fn a_touching_cutter_never_tears_the_host_open() {
    let clipper = ClippingProcessor::new();
    let mut failures = Vec::new();
    for case in CASES {
        let a = boxed(case.a_min, case.a_size);
        let b = boxed(case.b_min, case.b_size);
        let out = clipper.subtract_mesh(&a, &b).expect("subtract must not error");
        match open_edges(&out) {
            Err(why) => failures.push(format!("{}: {why}", case.name)),
            Ok(0) => {}
            Ok(bad) => failures.push(format!(
                "{}: {bad} unmatched edges (host was closed; vol {:.4} -> {:.4})",
                case.name,
                mesh_volume(&a),
                mesh_volume(&out)
            )),
        }
    }
    assert!(
        failures.is_empty(),
        "a face-touching cutter has zero-volume overlap, so the host must come \
         back closed and unchanged:\n  {}",
        failures.join("\n  ")
    );
}

/// The same property on volume, for the cases where the shell does stay closed.
/// Kept separate so a tear is never reported as a volume error.
#[test]
fn a_touching_cutter_removes_no_volume() {
    let clipper = ClippingProcessor::new();
    let mut failures = Vec::new();
    let mut checked = 0usize;
    for case in CASES {
        let a = boxed(case.a_min, case.a_size);
        let b = boxed(case.b_min, case.b_size);
        let out = clipper.subtract_mesh(&a, &b).expect("subtract must not error");
        if !matches!(open_edges(&out), Ok(0)) {
            continue; // torn: reported by the topology test above, not here
        }
        checked += 1;
        // `Mesh` stores f32 positions, so even a subtract that removes nothing
        // round-trips every coordinate through f32 and cannot return the volume
        // bit-exactly. The error scales as f32 epsilon x surface area x extent;
        // across these nine it peaks at 1.9e-5 relative. 1e-4 leaves ~5x margin
        // on the worst observed and is still 10x tighter than the bound
        // `csg_property_test` uses for the same operands.
        let (va, vo) = (mesh_volume(&a), mesh_volume(&out));
        if (vo - va).abs() > 1e-4 * (1.0 + va) {
            failures.push(format!("{}: vol {va:.6} -> {vo:.6}", case.name));
        }
    }
    // Without this floor the test passes having checked NOTHING whenever the
    // sibling topology test is already failing, which is exactly when a silent
    // pass is most misleading.
    assert!(
        checked > 0,
        "every case was skipped as torn, so this test asserted nothing; \
         fix the topology failure first"
    );
    assert!(
        failures.is_empty(),
        "a face-touching cutter must remove nothing ({checked} cases checked):\n  {}",
        failures.join("\n  ")
    );
}
