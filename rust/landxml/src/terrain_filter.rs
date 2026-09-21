/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Bounded domain classification for generated constrained terrain faces.

use super::terrain_topology::{point_in_ring, Vertex};
use ifc_lite_geometry::TerrainCdtError;

pub(super) fn point_is_in_permitted_region(
    point: [f64; 2],
    outer: &[Vec<usize>],
    holes: &[Vec<usize>],
    vertices: &[Vertex],
    progress: &mut dyn FnMut() -> Result<(), TerrainCdtError>,
) -> Result<bool, TerrainCdtError> {
    let mut in_outer = false;
    for ring in outer {
        in_outer |= point_in_ring(point, ring, vertices, progress)?;
    }
    if !in_outer {
        return Ok(false);
    }
    for ring in holes {
        if point_in_ring(point, ring, vertices, progress)? {
            return Ok(false);
        }
    }
    Ok(true)
}
