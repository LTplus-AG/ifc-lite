// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for [`super::pocket_rebuild_valid`] (the #1660 follow-up post-condition
//! on `recover_via_traversal`'s rebuilt pocket cover) and for the fail-safe
//! accounting chain a rejected rebuild relies on: a traversal that bails leaves
//! the mesh UNCHANGED, so the conformity audit counts the constraint as
//! unrecovered and the batched void path hard-rejects to the sequential
//! fallback (never a silent false "recovered").

use super::super::interner::{Interner, Vid};
use super::super::retriangulate::{edge_exists, Canonical, Mesh2d, SubTri};
use super::super::retriangulate_recover::{enforce_constraint, recover_via_traversal};
use super::super::{DropAxis, ImplicitPoint, Sign};
use super::{audit_and_recover, pocket_rebuild_valid};
use std::collections::BTreeMap;

fn e2(x: f64, y: f64) -> ImplicitPoint {
    ImplicitPoint::Explicit([x, y, 0.0])
}

/// Four distinct Vids for the pure set-level validation tests.
fn vids4() -> [Vid; 4] {
    let mut it = Interner::new();
    [
        it.intern(e2(0.0, 0.0)),
        it.intern(e2(1.0, 0.0)),
        it.intern(e2(1.0, 1.0)),
        it.intern(e2(0.0, 1.0)),
    ]
}

#[test]
fn accepts_a_valid_two_pocket_cover() {
    let [a, b, c, d] = vids4();
    // Split quad: the shared diagonal appears once per DIRECTION (a,c)/(c,a) -
    // exactly the legitimate adjacent-triangle configuration.
    assert!(pocket_rebuild_valid(&[[a, b, c], [a, c, d]]));
    // Vacuously valid: no replacement triangles, nothing to commit wrongly.
    assert!(pocket_rebuild_valid(&[]));
}

#[test]
fn accepts_a_zero_area_sliver_with_distinct_vids() {
    // Collinear but Vid-distinct: legitimate output of earcut's fan fallback on
    // currently-passing inputs (downstream consolidation cleans it up).
    // Rejecting it would change behavior - the guard must stay narrower.
    let mut it = Interner::new();
    let a = it.intern(e2(0.0, 0.0));
    let m = it.intern(e2(1.0, 0.0));
    let b = it.intern(e2(2.0, 0.0));
    assert!(pocket_rebuild_valid(&[[a, m, b]]));
}

#[test]
fn rejects_vid_degenerate_triangles_in_every_position() {
    let [a, b, _, _] = vids4();
    // A [p, x, p] would fake an a-b edge for `edge_exists` without covering any
    // area - the exact false-recovery the post-condition exists to stop.
    assert!(!pocket_rebuild_valid(&[[a, b, a]]));
    assert!(!pocket_rebuild_valid(&[[a, a, b]]));
    assert!(!pocket_rebuild_valid(&[[b, a, a]]));
    assert!(!pocket_rebuild_valid(&[[a, a, a]]));
}

#[test]
fn rejects_a_duplicated_directed_edge() {
    let [a, b, c, d] = vids4();
    // Identical triangle twice: every directed edge duplicated.
    assert!(!pocket_rebuild_valid(&[[a, b, c], [a, b, c]]));
    // Subtler: the fan a hypothetical degenerate-pocket fallback produces from
    // a ring visiting the same vertex twice, e.g. fan over [a,b,c,?,b,d] -
    // directed edge (a,b) appears in two triangles (same side twice = overlap).
    assert!(!pocket_rebuild_valid(&[[a, b, c], [a, c, b], [a, b, d]]));
}

/// One w0-positive triangle [a,u,v]; constraint (a,b) exits the mesh through
/// edge (u,v), so the ordered traversal finds its entry triangle but the
/// crossed edge is a mesh BOUNDARY - `recover_via_traversal` must bail with the
/// mesh unchanged (same return discipline as a rejected pocket rebuild, which
/// returns before any mesh mutation).
fn boundary_exit_mesh(it: &mut Interner) -> (Mesh2d, Vid, Vid) {
    let a = it.intern(e2(0.0, 0.0));
    let u = it.intern(e2(2.0, 1.0));
    let v = it.intern(e2(1.0, 2.0));
    let b = it.intern(e2(3.0, 3.0));
    let mesh = Mesh2d {
        tris: vec![[a, u, v]],
        axis: DropAxis::Z,
        w0: Sign::Positive,
        unrecovered: 0,
        audit_needed: false,
        coords: BTreeMap::new(),
    };
    (mesh, a, b)
}

#[test]
fn bailed_traversal_leaves_mesh_unchanged_and_audit_counts_unrecovered() {
    let mut it = Interner::new();
    let (mut mesh, a, b) = boundary_exit_mesh(&mut it);
    let before: Vec<SubTri> = mesh.tris.clone();

    recover_via_traversal(&mut mesh, &it, a, b);
    assert_eq!(
        mesh.tris, before,
        "a bailing traversal must not touch the mesh"
    );
    assert!(!edge_exists(&mesh, a, b));

    // The audit re-tries the traversal, then counts against the settled mesh:
    // the unforced edge lands in `unrecovered`, which the batched void path
    // treats as a hard reject (difference_all -> sequential fallback).
    let canon = Canonical {
        corners: [a, mesh.tris[0][1], mesh.tris[0][2]],
        segments: vec![(a, b)],
        points: vec![],
    };
    let axis = mesh.axis;
    audit_and_recover(&mut mesh, &it, &canon, axis);
    assert_eq!(
        mesh.tris, before,
        "audit recovery must also leave the mesh unchanged"
    );
    assert_eq!(
        mesh.unrecovered, 1,
        "the unforced constraint must be counted"
    );
}

#[test]
fn enforce_constraint_reports_audit_needed_when_recovery_fails() {
    let mut it = Interner::new();
    let (mut mesh, a, b) = boundary_exit_mesh(&mut it);
    // Full phase-D path: the pocket split can't force (a,b) (endpoint b is not
    // even a mesh vertex), the traversal fallback bails - `audit_needed` must
    // stay requested so `triangulate` runs the conformity audit at all. This is
    // the same reporting channel a post-condition rejection rides on the
    // enforce_constraint path.
    enforce_constraint(&mut mesh, &it, a, b);
    assert!(!edge_exists(&mesh, a, b));
    assert!(
        mesh.audit_needed,
        "failed recovery must request the conformity audit"
    );
}
