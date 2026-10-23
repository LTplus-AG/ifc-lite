// SPDX-License-Identifier: MPL-2.0
//! Classified opening context and parametric source frames.
use super::{bool2d_path, CutterKind};
use super::malformed_opening_repair::{opening_obb_if_malformed, OpeningBox};
use crate::Point3;
use nalgebra::Matrix3;

/// Pre-computed per-element void subtraction data.
///
/// Building this is expensive: the owned host-opening control
/// (`program::openings::OpeningControl::host`) re-runs the product pipeline on each
/// `IfcOpeningElement` and probes the host's parametrics. Once built, it can be
/// reused across every sub-mesh of the same element without re-doing any of
/// that work, so the voided styled program pays the classification cost once
/// per element rather than once per sub-mesh.
pub(crate) struct VoidContext {
    /// All classified openings. The diagonal-opening pass needs the raw list
    /// (unmerged) so its per-item box rotation stays accurate.
    pub(crate) openings: Vec<CutterKind>,
    /// Rectangular openings merged into larger boxes to prevent O(2^N)
    /// triangle growth when many adjacent openings tile a surface.
    pub(crate) merged_openings: Vec<CutterKind>,
    /// Parametric placement-frame cut data (host + reconciled opening boxes),
    /// captured only when `rect_fast::param_enabled()`. Drives the analytic fast
    /// path in `apply_void_context`; `None` defers to the exact kernel.
    pub(crate) param: Option<ParamRectCut>,
    /// 2D opening-subtraction data (host profile + projected opening footprints),
    /// captured only when `bool2d_path::enabled()`. Drives the arbitrary-profile
    /// 2D re-extrude fast path in `apply_void_context`, tried after the rect
    /// parametric path; `None` defers to the exact kernel.
    pub(crate) bool2d: Option<bool2d_path::Bool2dCut>,
}

impl VoidContext {
    pub(super) fn is_noop(&self) -> bool {
        self.openings.is_empty()
    }

    /// Rectangular openings in the merged set: what every cut path records as
    /// `HostOpeningDiagnostic::rect_boxes_processed`, so the silent-no-op
    /// detector reads one quantity whichever path cut the host.
    pub(super) fn rect_opening_count(&self) -> usize {
        self.merged_openings
            .iter()
            .filter(|o| matches!(o, CutterKind::Rectangular(..)))
            .count()
    }

    /// True iff every cutter mesh is already in world coords (`origin == 0`). When
    /// so AND the host is world-framed, `apply_void_context` can run the inner CSG
    /// directly (the native / legacy fast path) without cloning the cutters; if any
    /// cutter carries its own per-element origin it must be relativized first.
    pub(super) fn all_cutters_world_framed(&self) -> bool {
        let world = |o: &CutterKind| match o {
            CutterKind::Rectangular(..) => true,
            CutterKind::DiagonalRectangular(m, _) => m.origin == [0.0, 0.0, 0.0],
            CutterKind::NonRectangular(m, ..) => m.origin == [0.0, 0.0, 0.0],
        };
        self.openings.iter().all(world) && self.merged_openings.iter().all(world)
    }

    /// Return a copy of this context with every opening (raw + merged)
    /// translated by `-origin`, i.e. moved from the world frame into the host's
    /// per-element local frame. Used by [`crate::GeometryRouter::apply_void_context`]
    /// so the cutters share the host's local frame for the CSG — the missing
    /// piece that previously made relativizing only the host silently drop cuts.
    pub(super) fn relativized_by(&self, origin: [f64; 3]) -> VoidContext {
        VoidContext {
            openings: self.openings.iter().map(|o| o.translated(origin)).collect(),
            merged_openings: self
                .merged_openings
                .iter()
                .map(|o| o.translated(origin))
                .collect(),
            // The parametric path runs in the OUTER apply_void_context on the
            // non-relativized world mesh (it makes its own frame), so the
            // relativized context never uses `param` — drop it.
            param: None,
            // Likewise the 2D path builds its own world frame from the parametrics
            // and runs in the OUTER apply_void_context; the relativized context
            // never uses it.
            bool2d: None,
        }
    }

    /// Oriented boxes of the REAL openings whose cutter mesh is MALFORMED —
    /// self-intersecting tessellated voids carrying garbage "fin" vertices far
    /// from the actual hole (a broken export). The kernel under-cuts such a
    /// cutter, leaving a wall flap bridging the opening; these boxes mark the
    /// region that MUST end up empty so a post-cut pass can drop the flap.
    /// Empty when every cutter is well-formed, so clean hosts are untouched.
    pub(super) fn malformed_opening_boxes(&self) -> Vec<OpeningBox> {
        self.openings
            .iter()
            .filter_map(|o| match o {
                CutterKind::NonRectangular(m, ..) => opening_obb_if_malformed(m),
                _ => None,
            })
            .collect()
    }
}

/// EXACT parametric oriented box of a rectangular extrusion, in WORLD space.
/// `r` columns are the orthonormal world axes (profile-X', profile-Y', extrude);
/// `half` are the half-extents along those axes (XDim/2, YDim/2, Depth/2).
/// Produced by [`crate::GeometryRouter::parametric_rect_probe`].
#[derive(Clone, Copy)]
pub struct RectParam {
    pub r: Matrix3<f64>,
    pub center: Point3<f64>,
    pub half: [f64; 3],
}

/// Captured parametric boxes for a host + its openings (all reconciled to their
/// meshes and sharing the host frame), enabling the analytic placement-frame cut.
/// Captured by the owned host-opening control only when `param_enabled()`.
#[derive(Clone)]
pub(crate) struct ParamRectCut {
    pub(crate) host: RectParam,
    pub(crate) openings: Vec<RectParam>,
}

