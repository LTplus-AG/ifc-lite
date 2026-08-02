// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Pins the figure-8 pinch capability of [`super::retriangulate_recover`]
//! (#1660, ISSUE_098 dense faceted-BREP reveal walls).
//!
//! When a constraint segment's crossed-triangle channel transits the same
//! vertex's star twice (a "W"-shaped link with a kept island between the
//! lobes), `recover_via_traversal` pushes that vertex into a boundary chain
//! TWICE. That duplicate push is load-bearing, not a bug: the chain is an
//! edge-path that self-touches (never self-crosses), the sub-loop between the
//! twin pushes encodes the kept island as a hole, and earcut's Vid-identity
//! ear test tiles pocket-minus-island exactly. A well-meaning "bail when the
//! apex is already in the chain" hardening would fail exactly the dense
//! reveal-wall family the traversal was added for — this test fails under
//! that change (`edge_exists` assert), under any fallback that emits
//! Vid-degenerate triangles, and under any overlap/hole in the rebuilt cover
//! (exact BigRational area + directed-edge uniqueness, no tolerances).

use super::interner::{Interner, Vid};
use super::rational::{point_of, tri_area2};
use super::retriangulate::{edge_exists, orient2d_v, tri_edges, Mesh2d, SubTri};
use super::retriangulate_recover::{recover_subsegment, recover_via_traversal};
use super::{DropAxis, ImplicitPoint, Sign};
use num_rational::BigRational;
use num_traits::Zero;
use std::collections::BTreeMap;

fn e2(x: f64, y: f64) -> ImplicitPoint {
    ImplicitPoint::Explicit([x, y, 0.0])
}

/// Segment a=(0,0)->b=(10,0). Vertex p=(5,2) sits above the line with a
/// "W"-shaped star: two lobes of its fan dip below y=0 (via link verts
/// L2=(2.5,-1) and L4=(7.5,-1)) with a kept island triangle (p,y1,y2)
/// (y1=(4,.5), y2=(6,.5), all three above the line) between them. The
/// ordered Sloan walk transits p's star TWICE, so apex `p` is pushed into
/// `upper` twice — the figure-8 pinch configuration.
fn pinch_mesh(it: &mut Interner) -> (Mesh2d, Vid, Vid) {
    let a = it.intern(e2(0.0, 0.0));
    let b = it.intern(e2(10.0, 0.0));
    let p = it.intern(e2(5.0, 2.0));
    let l1 = it.intern(e2(2.0, 1.0));
    let l2 = it.intern(e2(2.5, -1.0));
    let y1 = it.intern(e2(4.0, 0.5));
    let y2 = it.intern(e2(6.0, 0.5));
    let l4 = it.intern(e2(7.5, -1.0));
    let l5 = it.intern(e2(8.0, 1.0));
    let l6 = it.intern(e2(5.0, 4.0));
    let b1 = it.intern(e2(3.0, -3.0));
    let b2 = it.intern(e2(7.0, -3.0));
    let tris: Vec<SubTri> = vec![
        // star of p (link L6,L1,L2,y1,y2,L4,L5 — CCW around p)
        [p, l6, l1],
        [p, l1, l2],
        [p, l2, y1],
        [p, y1, y2], // the island: all verts above y=0 => NOT crossed => kept
        [p, y2, l4],
        [p, l4, l5],
        [p, l5, l6],
        // region between the star and the outer boundary
        [a, l2, l1],
        [a, b1, l2],
        [b1, y1, l2],
        [b1, y2, y1],
        [b1, b2, y2],
        [b2, l4, y2],
        [b2, b, l4],
        [b, l5, l4],
    ];
    let mesh = Mesh2d {
        tris,
        axis: DropAxis::Z,
        w0: Sign::Positive,
        unrecovered: 0,
        audit_needed: false,
        coords: BTreeMap::new(),
    };
    (mesh, a, b)
}

fn area_sum(it: &Interner, tris: &[SubTri], axis: DropAxis) -> BigRational {
    let pt = |v: Vid| point_of(it.get(v));
    tris.iter().fold(BigRational::zero(), |acc, &t| {
        acc + tri_area2(&pt(t[0]), &pt(t[1]), &pt(t[2]), axis)
    })
}

#[test]
fn traversal_recovers_figure8_pinch_with_exact_coverage() {
    let mut it = Interner::new();
    let (mut mesh, a, b) = pinch_mesh(&mut it);
    let axis = mesh.axis;
    let w0 = mesh.w0;
    let before = area_sum(&it, &mesh.tris, axis);
    assert!(
        !edge_exists(&mesh, a, b),
        "precondition: a-b not yet an edge"
    );

    // Routing sanity: the pocket-split boundary walk must BAIL on this pinch
    // (its next-map collapses p's two successors) and request the audit —
    // that bail is what routes the real pipeline into recover_via_traversal.
    let mut probe = Mesh2d {
        tris: mesh.tris.clone(),
        axis,
        w0,
        unrecovered: 0,
        audit_needed: false,
        coords: BTreeMap::new(),
    };
    recover_subsegment(&mut probe, &it, a, b);
    assert!(
        !edge_exists(&probe, a, b),
        "expected the pocket-split boundary walk to bail on the pinch"
    );
    assert!(
        probe.audit_needed,
        "bailing recover_subsegment must request the audit"
    );

    recover_via_traversal(&mut mesh, &it, a, b);

    // Genuine recovery, not a degenerate-triangle artifact.
    assert!(edge_exists(&mesh, a, b), "traversal failed to recover a-b");
    // No Vid-degenerate triangles like [p, x, p].
    for t in &mesh.tris {
        assert!(
            t[0] != t[1] && t[1] != t[2] && t[0] != t[2],
            "Vid-degenerate triangle emitted: {t:?}"
        );
    }
    // Every output triangle wound w0.
    for &t in &mesh.tris {
        assert_eq!(
            orient2d_v(&it, t[0], t[1], t[2], axis),
            w0,
            "triangle not oriented w0: {t:?}"
        );
    }
    // Exact coverage: signed 2-area conserved (BigRational, no tolerance).
    let after = area_sum(&it, &mesh.tris, axis);
    assert_eq!(
        after, before,
        "coverage changed: overlap or hole in the rebuilt pocket"
    );
    // Stronger: no directed edge appears twice (two triangles on the same
    // side of an edge would mean overlapping cover).
    let mut directed: Vec<(Vid, Vid)> = Vec::new();
    for &t in &mesh.tris {
        for e in tri_edges(t) {
            directed.push(e);
        }
    }
    let n = directed.len();
    directed.sort_unstable();
    directed.dedup();
    assert_eq!(
        directed.len(),
        n,
        "a directed edge appears twice: overlapping triangles"
    );
}
