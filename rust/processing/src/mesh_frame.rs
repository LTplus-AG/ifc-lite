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

/// The arithmetic behind [`MeshFrame::to_world`], for a caller that holds
/// the frame as its parts: `R · p + rtc`, all f64.
///
/// `R` is the site placement's rotation block, applied under exactly the
/// [`rotation_is_identity`] condition the bake removed it under
/// (`processor::site_local`), so a restore can never put back a rotation
/// that was not taken out. `site_rotation` must be `None` outside the
/// `site_local` tier ([`MeshFrame::site_placement`] says which).
#[inline]
pub(crate) fn frame_point_to_world(p: [f64; 3], rtc: [f64; 3], site_rotation: Option<&[f64]>) -> [f64; 3] {
    restoring_rotation(site_rotation).map_or_else(
        || [p[0] + rtc[0], p[1] + rtc[1], p[2] + rtc[2]],
        |r| rotate_and_translate(r, p, rtc),
    )
}

/// The rotation block a restore applies, or `None` when the bake removed
/// none. Decided once per call by a caller that maps many points, so the
/// per-vertex path is [`rotate_and_translate`] with no re-check.
#[inline]
pub(crate) fn restoring_rotation(site_rotation: Option<&[f64]>) -> Option<&[f64]> {
    site_rotation.filter(|r| r.len() >= 16 && !rotation_is_identity(r))
}

/// `R · p + rtc` for a rotation already vetted by [`restoring_rotation`].
#[inline]
pub(crate) fn rotate_and_translate(r: &[f64], p: [f64; 3], rtc: [f64; 3]) -> [f64; 3] {
    [
        r[0] * p[0] + r[4] * p[1] + r[8] * p[2] + rtc[0],
        r[1] * p[0] + r[5] * p[1] + r[9] * p[2] + rtc[1],
        r[2] * p[0] + r[6] * p[1] + r[10] * p[2] + rtc[2],
    ]
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

    /// The frame whose [`MeshFrame::world_matrix`] is `world` (column-major
    /// 4x4, IFC Z-up metres): the inverse a consumer that was HANDED a restore
    /// matrix (the viewer's meshes, which carry no `ProcessingResult`) needs to
    /// get a frame back, so every writer restores through the one
    /// [`MeshFrame::world_matrix`] / [`MeshFrame::to_world`] arithmetic
    /// (#7734). A non-identity rotation block is the site tier, a bare
    /// translation is a model anchor, and neither is raw.
    ///
    /// `world` must hold at least 16 elements; the caller vets finiteness.
    pub fn from_world_matrix(world: &[f64]) -> Self {
        debug_assert!(world.len() >= 16);
        if world.len() < 16 {
            return Self::RawIfc;
        }
        let anchor = (world[12], world[13], world[14]);
        if restoring_rotation(Some(world)).is_some() {
            let mut placement = [0.0; 16];
            placement.copy_from_slice(&world[..16]);
            Self::SiteLocal { placement }
        } else if translation_is_nonidentity(anchor) {
            Self::ModelRtc { anchor }
        } else {
            Self::RawIfc
        }
    }

    /// The frame described by its parts: the wire tag, the subtracted
    /// translation and the site placement (read only in the site tier), the
    /// way the glTF assembler carries them. Only [`MeshFrame::world_matrix`]
    /// of the result is meaningful: a `SiteLocal` tag with no placement, or
    /// the other tiers, restore a translation alone.
    pub fn from_parts(space: MeshCoordinateSpace, rtc: [f64; 3], site: Option<&[f64]>) -> Self {
        let site = site.filter(|m| m.len() >= 16 && space == MeshCoordinateSpace::SiteLocal);
        let mut world = [0.0; 16];
        match site {
            Some(m) => world.copy_from_slice(&m[..16]),
            None => {
                for i in 0..4 {
                    world[i * 5] = 1.0;
                }
            }
        }
        world[12..15].copy_from_slice(&rtc);
        Self::from_world_matrix(&world)
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

    /// The site placement whose rotation this frame removed: `Some` only in
    /// the [`MeshFrame::SiteLocal`] tier (column-major 4x4, metres).
    ///
    /// This is the `site_rotation` argument
    /// [`crate::build_geometry_data_export`] takes. Callers read it here
    /// instead of re-deriving "only the site tier removed a rotation" from
    /// `ProcessingResult::mesh_coordinate_space` themselves.
    #[inline]
    pub fn site_placement(self) -> Option<[f64; 16]> {
        match self {
            Self::SiteLocal { placement } => Some(placement),
            _ => None,
        }
    }

    /// A baked DIRECTION (a normal, an axis) back in IFC world axes: `R · v`.
    ///
    /// The inverse of [`MeshFrame::rotate_into_frame`], and the identity
    /// (returning `v` untouched) wherever that is.
    #[inline]
    pub fn rotate_out_of_frame(self, v: [f64; 3]) -> [f64; 3] {
        match self.site_placement() {
            Some(placement) if !rotation_is_identity(&placement) => {
                frame_point_to_world(v, [0.0; 3], Some(&placement))
            }
            _ => v,
        }
    }

    /// A baked POINT back in IFC world (Z-up, metres), in f64: `R · p + t`.
    ///
    /// The inverse of [`MeshFrame::rotate_into_frame`]`(world − rtc_offset)`,
    /// and the ONE way an exporter or overlay that reads baked
    /// [`crate::MeshData`] gets back to world coordinates (#7684). `p` is the
    /// baked point as the pipeline stores it, `origin + position`, with the
    /// f32 position widened BEFORE the add. Never add `rtc_offset` in f32:
    /// at 2,600 km the f32 step is 0.25 m. [`MeshFrame::RawIfc`] returns `p`
    /// untouched.
    #[inline]
    pub fn to_world(self, p: [f64; 3]) -> [f64; 3] {
        if !self.needs_shift() {
            return p;
        }
        let (x, y, z) = self.rtc_offset();
        frame_point_to_world(p, [x, y, z], self.site_placement().as_ref().map(|m| &m[..]))
    }

    /// [`MeshFrame::to_world`] with the rotation check made once, for a writer
    /// that maps every vertex of a model. Bit-identical to `to_world`.
    pub fn world_mapper(self) -> impl Fn([f64; 3]) -> [f64; 3] + Copy {
        let placement = self.site_placement();
        let rotation = restoring_rotation(placement.as_ref().map(|m| &m[..])).map(|_| placement.unwrap());
        let (x, y, z) = self.rtc_offset();
        let shift = self.needs_shift();
        move |p| match (&rotation, shift) {
            (Some(r), _) => rotate_and_translate(r, p, [x, y, z]),
            (None, true) => [p[0] + x, p[1] + y, p[2] + z],
            (None, false) => p,
        }
    }

    /// [`MeshFrame::rotate_out_of_frame`] with the rotation check made once.
    /// Bit-identical to it.
    pub fn direction_mapper(self) -> impl Fn([f64; 3]) -> [f64; 3] + Copy {
        let placement = self.site_placement();
        let rotation = restoring_rotation(placement.as_ref().map(|m| &m[..])).map(|_| placement.unwrap());
        move |v| match &rotation {
            Some(r) => rotate_and_translate(r, v, [0.0; 3]),
            None => v,
        }
    }

    /// [`MeshFrame::to_world`] as a column-major 4x4, for a writer that
    /// authors the restore once on a root (USD `/World`, the BOS metadata)
    /// rather than per vertex. The identity for [`MeshFrame::RawIfc`].
    pub fn world_matrix(self) -> [f64; 16] {
        let mut m = [0.0; 16];
        for (c, axis) in [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]].into_iter().enumerate() {
            m[c * 4..c * 4 + 3].copy_from_slice(&self.rotate_out_of_frame(axis));
        }
        let (x, y, z) = self.rtc_offset();
        m[12..16].copy_from_slice(&[x, y, z, 1.0]);
        m
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

#[cfg(test)]
#[path = "mesh_frame_tests.rs"]
mod tests;
