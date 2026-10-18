// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Swept geometry processors - SweptDiskSolid, RevolvedAreaSolid and
//! SurfaceCurveSweptAreaSolid.

mod disk;
pub(crate) mod revolved;
mod surface_curve;

pub use disk::SweptDiskSolidProcessor;
pub(crate) use disk::SweptDiskPlan;
pub(crate) use surface_curve::SurfaceCurveSweepPlan;
pub use revolved::RevolvedAreaSolidProcessor;
pub use surface_curve::SurfaceCurveSweptAreaSolidProcessor;
