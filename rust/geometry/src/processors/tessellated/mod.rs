// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tessellated geometry processors - pre-tessellated/polygon meshes.
//!
//! Handles IfcTriangulatedFaceSet (explicit triangle meshes) and
//! IfcPolygonalFaceSet (polygon meshes requiring triangulation).

mod mesh_build;
mod polygonal;
mod triangulate;
mod triangulated;

pub use polygonal::PolygonalFaceSetProcessor;
pub use triangulated::TriangulatedFaceSetProcessor;
