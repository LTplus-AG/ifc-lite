// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Numerical half of the grouped polygonal-bounded half-space cut (issue
//! #960): owned base and cutter-prism meshes in, one unioned subtract out.
//! No decoder or source is read here; the caller owns the failure-log
//! rewind, so a deferral leaves no trace of this speculative attempt.

use super::polygonal_removal;
use super::BooleanClippingProcessor;
use crate::diagnostics::BoolFailure;
use crate::{ClippingProcessor, Mesh, Point3};

/// Outcome of one grouped-cut attempt.
pub(super) enum GroupExecution {
    /// Batching is not provably safe; the sequential path resolves the chain.
    Defer,
    /// The cutter union produced nothing usable. Carries the kernel failures
    /// the attempt alone saw, for the caller to keep after its rewind.
    UnionUnavailable(Vec<BoolFailure>),
    /// The accepted single subtract, with the kernel failures it recorded.
    Clipped {
        mesh: Mesh,
        failures: Vec<BoolFailure>,
    },
}

impl BooleanClippingProcessor {
    /// Subtract the union of `prisms` from `base_mesh`, guarded by the
    /// per-cutter trial subtracts, the #3919 accept gate, the #3925
    /// removal-bound repair and the intersected-bounds check.
    ///
    /// **Measured contract (issue #3980):** `build_cutter_union` does NOT
    /// verify that its union is watertight or manifold; the checks above are
    /// what keep a non-closed union from producing a wrong subtraction.
    pub(super) fn execute_polygonal_group(
        &self,
        base_mesh: &Mesh,
        prisms: &[Mesh],
        length_unit_scale: f64,
    ) -> GroupExecution {
        let clipper = ClippingProcessor::with_unit_scale(length_unit_scale);

        // Per-cutter trial subtracts serve two roles:
        //   * reject the chain if any single cutter is degenerate (a full-
        //     cross-section coincident-face clip whose bounded subtract is
        //     fragile — duplex.ifc "Party Wall" #4287/#4399, which the
        //     sequential path rescues via its bounded→unbounded fallback), and
        //   * record the intersection of every single-cutter result's bounds.
        //     The true answer (base minus the union of ALL cutters) is a subset
        //     of each single-cutter result, so its bounds can't exceed that
        //     intersection. If the unioned subtract below pokes outside it, the
        //     CSG union silently under-removed (manifold does this for near-
        //     coincident/duplicate cutters) and must not be trusted.
        let mut tight_min = Point3::new(f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
        let mut tight_max = Point3::new(f32::INFINITY, f32::INFINITY, f32::INFINITY);
        let mut removal_bound = polygonal_removal::RemovalBound::new(base_mesh);
        for prism in prisms {
            // `subtract_checked` folds in the #3919 accept-gate check: a
            // rejection hands back the base UN-CUT, which would wrongly widen
            // tight_min/tight_max, so it is treated like empty/errored/degenerate.
            let Some(trial) = Self::subtract_checked(&clipper, base_mesh, prism) else {
                let _ = clipper.take_failures();
                return GroupExecution::Defer;
            };
            if !clipper.take_failures().is_empty() {
                // A diagnostic-only tear is not a default accept gate. It
                // cannot certify a moved cutter's removal bound, either.
                removal_bound.invalidate();
            } else {
                removal_bound.observe(&trial);
            }
            let (tmn, tmx) = trial.bounds();
            tight_min = Point3::new(
                tight_min.x.max(tmn.x),
                tight_min.y.max(tmn.y),
                tight_min.z.max(tmn.z),
            );
            tight_max = Point3::new(
                tight_max.x.min(tmx.x),
                tight_max.y.min(tmx.y),
                tight_max.z.min(tmx.z),
            );
        }
        let _ = clipper.take_failures();

        // Every cutter is a clean partial cut: union them into ONE solid (a
        // true CSG union, so abutting roof segments share no internal seam)
        // and subtract once. This is what eliminates the zero-thickness seam
        // fins that sequential subtraction leaves behind and the deep-chain
        // MAX_BOOLEAN_DEPTH drops. `build_cutter_union` returns `None` when
        // the primary result is empty and the fallback is empty or errors —
        // it does not check the union for closure (issue #3980; see its doc
        // comment for the measured contract) — so we still defer whenever no
        // kernel produces even a nonempty result, which is the case that used
        // to feed a broken union into the subtract and have the CSG kernel
        // silently return the host UNCHANGED (issue #960 wall #2152: the gable-end
        // wall rendered at full 7000 mm extrusion height).
        let combined = match self.build_cutter_union(&clipper, prisms) {
            Some(m) if !m.is_empty() => m,
            _ => {
                // Unlike the trial-subtract probes above (whose failures the
                // sequential path re-encounters and re-logs), the union
                // attempt is unique to this path: its kernel failures are
                // handed back so the caller can preserve them and record the
                // deferral, since the sequential fallback can leave seam fins
                // the batched subtract avoids.
                return GroupExecution::UnionUnavailable(clipper.take_failures());
            }
        };
        // `subtract_checked` folds in the #3919 accept-gate check: a rejected
        // gate hands back the base UN-CUT — the same shape as "nothing to
        // cut", which `difference_result_looks_degenerate` can't catch — so
        // it is treated like a kernel error and defers to the sequential
        // per-cutter path (whose own accept-gate + #635 fallback handle it).
        // Uncaught, the full-height base used to be accepted here and the
        // issue-#960 seam sliver silently regrew.
        let mut checked = Self::subtract_checked(&clipper, base_mesh, &combined);
        let mut cut_failures = clipper.take_failures();
        if (checked.is_none() || !cut_failures.is_empty()) && removal_bound.is_valid() {
            // #3925: a rejected or diagnostically torn cut permits one moved
            // candidate. Publish it only if its actual subtraction is clean;
            // otherwise retain the original result and its failure records.
            let refs: Vec<&Mesh> = prisms.iter().collect();
            let repaired = clipper.consolidate(crate::kernel::mesh_bridge::union_many(&refs));
            if !repaired.is_empty() {
                let candidate = Self::subtract_checked(&clipper, base_mesh, &repaired);
                let candidate_failures = clipper.take_failures();
                if candidate.as_ref().is_some_and(|m| removal_bound.allows(m))
                    && candidate_failures.is_empty()
                {
                    checked = candidate;
                    cut_failures = candidate_failures;
                }
            }
        }
        let Some(clipped) = checked else {
            return GroupExecution::Defer;
        };

        // Reject a silently under-removing union: the result must fit inside the
        // intersection of the single-cutter result bounds (tolerance scaled to
        // the host size). If it pokes outside, the union dropped a cut — defer
        // to sequential. (duplex.ifc: a near-coincident cutter pair unions to
        // less than either alone.)
        let (rmn, rmx) = clipped.bounds();
        let diag = (tight_max.x - tight_min.x)
            .hypot(tight_max.y - tight_min.y)
            .hypot(tight_max.z - tight_min.z);
        let tol = (diag * 1e-3).max(1e-4);
        let under_removed = rmx.x > tight_max.x + tol
            || rmx.y > tight_max.y + tol
            || rmx.z > tight_max.z + tol
            || rmn.x < tight_min.x - tol
            || rmn.y < tight_min.y - tol
            || rmn.z < tight_min.z - tol;
        if under_removed {
            return GroupExecution::Defer;
        }
        GroupExecution::Clipped {
            mesh: clipped,
            failures: cut_failures,
        }
    }
}

#[cfg(test)]
#[path = "polygonal_group_execution_tests.rs"]
mod tests;
