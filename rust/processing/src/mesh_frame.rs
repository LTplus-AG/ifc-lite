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

use crate::processor::translation_is_nonidentity;
use serde::{Deserialize, Serialize};

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
    /// * `detected`: what the RTC detector concluded, `None` when it found no
    ///   coordinate to judge at all, `Some((0,0,0))` when it found coordinates
    ///   and they are all inside the large-coordinate threshold, `Some(anchor)`
    ///   otherwise. The detector owns the 10 km rule
    ///   (`ifc_lite_core::limits::coord_is_large`); this function does not
    ///   re-apply it, so a detector that answers with a non-zero anchor is
    ///   honoured even when the anchor itself is inside the threshold (the
    ///   placement-bounds fallback answers with the bbox centre once any
    ///   corner is past the threshold, and that centre can be inside it).
    pub fn select(
        site_translation: Option<(f64, f64, f64)>,
        detected: Option<(f64, f64, f64)>,
    ) -> Self {
        if let Some(translation) = site_translation.filter(|t| translation_is_nonidentity(*t)) {
            return Self::SiteLocal { translation };
        }
        if let Some(anchor) = detected.filter(|a| translation_is_nonidentity(*a)) {
            return Self::ModelRtc { anchor };
        }
        Self::RawIfc
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

    /// The site tier wins whenever the site is translated at all, and it wins
    /// over a detected anchor. Deleting the site arm of `select` sends the
    /// first two cases to `ModelRtc`/`RawIfc`.
    #[test]
    fn a_translated_site_selects_site_local_over_everything() {
        let frame = MeshFrame::select(Some((500.0, 0.0, 0.0)), Some(FAR));
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
            let frame = MeshFrame::select(site, Some(FAR));
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
        for detected in [None, Some((0.0, 0.0, 0.0))] {
            let frame = MeshFrame::select(None, detected);
            assert_eq!(frame, MeshFrame::RawIfc, "detected {detected:?}");
            assert_eq!(frame.rtc_offset(), (0.0, 0.0, 0.0));
            assert!(!frame.needs_shift());
            assert_eq!(frame.coordinate_space(), MeshCoordinateSpace::RawIfc);
        }
    }

    /// The selector does not second-guess the detector with its own 10 km
    /// test: a non-zero anchor inside the threshold (the bounds fallback's
    /// answer for a model whose extent straddles the origin) is subtracted.
    /// This is where the browser resolver used to disagree with native: it
    /// re-gated the same anchor on `coord_is_large` and shipped
    /// `needsShift = false` beside a non-zero `rtcOffset`.
    #[test]
    fn a_sub_threshold_anchor_from_the_detector_is_honoured() {
        let frame = MeshFrame::select(None, Some((-5_000.0, 0.0, 0.0)));
        assert_eq!(
            frame,
            MeshFrame::ModelRtc {
                anchor: (-5_000.0, 0.0, 0.0)
            }
        );
        assert!(frame.needs_shift());
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
            for detected in [None, Some((0.0, 0.0, 0.0)), Some(FAR)] {
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
