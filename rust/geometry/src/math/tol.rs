// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The tolerance catalogue (F2c, #7774, charter #7670): every named numeric
//! tolerance the geometry stack shares, with the unit it is measured in and
//! why it has that value.
//!
//! # Contract
//!
//! - **Values here are the values the code shipped with.** F2c is a refactor:
//!   each constant is the literal it replaced, bit for bit. Where two sites
//!   used different values for what looks like one concept, there are two
//!   constants (see "Open policy questions" below), not a silent unification.
//! - **Every constant states its unit.** The unit tags are:
//!   - *model units*: the IFC file's length unit (mm in a mm-authored file,
//!     m in a metre file). A constant in model units means a different
//!     physical distance per file. These are the scale-dependent tolerances
//!     C3 reviews.
//!   - *metres*: a physical distance, applied to data already scaled to
//!     metres.
//!   - *dimensionless*: a sine, cosine, ratio or parameter fraction.
//!   - *radians*, *relative* (a fraction of a magnitude), *ulps* (a multiple
//!     of f32 or f64 rounding error).
//!   - *length^n*: a power of model units (squared distance, determinant).
//! - **Thresholds are still arguments in [`super::v3`] and [`super::mat4`].**
//!   This module supplies the names callers pass.
//!
//! # Open policy questions (for C3, no behaviour change here)
//!
//! - [`POINT_COINCIDENT_EPS`] (1e-9) and [`CURVE_JUNCTION_EPS`] (1e-6) both
//!   answer "are these two profile or curve points the same point", in model
//!   units. A 1e-9 model-unit gap is 1 nm in a metre file and 1 pm in a mm
//!   file, a few ulps of f64 at 1 km coordinates (about 0.2 pm), so
//!   large-coordinate files can miss coincidences. C3 decides whether
//!   these become metres (scaled by `length_unit_scale`) or relative to the
//!   coordinate magnitude.
//! - [`PARAM_END_MARGIN`] is an absolute curve-parameter clamp, so a span
//!   narrower than 1e-6 collapses to its start. C3 decides whether it
//!   becomes relative to `t_max - t_min`.
//! - [`PARTIAL_VOID_EPS`] and [`MIN_PROFILE_DIMENSION`] are 1e-3 *model
//!   units* but are written (and were commented) as 1 mm: a micrometre in a
//!   mm file. C3 decides whether they take `length_unit_scale`.
//! - The `clash` crate keeps its own copies of [`F32_ULP_SCALE`] and
//!   [`MIN_SIN_THETA`] (D21: clash does not depend on geometry). A test in
//!   `tol_tests` reads clash's source and fails if either value moves.
//! - Deliberately not here: tolerances local to one algorithm that are already
//!   named and documented where they apply (`plane_eps`, `near_band`, the
//!   boolean kernel's exact-arithmetic thresholds). Moving them would
//!   separate a value from the proof that justifies it.

// ---------------------------------------------------------------------
// Linear algebra
// ---------------------------------------------------------------------

/// A 3x3 affine determinant below this is singular. Unit: dimensionless
/// (placement chains carry the unit scale in the translation only, so the
/// linear block is a rotation times an `IfcCartesianTransformationOperator`
/// scale). 1e-18 is a uniform operator scale of 1e-6 per axis; the corpus
/// minimum is 1e-3 (det 1e-9). D22: one value for glTF, the demesher and
/// every `affine_inverse`.
pub const SINGULAR_DET_EPS: f64 = 1e-18;

/// `normalize(v, min_len)` with this threshold refuses only an exactly zero
/// (or non-finite) vector. Unit: the input vector's own units. Used where the
/// caller has already established the vector is a difference of distinct
/// points and wants every non-zero direction.
pub const NORMALIZE_NONZERO: f64 = 0.0;

/// Smallest vector treated as a direction. Unit: the input's units (a unit
/// direction, a point difference in model units, or a cross product of two
/// unit axes). 1e-12 sits about four orders above the f64 rounding error of
/// a unit-scale cross product, so a refused vector really is degenerate.
pub const DIRECTION_MIN_LEN: f64 = 1e-12;

/// Smallest placement axis (`IfcAxis2Placement` Axis/RefDirection after
/// projection) accepted as a direction. Unit: dimensionless (axes are unit
/// vectors, possibly authored with a few decimals). Coarser than
/// [`DIRECTION_MIN_LEN`] because authored axes carry authoring noise.
pub const AXIS_MIN_LEN: f64 = 1e-9;

/// Smallest vector accepted as a facet or edge normal: the cross product of
/// two polygon edges, or a 2D edge or radial vector in profile units. Unit:
/// model units (length^2 for the edge cross product).
pub const EDGE_CROSS_MIN_LEN: f64 = 1e-10;

/// Smallest accumulated direction accepted as a unit vector: an axis left
/// after projecting it onto a plane, or a vertex normal summed from adjacent
/// face normals. Unit: dimensionless (sums of unit vectors). Coarse on
/// purpose: a near-cancelling sum has a direction that is mostly rounding
/// noise.
pub const COARSE_DIRECTION_MIN_LEN: f64 = 1e-6;

/// `|a - b|` below this in every element means "same matrix entry" when
/// testing a placement for identity. Unit: dimensionless for rotation
/// entries, model units for the translation column.
pub const IDENTITY_EPS: f64 = 1e-9;

/// The strict variant used for representation-map origins, where an
/// identity result drops the transform entirely. Unit: as [`IDENTITY_EPS`].
pub const IDENTITY_EPS_STRICT: f64 = 1e-12;

/// An `IfcAxis2Placement2D` profile placement whose location components and
/// direction deviate from the identity by less than this is skipped, and a
/// direction-ratio vector shorter than this falls back to +X. Unit: model
/// units for the location, dimensionless for the direction.
pub const PLACEMENT_2D_EPS: f64 = 1e-10;

/// Two directions whose cross product is shorter than this are parallel.
/// Unit: dimensionless for the unit directions of `structural_edge` (the sine
/// of the angle); length^2 for the unnormalised 2D edge vectors of
/// `geom2d::line_intersection`, whose determinant is compared directly.
pub const PARALLEL_EPS: f64 = 1e-9;

/// Two unit axes are treated as orthogonal when `|dot|` is at most this, and
/// as the same axis when `dot > 1 - this`. Unit: dimensionless (a cosine,
/// 1e-4 is about 0.6 degrees).
pub const ORTHO_EPS: f64 = 1.0e-4;

/// Two edge vectors with `sin(theta)` below this are collinear, so their
/// cross product defines no plane. Unit: dimensionless (a sine, 1e-3 is
/// about 0.06 degrees). Scale-free, unlike an absolute cross-product floor.
pub const MIN_SIN_THETA: f64 = 1.0e-3;

// ---------------------------------------------------------------------
// f32 rounding
// ---------------------------------------------------------------------

/// Half a unit in the last place of an f32, relative: `2^-24`. Unit:
/// relative (ulps). The worst-case error of rounding one coordinate to f32.
pub const F32_HALF_ULP_REL: f64 = 1.0 / 16_777_216.0;

/// One f32 ULP at magnitude 1, relative: `2^-23` (`f32::EPSILON`). Unit:
/// relative (ulps).
pub const F32_ULP_REL: f64 = 1.0 / 8_388_608.0;

/// The worst-case f32 ULP for a coordinate of magnitude 2 or more: `2^-22`
/// (the true ULP in `[2, 4)`, growing for larger magnitudes). Unit: relative
/// (ulps). The multiplier of an `extent` or `|v|` that gives an absolute
/// noise tolerance in the same units as that magnitude, for quantities
/// derived from f32-stored vertices.
pub const F32_ULP_SCALE: f64 = 1.0 / 4_194_304.0;

/// Eight f32 ULPs, relative: `2^-20`. Unit: relative (ulps). The budget for
/// a world-space position recomposed through a handful of float ops
/// (`instancing::verify`), where drift beyond the stored precision is a few
/// ULPs.
pub const F32_ULP_8: f64 = F32_ULP_REL * 8.0;

// ---------------------------------------------------------------------
// Curves and profiles (all in model units unless stated)
// ---------------------------------------------------------------------

/// Two consecutive profile or curve points closer than this (per axis, or in
/// norm) are the same point and the second is dropped. Unit: model units.
pub const POINT_COINCIDENT_EPS: f64 = 1e-9;

/// A radius, segment or span at or below this is zero length. Unit: model
/// units.
pub const LENGTH_ZERO_EPS: f64 = 1e-9;

/// First and last point of a swept curve closer than this per axis close the
/// loop. Unit: model units. Coarser than [`POINT_COINCIDENT_EPS`] because the
/// two ends come from independently evaluated parametrisations.
pub const CURVE_JUNCTION_EPS: f64 = 1e-6;

/// Two consecutive composite-curve segment end points closer than this (per
/// axis) are the same joint and the repeat is dropped. Unit: model units.
pub const SEAM_EPS: f64 = 1e-9;

/// A curve parameter within this of a span end is at that end. Unit:
/// dimensionless (a fraction of the span, or radians on a circle).
pub const PARAM_EPS: f64 = 1e-9;

/// Squared distance below which two sampled curve points coincide
/// (1e-6 model units). Unit: length^2.
pub const SAMPLE_COINCIDENT_SQ: f64 = 1e-12;

/// Squared distance below which a sampled curve's last point already is its
/// end (1e-9 model units). Unit: length^2.
pub const SAMPLE_END_COINCIDENT_SQ: f64 = 1e-18;

/// A trim span of at most this is empty and falls back to the full domain.
/// Unit: curve parameter units.
pub const TRIM_SPAN_MIN: f64 = 1e-12;

/// The last sampled parameter stays this far inside the span end so the
/// evaluator never reads on the closing knot. Unit: absolute curve parameter
/// units (not relative to the span; see the open policy questions).
pub const PARAM_END_MARGIN: f64 = 1e-6;

/// A B-spline basis value or knot-span denominator below this is zero. Unit:
/// dimensionless.
pub const BASIS_EPS: f64 = 1e-10;

/// Angles closer than this are the same angle when deduplicating arc
/// breakpoints, and a span within this of 0 or tau is degenerate or full.
/// Unit: radians.
pub const ANGLE_EPS: f64 = 1e-6;

/// Arc end points closer than this fraction of `max(radius, 1)` are
/// coincident, so the arc is a full circle. Unit: relative.
pub const ARC_COINCIDENT_REL: f64 = 1e-6;

/// A counter-clockwise arc sweep below this is zero (and promoted to a full
/// circle when the end points coincide). Unit: radians.
pub const ARC_SWEEP_MIN: f64 = 1e-9;

/// Absolute chord deviation budget when tessellating an arc: 0.5 mm. Unit:
/// metres. It is a physical budget, so it is only correct on data already
/// in metres.
pub const CHORD_TOL_M: f64 = 5.0e-4;

/// A void extending to within this of an extrusion's start or end face is a
/// through-void. Unit: model units, written as 1 mm (see the open policy
/// questions).
pub const PARTIAL_VOID_EPS: f64 = 0.001;

/// Smallest profile width or height that extrudes. Unit: model units,
/// commented as 1 mm (see the open policy questions).
pub const MIN_PROFILE_DIMENSION: f64 = 0.001;

/// An extrusion direction component below this is zero (the extrusion is
/// along local Z). Unit: dimensionless.
pub const EXTRUSION_AXIS_COMPONENT_EPS: f64 = 0.001;

// ---------------------------------------------------------------------
// Retained numerical edge (already scaled to metres; not raw IFC units)
// ---------------------------------------------------------------------

/// Smallest admitted retained line length, circular/disk radius or sweep
/// thickness normal to the profile. Unit: metres. This is the existing local
/// numerical-domain floor; naming it does not change SDK admission.
pub const RETAINED_MIN_LENGTH_M: f64 = 1e-12;

/// Maximum component mismatch between opposite parameterized rectangle edges.
/// Unit: metres. Kept separate from minimum feature size: this checks closure
/// of the derived rectangle used to select the qualified numerical route.
pub const RETAINED_RECTANGLE_EDGE_EPS_M: f64 = 1e-12;

/// Absolute join distance for consecutive derived retained boundary endpoints.
/// Unit: metres. Independent trigonometric evaluation may introduce roundoff.
pub const RETAINED_BOUNDARY_JOIN_EPS_M: f64 = 1e-10;

/// Absolute floor in twice-area checks and their source/derived agreement
/// budget. Unit: metres squared (on twice signed area, not ordinary area).
/// Rejects vanishing boundaries/net regions and bounds absolute area roundoff.
pub const RETAINED_TWICE_AREA_EPS_M2: f64 = 1e-18;

/// Relative source/derived twice-area agreement budget. Unit: relative.
/// Added to the separate absolute twice-area floor, preserving the original sum.
pub const RETAINED_TWICE_AREA_REL: f64 = 1e-9;

/// Circular-interval endpoint margin at zero and one full turn. Unit: radians.
/// Shared by retained region classification and exact conic disk conversion;
/// preserves their existing strict/open versus full-circle comparisons.
pub const RETAINED_ARC_INTERVAL_EPS_RAD: f64 = 1e-12;

/// Circular X-axis length deviation from unity. Unit: dimensionless.
/// Rejects a non-unit basis before writing a numerical circular recipe.
pub const RETAINED_CIRCLE_BASIS_EPS: f64 = 1e-12;

/// Dot-product deviation of source placement axes from an orthonormal frame.
/// Unit: dimensionless. Retained evaluation accepts rigid placements only;
/// this is distinct from the tighter circular-axis length admission above.
pub const RETAINED_RIGID_DOT_EPS: f64 = 1e-10;
