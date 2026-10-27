// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Mesh-closure verdicts. Each one is a named [`EdgeLedger`] query; the vertex
//! key and the degenerate rule stay the verdict's own.

use super::hairline::{hairline_closed, Unmatched};
use super::ledger::{Degenerate, EdgeLedger, VertexKey};
use crate::mesh::Mesh;

/// The 0.1 mm grid every directed closure verdict snaps to.
const CLOSURE_GRID: VertexKey = VertexKey::GridDiv(1.0e-4);

/// [`CLOSURE_GRID`]'s 0.1 mm pitch expressed in a caller unit, where
/// `length_unit_scale` is metres per caller unit (`0.001` for millimetres).
/// `1.0`, and any scale that is not a finite positive number, is the metre
/// grid itself, bit for bit.
fn closure_grid_in_units(length_unit_scale: f64) -> VertexKey {
    if length_unit_scale.is_finite() && length_unit_scale > 0.0 && length_unit_scale != 1.0 {
        VertexKey::GridDiv(1.0e-4 / length_unit_scale)
    } else {
        CLOSURE_GRID
    }
}

/// Cached result of the shared 0.1 mm directed-edge walk.
///
/// Strict callers read the directed verdict without running the hairline
/// matcher. Emit callers first accept strict closure and only then evaluate
/// the bounded T-junction tolerance from the same edge counts (#4796).
pub struct ClosureVerdict {
    has_edges: bool,
    bad: Vec<Unmatched>,
}

impl ClosureVerdict {
    pub fn for_mesh(mesh: &Mesh) -> Self {
        Self::for_mesh_in_units(mesh, 1.0)
    }

    /// The same walk with the 0.1 mm grid (and so the hairline matcher's
    /// grid-unit slack) measured in the mesh's own length unit. A mesh still
    /// in millimetre file units read on the metre grid is audited at 0.1 µm,
    /// a thousand times finer than the tolerance this verdict documents (#7982).
    pub fn for_mesh_in_units(mesh: &Mesh, length_unit_scale: f64) -> Self {
        let grid = closure_grid_in_units(length_unit_scale);
        let ledger = EdgeLedger::build(mesh, grid, Degenerate::SkipTriangle);
        Self { has_edges: !ledger.is_empty(), bad: ledger.unbalanced().collect() }
    }

    pub fn is_directed_closed(&self) -> bool {
        self.has_edges && self.bad.is_empty()
    }

    pub fn closed_enough_to_emit(&self) -> bool {
        self.has_edges && (self.bad.is_empty() || hairline_closed(&self.bad))
    }
}

/// DIRECTED quantized closed-surface audit (0.1 mm grid): every directed edge
/// must be cancelled by its reverse. Strictly stronger than the undirected
/// 2-manifold check: it catches inconsistent winding and doubled coincident
/// surfaces (two triangles sharing an edge in the SAME direction), not just
/// cracks. Triangles that collapse to a degenerate key on the grid are skipped.
/// An empty mesh is not closed.
pub fn directed_closed(mesh: &Mesh) -> bool {
    let ledger = EdgeLedger::build(mesh, CLOSURE_GRID, Degenerate::SkipTriangle);
    !ledger.is_empty() && ledger.directed_closed()
}
#[allow(dead_code, reason = "Shared test oracle alias")]
/// Closed-surface audit with a HAIRLINE tolerance: the surface passes when
/// every unpaired directed edge (0.1 mm grid) is collinearly COVERED by
/// unpaired edges of the opposite net sign, the signature of two adjacent faces
/// subdividing a shared boundary line differently (a T-junction chain, an
/// invisible sub-grid gap), NOT of a missing surface. A genuine hole leaves a
/// boundary loop whose edges have nothing opposite along them and fails. The
/// exact kernel's own output is routinely NOT even undirected-watertight on
/// these hosts, so this gate is still far stricter than the status quo.
pub fn closed_or_hairline(mesh: &Mesh) -> bool {
    ClosureVerdict::for_mesh(mesh).closed_enough_to_emit()
}

/// Named emit contract for callers that tolerate bounded T-junction hairlines.
pub fn closed_enough_to_emit(mesh: &Mesh) -> bool {
    ClosureVerdict::for_mesh(mesh).closed_enough_to_emit()
}

/// Per-undirected-edge MULTIPLICITY defects, the class the signed predicates
/// above are structurally blind to.
///
/// Those predicates tally `+1` forward and `-1` reverse and pass when
/// everything nets to zero. Cancellation is what makes a hairline T-junction
/// chain forgivable, but it also erases multiplicity: an edge used by FOUR
/// triangles, two each way, nets to zero and reads as closed. That is a
/// doubled coincident surface, not a solid boundary.
///
/// * `over_used`: an undirected edge with MORE than two triangle uses
///   (non-manifold: a fin, a doubled skin, or self-intersecting output).
/// * `same_direction`: an undirected edge with exactly two uses running the
///   SAME way round (inconsistent winding: one neighbour is flipped).
///
/// An edge used ONCE is deliberately NOT a defect here: that is an open
/// boundary, which the closure predicates already measure and which
/// T-junction tessellation trips constantly. Keeping it out is what lets a
/// caller gate on this without inheriting that class's false-positive rate.
#[cfg_attr(not(any(test, feature = "csg_manifold_gate", feature = "test-support")), allow(dead_code))]
#[derive(Debug, Default, PartialEq, Eq)]
pub struct EdgeMultiplicityDefects {
    /// Undirected edges used by more than two triangles.
    pub over_used: usize,
    /// Undirected edges used exactly twice, both uses running the same way.
    pub same_direction: usize,
}

#[cfg_attr(not(any(test, feature = "csg_manifold_gate", feature = "test-support")), allow(dead_code))]
impl EdgeMultiplicityDefects {
    /// True when the mesh carries neither defect.
    pub fn is_clean(&self) -> bool {
        self.over_used == 0 && self.same_direction == 0
    }
}

/// Count the [`EdgeMultiplicityDefects`] of `mesh`, keyed EXACTLY.
///
/// The closure verdicts snap vertices to a 0.1 mm grid, which is right for
/// them (two corners a hair apart should close) and wrong here: snapping merges
/// two distinct vertices closer than a cell into one key, and the moment two
/// distinct edges collapse onto one key their uses ADD, so two manifold
/// surfaces 0.03 mm apart would report a four-use edge that exists in neither.
/// For a REJECTION predicate that errs toward throwing away geometry that was
/// never wrong. So the keys are the vertex coordinates bit for bit, with `-0.0`
/// folded to `0.0` (one point). The cost is a miss, not a false positive: a
/// non-manifold edge whose endpoints differ in the last bit reads as two edges.
/// The kernel interns coincident corners, so a real shared edge in its output
/// is bit-identical at both ends.
///
/// Non-finite coordinates cannot reach here (every caller runs `validate_mesh`
/// first), so no NaN key can split a vertex from itself.
#[cfg_attr(not(any(test, feature = "csg_manifold_gate", feature = "test-support")), allow(dead_code))]
pub fn edge_multiplicity_defects(mesh: &Mesh) -> EdgeMultiplicityDefects {
    EdgeLedger::build(mesh, VertexKey::BitsZeroFolded, Degenerate::SkipTriangle).multiplicity_defects()
}

/// Closed-surface check on exact f32 bit coords: every directed edge paired and
/// no degenerate edge. The #2176 lesson: only per-component-watertight solid
/// cutters may join a batched group; an open component poisons the whole
/// group's ray parity (batch admission).
pub fn directed_closed_exact(mesh: &Mesh) -> bool {
    // `indices` non-empty, not "ledger non-empty": a lone partial triangle has
    // no edges and has always passed.
    let ledger = EdgeLedger::build(mesh, VertexKey::Bits, Degenerate::Reject);
    !mesh.indices.is_empty() && ledger.directed_closed()
}

/// Number of 0.1 mm-welded undirected edges whose triangle multiplicity is not
/// two; `usize::MAX` when no triangle survives the grid.
pub fn undirected_defect_count(mesh: &Mesh) -> usize {
    let ledger = EdgeLedger::build(mesh, CLOSURE_GRID, Degenerate::SkipTriangle);
    if ledger.is_empty() {
        return usize::MAX;
    }
    ledger.undirected_defects()
}

/// Every undirected edge is used exactly once each way on a grid of `per_unit`
/// cells per world unit, collapsed triangles skipped. The strict directed-pair
/// rule (#3397), not just a zero net balance (which a 2-forward/2-reverse seam
/// or a duplicated sheet also satisfies). An empty mesh does not pass.
pub fn strictly_paired_at(mesh: &Mesh, per_unit: f64) -> bool {
    let ledger = EdgeLedger::build(mesh, VertexKey::GridMul(per_unit), Degenerate::SkipTriangle);
    !ledger.is_empty() && ledger.strictly_paired()
}

/// The documented definition of "watertight" for new code and tests: vertices
/// on the 0.1 mm grid, collapsed triangles skipped, every edge used exactly
/// once each way, and at least one edge. Existing gates keep their own keys
/// and rules (see [`super`]); this is the one to reach for when writing a new
/// check.
#[cfg_attr(not(any(test, feature = "test-support")), allow(dead_code))]
pub fn is_watertight(mesh: &Mesh) -> bool {
    let ledger = EdgeLedger::build(mesh, CLOSURE_GRID, Degenerate::SkipTriangle);
    !ledger.is_empty() && ledger.strictly_paired()
}
