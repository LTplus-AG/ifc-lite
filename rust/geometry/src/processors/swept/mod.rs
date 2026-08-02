// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Swept geometry processors - SweptDiskSolid, RevolvedAreaSolid and
//! SurfaceCurveSweptAreaSolid.

mod disk;
mod revolved;
mod surface_curve;

pub use disk::SweptDiskSolidProcessor;
pub use revolved::RevolvedAreaSolidProcessor;
pub use surface_curve::SurfaceCurveSweptAreaSolidProcessor;
