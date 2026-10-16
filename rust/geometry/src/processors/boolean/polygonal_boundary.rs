// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The 2D boundary of an `IfcPolygonalBoundedHalfSpace`: read, capped, checked.

use super::BooleanClippingProcessor;
use crate::diagnostics::{BoolFailureReason, BoolOp};
use crate::profiles::ProfileProcessor;
use crate::{Error, Point2, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

/// Most distinct vertices a bounded half-space boundary may have before the
/// cut is refused (#7786). Prism build, earcut cap triangulation and the exact
/// subtract all grow faster than linearly in it: a 4,000-point
/// `IfcIndexedPolyCurve` took 11.9 s. The corpus maximum is 21 (ISSUE_068;
/// every other model is 13 or fewer), so 256 leaves more than ten times that.
///
/// A refusal leaves the host UNCUT with one `KernelError` record (D3, D16;
/// the #7688 unreadable-cutter rule). It does not take the
/// `PolygonalBoundedHalfSpaceFallback` unbounded plane clip: the boundary is
/// readable, so main cut it correctly (slowly), and the unbounded clip would
/// remove every bit of host outside the polygon.
pub(super) const MAX_BOUNDARY_VERTICES: usize = 256;

impl BooleanClippingProcessor {
    /// The boundary as a 2D contour in Position's XY plane. Any
    /// `IfcBoundedCurve` the profile curve sampler reads (`IfcPolyline`,
    /// `IfcIndexedPolyCurve`, composite and trimmed curves): an
    /// IfcPolyline-only reader refused the IFC4 exporters' indexed poly curves,
    /// and the refusal fell back to the UNBOUNDED plane clip, over-cutting
    /// everything outside the polygon (#7688 PROC-S18).
    ///
    /// `Ok(None)`: the boundary is over [`MAX_BOUNDARY_VERTICES`]; the refusal
    /// is already on record and the caller leaves the host uncut.
    pub(super) fn parse_polygonal_boundary_2d(
        &self,
        boundary: &DecodedEntity,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
    ) -> Result<Option<Vec<Point2<f64>>>> {
        let mut contour: Vec<Point2<f64>> = ProfileProcessor::new(self.schema.clone())
            .get_curve_points(boundary, decoder, quality)?
            .into_iter()
            .map(|p| Point2::new(p.x, p.y))
            .collect();

        if contour.len() > 1 {
            let first = contour[0];
            let last = contour[contour.len() - 1];
            if (first.x - last.x).abs() < 1e-9 && (first.y - last.y).abs() < 1e-9 {
                contour.pop();
            }
        }

        // Counted after the closing-point pop (a closed 256-gon is 256), and
        // before the O(n^2) simplicity check and the prism build.
        if contour.len() > MAX_BOUNDARY_VERTICES {
            self.record_failure(
                BoolOp::Difference,
                BoolFailureReason::KernelError(format!(
                    "IfcPolygonalBoundedHalfSpace boundary has {} vertices, over the \
                     {MAX_BOUNDARY_VERTICES} cap; host left uncut",
                    contour.len()
                )),
            );
            return Ok(None);
        }

        if contour.len() < 3 {
            return Err(Error::geometry(
                "PolygonalBoundary must contain at least 3 distinct points".to_string(),
            ));
        }
        // Self-touching non-polyline boundaries take the recorded fallback
        // (ISSUE_129 #236054); IfcPolyline keeps main's reader exactly (#7688).
        if boundary.ifc_type != IfcType::IfcPolyline && !Self::boundary_is_simple(&contour) {
            return Err(Error::geometry("PolygonalBoundary crosses itself".to_string()));
        }

        Ok(Some(contour))
    }

    /// No two non-adjacent edges of the closed contour touch (exact
    /// predicates). Repeated consecutive points are not edges.
    fn boundary_is_simple(contour: &[Point2<f64>]) -> bool {
        let mut ring: Vec<[f64; 2]> = contour.iter().map(|p| [p.x, p.y]).collect();
        ring.dedup();
        let n = ring.len();
        let edge = |i: usize| (ring[i], ring[(i + 1) % n]);
        (0..n).all(|i| {
            (i + 2..n).filter(|&j| (j + 1) % n != i).all(|j| {
                let ((a, b), (c, d)) = (edge(i), edge(j));
                !crate::geom2d::segments_intersect(a, b, c, d)
            })
        })
    }
}
