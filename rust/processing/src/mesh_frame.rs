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
/// while the geometry itself carries large world coordinates. The site-local
/// rotation test (`processor/site_local.rs`) uses the same epsilon.
pub(crate) const PLACEMENT_IDENTITY_EPSILON: f64 = 1e-9;

#[inline]
fn translation_is_nonidentity(t: (f64, f64, f64)) -> bool {
    t.0.abs() > PLACEMENT_IDENTITY_EPSILON
        || t.1.abs() > PLACEMENT_IDENTITY_EPSILON
        || t.2.abs() > PLACEMENT_IDENTITY_EPSILON
}

/// The frame a pipeline meshes into, with the translation it subtracts.
///
/// Both pipelines build it with [`MeshFrame::select`]. The offset, the
/// needs-shift bit and the wire tag are read off the one value, so they
/// cannot disagree with each other.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MeshFrame {
    /// `IfcSite` has a non-identity translation: subtract it. Vertices land
    /// relative to the site origin, small floats in a relatable frame. The
    /// native pipeline also removes the site rotation
    /// (`convert_mesh_to_site_local`) for this tier.
    SiteLocal { translation: (f64, f64, f64) },
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
    /// * `site_translation`: the `IfcSite` placement's translation (metres),
    ///   `None` when the pipeline has no site tier (the browser pre-pass and
    ///   the appearance authoring path mesh in world axes and pass `None`
    ///   deliberately: see `stream_meta::resolve_stream_meta`).
    /// * `detected`: the RTC detector's verdict (see
    ///   `GeometryRouter::detect_rtc_offset_with_fallback`). A `Large` verdict
    ///   is honoured whatever its anchor's own magnitude: the placement-bounds
    ///   fallback decides on the bbox corners and anchors on the centre, which
    ///   can be inside 10 km while the coordinates are not. Only an anchor at
    ///   the origin (nothing to subtract) falls through to `RawIfc`.
    pub fn select(
        site_translation: Option<(f64, f64, f64)>,
        detected: Option<RtcVerdict>,
    ) -> Self {
        if let Some(translation) = site_translation.filter(|t| translation_is_nonidentity(*t)) {
            return Self::SiteLocal { translation };
        }
        match detected {
            Some(RtcVerdict::Large { anchor }) if translation_is_nonidentity(anchor) => {
                Self::ModelRtc { anchor }
            }
            _ => Self::RawIfc,
        }
    }

    /// The frame for a consumer that parses the file itself and has no job
    /// list: the symbolic, grid and alignment overlays (#4665). It runs the
    /// browser pre-pass selection (the bounds-fallback ladder, no site tier)
    /// with every geometry entity of the file as the jobs. The pre-passes
    /// sample a narrower job window, so a model with widely spread elements
    /// can still get a different median anchor (#4611), and the native site
    /// tier is not applied (#4706).
    pub fn for_overlay(router: &GeometryRouter, content: &[u8], decoder: &mut EntityDecoder) -> Self {
        Self::select(None, router.detect_rtc_offset_for_file(content, decoder))
    }

    /// The translation the router subtracts from every world vertex before
    /// the f32 cast; `(0,0,0)` for [`MeshFrame::RawIfc`].
    #[inline]
    pub fn rtc_offset(self) -> (f64, f64, f64) {
        match self {
            Self::SiteLocal { translation } => translation,
            Self::ModelRtc { anchor } => anchor,
            Self::RawIfc => (0.0, 0.0, 0.0),
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

    /// The site tier wins whenever the site is translated at all, and it wins
    /// over a detected anchor. Deleting the site arm of `select` sends the
    /// first two cases to `ModelRtc`/`RawIfc`.
    #[test]
    fn a_translated_site_selects_site_local_over_everything() {
        let frame = MeshFrame::select(Some((500.0, 0.0, 0.0)), Some(LARGE_FAR));
        assert_eq!(
            frame,
            MeshFrame::SiteLocal {
                translation: (500.0, 0.0, 0.0)
            }
        );
        assert_eq!(frame.rtc_offset(), (500.0, 0.0, 0.0));
        assert!(frame.needs_shift());
        assert_eq!(frame.coordinate_space(), MeshCoordinateSpace::SiteLocal);
        assert_eq!(
            MeshFrame::select(Some((0.0, 0.0, 1e-6)), None),
            MeshFrame::SiteLocal {
                translation: (0.0, 0.0, 1e-6)
            }
        );
    }

    /// An identity (or absent) site falls through to the detector's anchor.
    #[test]
    fn an_identity_site_falls_through_to_the_detected_anchor() {
        for site in [None, Some((0.0, 0.0, 0.0)), Some((1e-10, -1e-10, 0.0))] {
            let frame = MeshFrame::select(site, Some(LARGE_FAR));
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

    /// #4643: a `Large` verdict whose anchor is inside 10 km (the bounds
    /// fallback's bbox centre for a 2 to 15 km extent) is still subtracted;
    /// judging the anchor's own magnitude cast 15 km coordinates straight to
    /// f32. A `Large` verdict anchored at the origin has nothing to subtract.
    /// Re-gating the anchor arm on `coord_is_large` fails the loop.
    #[test]
    fn a_large_verdict_with_a_sub_threshold_anchor_is_subtracted() {
        for anchor in [(-5_000.0, 0.0, 0.0), (8_500.0, 0.0, 0.0), (0.0, 0.0, 10_000.0)] {
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
            for detected in [None, Some(RtcVerdict::Small), Some(LARGE_FAR)] {
                let frame = MeshFrame::select(Some(translation), detected);
                assert_ne!(frame, MeshFrame::RawIfc, "{translation:?} / {detected:?}");
                assert_eq!(frame.coordinate_space(), MeshCoordinateSpace::SiteLocal);
            }
        }
        assert_eq!(MeshFrame::select(Some((0.0, 0.0, 0.0)), None), MeshFrame::RawIfc);
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
