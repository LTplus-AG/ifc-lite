// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The frame serialized mesh vertices are expressed in: how it is chosen
//! ([`MeshFrame::select`]) and how it is named on the wire
//! ([`MeshCoordinateSpace`]).
//!
//! One selection, one home: the native pipeline (`processor/mod.rs`) and the
//! browser pre-pass resolver (`stream_meta.rs`) both choose their frame
//! through [`MeshFrame::select`], and the wire tag is spelled only by the
//! `serde` attribute on [`MeshCoordinateSpace`].

use ifc_lite_core::{EntityDecoder, RtcVerdict};
use ifc_lite_geometry::GeometryRouter;
use serde::{Deserialize, Serialize};

/// Epsilon (metres) below which a placement translation is treated as identity.
/// Avoids overriding a detected RTC anchor when `IfcSite` sits at the origin
/// while the geometry itself carries large world coordinates.
/// [`rotation_is_identity`] below uses the same epsilon on the rotation block.
pub(crate) const PLACEMENT_IDENTITY_EPSILON: f64 = 1e-9;

/// True when a column-major 4x4 matrix's 3x3 rotation block is (within
/// [`PLACEMENT_IDENTITY_EPSILON`]) the identity — i.e. the placement it came
/// from is a pure translation, contributing no rotation of its own.
///
/// A matrix shorter than 16 elements is treated conservatively as NOT
/// identity (callers that gate a "safe to keep" decision on this should keep
/// dropping rather than assume something about a shape they can't read).
///
/// Lives here, beside the epsilon and beside [`MeshFrame::rotate_into_frame`],
/// because it is the condition under which a frame removes a rotation at all.
/// Shared by `processor::site_local::apply_inverse_rotation_in_place` (skip
/// the no-op rotation pass) and `element.rs`'s instancing/local-bounds guard
/// (#4118: a pure translation site placement never rotates positions, so
/// metadata captured before `convert_mesh_to_site_local` runs is never
/// invalidated by it).
#[inline]
pub(crate) fn rotation_is_identity(column_major_matrix: &[f64]) -> bool {
    if column_major_matrix.len() < 16 {
        return false;
    }
    let r00 = column_major_matrix[0];
    let r10 = column_major_matrix[1];
    let r20 = column_major_matrix[2];
    let r01 = column_major_matrix[4];
    let r11 = column_major_matrix[5];
    let r21 = column_major_matrix[6];
    let r02 = column_major_matrix[8];
    let r12 = column_major_matrix[9];
    let r22 = column_major_matrix[10];

    (r00 - 1.0).abs() < PLACEMENT_IDENTITY_EPSILON
        && r10.abs() < PLACEMENT_IDENTITY_EPSILON
        && r20.abs() < PLACEMENT_IDENTITY_EPSILON
        && r01.abs() < PLACEMENT_IDENTITY_EPSILON
        && (r11 - 1.0).abs() < PLACEMENT_IDENTITY_EPSILON
        && r21.abs() < PLACEMENT_IDENTITY_EPSILON
        && r02.abs() < PLACEMENT_IDENTITY_EPSILON
        && r12.abs() < PLACEMENT_IDENTITY_EPSILON
        && (r22 - 1.0).abs() < PLACEMENT_IDENTITY_EPSILON
}

#[inline]
fn translation_is_nonidentity(t: (f64, f64, f64)) -> bool {
    t.0.abs() > PLACEMENT_IDENTITY_EPSILON
        || t.1.abs() > PLACEMENT_IDENTITY_EPSILON
        || t.2.abs() > PLACEMENT_IDENTITY_EPSILON
}

/// The frame a pipeline meshes into: the translation it subtracts and, in the
/// site tier, the rotation it removes.
///
/// Both pipelines build it with [`MeshFrame::select`]. The offset, the
/// rotation, the needs-shift bit and the wire tag are read off the one value,
/// so they cannot disagree with each other.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MeshFrame {
    /// `IfcSite` has a non-identity translation: subtract it. Vertices land
    /// relative to the site origin, small floats in a relatable frame. The
    /// native pipeline also removes the site rotation
    /// (`convert_mesh_to_site_local`) for this tier.
    ///
    /// Carries the whole site placement (column-major 4x4, metres), not just
    /// the translation it subtracts, so the frame describes BOTH halves of
    /// what the bake did: a baked point is `Rᵀ · (P − t)`. A consumer that
    /// has to land in the same frame — the symbolic stream the server ships
    /// beside these meshes (#4706) — reads the rotation through
    /// [`MeshFrame::rotate_into_frame`] instead of fetching the site
    /// placement itself and re-deriving the tier rule.
    SiteLocal { placement: [f64; 16] },
    /// `IfcSite` is identity or missing but the sampled geometry lives at
    /// large world coordinates: subtract the detected anchor so f32 keeps its
    /// precision. No rotation is removed.
    ModelRtc { anchor: (f64, f64, f64) },
    /// Neither anchor applies: subtract nothing.
    RawIfc,
}

impl MeshFrame {
    /// The three-tier selection.
    ///
    /// * `site_placement`: the `IfcSite` placement as a column-major 4x4 in
    ///   metres (`GeometryRouter::resolve_scaled_placement`), `None` when the
    ///   pipeline has no site tier (the browser pre-pass and the appearance
    ///   authoring path mesh in world axes and pass `None` deliberately: see
    ///   `stream_meta::resolve_stream_meta`). A matrix with fewer than 16
    ///   elements is not a placement this can read, so it falls through to
    ///   the detector rather than indexing past its end.
    /// * `detected`: the RTC detector's verdict (see
    ///   `GeometryRouter::detect_rtc_offset_for_file`). A `Large` verdict
    ///   is honoured whatever its anchor's own magnitude: the placement-bounds
    ///   fallback decides on the bbox corners and anchors on the centre, which
    ///   can be inside 10 km while the coordinates are not. Only an anchor at
    ///   the origin (nothing to subtract) falls through to `RawIfc`.
    pub fn select(site_placement: Option<&[f64]>, detected: Option<RtcVerdict>) -> Self {
        if let Some(matrix) = site_placement
            .filter(|m| m.len() >= 16)
            .filter(|m| translation_is_nonidentity((m[12], m[13], m[14])))
        {
            let mut placement = [0.0; 16];
            placement.copy_from_slice(&matrix[..16]);
            return Self::SiteLocal { placement };
        }
        match detected {
            Some(RtcVerdict::Large { anchor }) if translation_is_nonidentity(anchor) => {
                Self::ModelRtc { anchor }
            }
            _ => Self::RawIfc,
        }
    }

    /// Frame for file-parsing consumers: grid/alignment overlays and the
    /// browser symbolic stream (#4665). It uses the same file-scoped sample
    /// window as the browser meshes, so their anchors agree (#4611).
    ///
    /// NOT for a consumer that ran the native pipeline over the same bytes:
    /// there is a site tier there, and this has none, so the two frames
    /// disagree on every translated `IfcSite`. Such a caller passes the frame
    /// its meshes were baked in (`ProcessingResult::frame`, #4706).
    ///
    /// Also NOT guaranteed to match the STREAMING browser pre-pass, which
    /// samples only the indexed head when it emits mid-scan. A model whose
    /// head does not represent its tail can therefore differ; closing that
    /// requires handing the emitted frame to the overlay APIs (#4611).
    pub fn for_overlay(router: &GeometryRouter, content: &[u8], decoder: &mut EntityDecoder) -> Self {
        Self::select(None, router.detect_rtc_offset_for_file(content, decoder))
    }

    /// The translation the router subtracts from every world vertex before
    /// the f32 cast; `(0,0,0)` for [`MeshFrame::RawIfc`].
    #[inline]
    pub fn rtc_offset(self) -> (f64, f64, f64) {
        match self {
            Self::SiteLocal { placement } => (placement[12], placement[13], placement[14]),
            Self::ModelRtc { anchor } => anchor,
            Self::RawIfc => (0.0, 0.0, 0.0),
        }
    }

    /// An IFC world DIRECTION expressed in this frame's own axes: `Rᵀ · v`.
    ///
    /// The other half of the frame, beside [`MeshFrame::rtc_offset`]. A world
    /// POINT lands at `rotate_into_frame(p − rtc_offset)`, which is exactly
    /// what `processor::site_local::convert_mesh_to_site_local` bakes into
    /// the vertices for the [`MeshFrame::SiteLocal`] tier — same `Rᵀ`, and
    /// applied under the same [`rotation_is_identity`] condition, so a
    /// consumer that re-bases with this cannot disagree with the meshes.
    ///
    /// The identity for [`MeshFrame::ModelRtc`] and [`MeshFrame::RawIfc`]:
    /// neither tier removes a rotation.
    #[inline]
    pub fn rotate_into_frame(self, v: [f64; 3]) -> [f64; 3] {
        match self {
            Self::SiteLocal { placement } if !rotation_is_identity(&placement) => [
                placement[0] * v[0] + placement[1] * v[1] + placement[2] * v[2],
                placement[4] * v[0] + placement[5] * v[1] + placement[6] * v[2],
                placement[8] * v[0] + placement[9] * v[1] + placement[10] * v[2],
            ],
            _ => v,
        }
    }

    /// True when the frame subtracts anything at all.
    #[inline]
    pub fn needs_shift(self) -> bool {
        !matches!(self, Self::RawIfc)
    }

    /// The wire tag for this frame.
    #[inline]
    pub fn coordinate_space(self) -> MeshCoordinateSpace {
        match self {
            Self::SiteLocal { .. } => MeshCoordinateSpace::SiteLocal,
            Self::ModelRtc { .. } => MeshCoordinateSpace::ModelRtc,
            Self::RawIfc => MeshCoordinateSpace::RawIfc,
        }
    }
}

/// Which frame serialized mesh vertices are expressed in.
///
/// The string form is the wire contract (`ParseResponse::mesh_coordinate_space`,
/// the server's stream `Complete` event, the FFI JSON, the Parquet metadata
/// headers): `site_local`, `model_rtc`, `raw_ifc`, spelled by the `serde`
/// attribute below.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeshCoordinateSpace {
    /// Vertices are relative to the `IfcSite` placement: its translation was
    /// subtracted and its rotation removed (small floats in a meaningful,
    /// relatable frame, useful for coordination).
    SiteLocal,
    /// `IfcSite` is identity (or missing) but the geometry lives at large
    /// world coordinates: a detected model-level anchor was subtracted so f32
    /// keeps its precision. No rotation was removed.
    ModelRtc,
    /// Neither anchor applies: nothing was subtracted, vertices are in raw IFC
    /// world space.
    RawIfc,
}

// Regression tests for #4611 (one frame selection for native and browser).
#[cfg(test)]
mod tests {
    use super::*;

    const FAR: (f64, f64, f64) = (2_679_062.0, 1_247_992.0, 532.0);
    const LARGE_FAR: RtcVerdict = RtcVerdict::Large { anchor: FAR };

    /// A column-major 4x4 site placement: identity rotation, `t` translation.
    fn site_at(t: (f64, f64, f64)) -> [f64; 16] {
        let mut m = [0.0; 16];
        m[0] = 1.0;
        m[5] = 1.0;
        m[10] = 1.0;
        m[15] = 1.0;
        m[12] = t.0;
        m[13] = t.1;
        m[14] = t.2;
        m
    }

    /// The same, yawed `degrees` about Z.
    fn site_at_yawed(t: (f64, f64, f64), degrees: f64) -> [f64; 16] {
        let (s, c) = degrees.to_radians().sin_cos();
        let mut m = site_at(t);
        m[0] = c;
        m[1] = s;
        m[4] = -s;
        m[5] = c;
        m
    }

    /// The site tier wins whenever the site is translated at all, and it wins
    /// over a detected anchor. Deleting the site arm of `select` sends the
    /// first two cases to `ModelRtc`/`RawIfc`.
    #[test]
    fn a_translated_site_selects_site_local_over_everything() {
        let placement = site_at((500.0, 0.0, 0.0));
        let frame = MeshFrame::select(Some(&placement), Some(LARGE_FAR));
        assert_eq!(frame, MeshFrame::SiteLocal { placement });
        assert_eq!(frame.rtc_offset(), (500.0, 0.0, 0.0));
        assert!(frame.needs_shift());
        assert_eq!(frame.coordinate_space(), MeshCoordinateSpace::SiteLocal);
        let tiny = site_at((0.0, 0.0, 1e-6));
        assert_eq!(
            MeshFrame::select(Some(&tiny), None),
            MeshFrame::SiteLocal { placement: tiny }
        );
    }

    /// An identity (or absent) site falls through to the detector's anchor.
    #[test]
    fn an_identity_site_falls_through_to_the_detected_anchor() {
        let identity = site_at((0.0, 0.0, 0.0));
        let sub_epsilon = site_at((1e-10, -1e-10, 0.0));
        for site in [None, Some(&identity), Some(&sub_epsilon)] {
            let frame = MeshFrame::select(site.map(|m| &m[..]), Some(LARGE_FAR));
            assert_eq!(frame, MeshFrame::ModelRtc { anchor: FAR }, "site {site:?}");
            assert_eq!(frame.rtc_offset(), FAR);
            assert!(frame.needs_shift());
            assert_eq!(frame.coordinate_space(), MeshCoordinateSpace::ModelRtc);
        }
    }

    /// "Detector found nothing" and "detector found only small coordinates"
    /// both mean raw IFC, with a zero offset and no shift. A frame that said
    /// `needs_shift` with a zero offset cannot be built.
    #[test]
    fn no_site_and_no_anchor_is_raw_ifc_with_nothing_to_subtract() {
        for detected in [None, Some(RtcVerdict::Small)] {
            let frame = MeshFrame::select(None, detected);
            assert_eq!(frame, MeshFrame::RawIfc, "detected {detected:?}");
            assert_eq!(frame.rtc_offset(), (0.0, 0.0, 0.0));
            assert!(!frame.needs_shift());
            assert_eq!(frame.coordinate_space(), MeshCoordinateSpace::RawIfc);
        }
    }

    /// #4643 (gate lowered to 1 km by #4934): a `Large` verdict whose anchor
    /// is inside the gate (bbox centre for a 200 m to 1.5 km extent) is still
    /// subtracted; judging the anchor's own magnitude cast 1.5 km straight to
    /// f32. Origin-anchored `Large` has nothing to subtract; re-gating the
    /// anchor arm on `coord_is_large` fails the loop.
    #[test]
    fn a_large_verdict_with_a_sub_threshold_anchor_is_subtracted() {
        for anchor in [(-500.0, 0.0, 0.0), (850.0, 0.0, 0.0), (0.0, 0.0, 1_000.0)] {
            let frame = MeshFrame::select(None, Some(RtcVerdict::Large { anchor }));
            assert_eq!(frame, MeshFrame::ModelRtc { anchor }, "{anchor:?}");
            assert!(frame.needs_shift());
        }
        let at_origin = RtcVerdict::Large { anchor: (0.0, 0.0, 0.0) };
        assert_eq!(MeshFrame::select(None, Some(at_origin)), MeshFrame::RawIfc);
    }

    /// Why `ifc_lite_ffi::normalize_to_site_local` could be deleted: it
    /// subtracted the site translation from `raw_ifc` output whenever the site
    /// sat more than 1 km from the origin, and that input cannot be produced.
    /// Any site translation past the identity epsilon selects `SiteLocal`, so
    /// `RawIfc` with a translated site is not a state the selector can emit.
    /// Removing the `translation_is_nonidentity` filter on the site arm, or
    /// the site arm itself, fails this.
    #[test]
    fn raw_ifc_is_never_selected_beside_a_translated_site() {
        for translation in [
            (1e-8, 0.0, 0.0),
            (999.0, 0.0, 0.0),
            (1_000.5, 0.0, 0.0),
            (0.0, -1_500.0, 0.0),
            FAR,
        ] {
            let placement = site_at(translation);
            for detected in [None, Some(RtcVerdict::Small), Some(LARGE_FAR)] {
                let frame = MeshFrame::select(Some(&placement), detected);
                assert_ne!(frame, MeshFrame::RawIfc, "{translation:?} / {detected:?}");
                assert_eq!(frame.coordinate_space(), MeshCoordinateSpace::SiteLocal);
            }
        }
        assert_eq!(
            MeshFrame::select(Some(&site_at((0.0, 0.0, 0.0))), None),
            MeshFrame::RawIfc
        );
    }

    /// The rotation half of the frame (#4706). `rotate_into_frame` must be
    /// `Rᵀ` — the SAME inverse rotation `convert_mesh_to_site_local` applies
    /// to the vertices — for the site tier, and the identity for the other
    /// two, which remove no rotation. A site yawed 30 degrees maps its own
    /// +X axis, `(cos30, sin30, 0)` in world, back onto `(1, 0, 0)`.
    /// Transposing the matrix here (reading rows instead of columns) turns
    /// the yaw the wrong way and fails on the sign of the second component.
    #[test]
    fn the_site_tier_undoes_its_own_yaw_and_the_others_rotate_nothing() {
        let yawed = MeshFrame::select(Some(&site_at_yawed((500.0, 300.0, 0.0), 30.0)), None);
        let (s, c) = 30.0f64.to_radians().sin_cos();
        let back = yawed.rotate_into_frame([c, s, 0.0]);
        for (i, want) in [1.0, 0.0, 0.0].iter().enumerate() {
            assert!((back[i] - want).abs() < 1e-12, "axis {i}: {back:?}");
        }
        // A world point on the site origin lands ON the frame origin.
        let offset = yawed.rtc_offset();
        let at_origin = yawed.rotate_into_frame([
            500.0 - offset.0,
            300.0 - offset.1,
            0.0 - offset.2,
        ]);
        assert_eq!(at_origin, [0.0, 0.0, 0.0]);

        let v = [3.0, -7.0, 2.0];
        let translated_only = MeshFrame::select(Some(&site_at((500.0, 300.0, 0.0))), None);
        assert_eq!(translated_only.rotate_into_frame(v), v);
        assert_eq!(
            MeshFrame::select(None, Some(LARGE_FAR)).rotate_into_frame(v),
            v
        );
        assert_eq!(MeshFrame::RawIfc.rotate_into_frame(v), v);
    }

    /// The wire contract. The three strings are what every consumer (the TS
    /// server client, the FFI host, the Python binding) reads back, so a
    /// renamed variant or a changed `rename_all` must fail here, not in a
    /// downstream deserializer.
    #[test]
    fn wire_strings_are_the_documented_snake_case_tags() {
        for (space, tag) in [
            (MeshCoordinateSpace::SiteLocal, "\"site_local\""),
            (MeshCoordinateSpace::ModelRtc, "\"model_rtc\""),
            (MeshCoordinateSpace::RawIfc, "\"raw_ifc\""),
        ] {
            assert_eq!(serde_json::to_string(&space).unwrap(), tag);
            assert_eq!(
                serde_json::from_str::<MeshCoordinateSpace>(tag).unwrap(),
                space
            );
        }
        assert!(serde_json::from_str::<MeshCoordinateSpace>("\"SiteLocal\"").is_err());
    }
}
