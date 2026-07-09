// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Final conformity audit for [`super::retriangulate::triangulate`]: after the
//! fixed-point recovery loop, force any still-missing constraint sub-edge via the
//! robust traversal fallback, then COUNT the residual against the settled mesh.
//!
//! The two passes are deliberately separate. `recover_via_traversal` deletes the
//! triangles a segment crosses and rebuilds only the boundary chains, which can
//! drop an edge an EARLIER segment forced; counting as-we-go would then report
//! that earlier edge recovered. So recovery runs to completion first, and the
//! unrecovered count is taken over the FINAL mesh — a conservative count that
//! never understates non-conformance (which would let a torn batch masquerade as
//! watertight downstream).

use super::interner::{Interner, Vid};
use super::retriangulate::{
    cmp_lex_v, edge_exists, lex_cmp, orient2d_v, Canonical, Mesh2d,
};
use super::retriangulate_recover::{between, recover_via_traversal};
use super::{DropAxis, Sign};
use std::collections::BTreeSet;

/// Chain decomposition of constraint `(cs,ct)` through its on-segment vertices in
/// the CURRENT mesh (matching `enforce_constraint`).
fn chain_of(mesh: &Mesh2d, it: &Interner, axis: DropAxis, cs: Vid, ct: Vid) -> Vec<Vid> {
    let mut on_seg: Vec<Vid> = mesh
        .tris
        .iter()
        .flatten()
        .copied()
        .collect::<BTreeSet<Vid>>()
        .into_iter()
        .filter(|&v| {
            v != cs
                && v != ct
                && orient2d_v(it, cs, ct, v, axis) == Sign::Zero
                && between(it, cs, ct, v)
        })
        .collect();
    on_seg.sort_by(|&x, &y| lex_cmp(it, x, y));
    if cmp_lex_v(it, cs, ct) == Sign::Positive {
        on_seg.reverse();
    }
    let mut chain = vec![cs];
    chain.extend(on_seg);
    chain.push(ct);
    chain
}

/// Recover any missing constraint sub-edge (last-chance robust traversal), then set
/// `mesh.unrecovered` from a fresh count over the settled mesh.
pub(crate) fn audit_and_recover(mesh: &mut Mesh2d, it: &Interner, canon: &Canonical, axis: DropAxis) {
    for &(cs, ct) in &canon.segments {
        for w in chain_of(mesh, it, axis, cs, ct).windows(2) {
            if !edge_exists(mesh, w[0], w[1]) {
                recover_via_traversal(mesh, it, w[0], w[1]);
            }
        }
    }
    for &(cs, ct) in &canon.segments {
        for w in chain_of(mesh, it, axis, cs, ct).windows(2) {
            if !edge_exists(mesh, w[0], w[1]) {
                mesh.unrecovered += 1;
            }
        }
    }
}
