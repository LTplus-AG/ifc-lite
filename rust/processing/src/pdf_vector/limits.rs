// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Named numeric limits of the PDF vector pipeline (F2c, #7774). Values are
//! the literals they replaced. Units are stated per constant: PDF user-space
//! units (1/72 inch at `UserUnit` 1), calibrated model metres, or ulps.

/// Largest absolute page-space coordinate, width or phase accepted from the
/// adapter. Unit: PDF user-space units. Far above any real page (viewers cap
/// a page at 14400 units) and low enough that the products validated later
/// stay finite.
pub(super) const PAGE_COORD_LIMIT: f64 = 1e9;

/// Largest absolute matrix entry (CTM, image placement, model-from-PDF).
/// Unit: dimensionless scale or user units for translations. Larger than
/// [`PAGE_COORD_LIMIT`] because a matrix may scale a unit-square image up to
/// the page.
pub(super) const MATRIX_ENTRY_LIMIT: f64 = 1e12;

/// Largest absolute coordinate after the model-from-PDF transform, accepted
/// by curve flattening and fill-path construction. Unit: model metres.
pub(super) const MODEL_COORD_LIMIT_M: f64 = 1e8;

/// Smallest and largest curve tolerance a page may request. Unit: model
/// metres (1 nm to 1 m).
pub(super) const MIN_TOLERANCE_M: f64 = 1e-9;
pub(super) const MAX_TOLERANCE_M: f64 = 1.;

/// Largest `UserUnit` a page may declare (PDF 1.6 caps it at 75000).
/// Unit: multiples of 1/72 inch.
pub(super) const MAX_USER_UNIT: f64 = 75000.;

/// Rounding headroom, in multiples of `f64::EPSILON * magnitude`, kept above a
/// curve tolerance before the flattening or fill test is trusted. Unit: ulps.
/// A tolerance under this much roundoff of the largest coordinate cannot be
/// verified and is refused.
pub(super) const COORD_ROUNDOFF_ULPS: f64 = 128.;
