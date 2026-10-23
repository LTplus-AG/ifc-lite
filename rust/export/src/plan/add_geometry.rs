// SPDX-License-Identifier: MPL-2.0
//! Geometry for [`super::Disposition::Add`]: an `IfcProductDefinitionShape`
//! from an extrusion or a triangle mesh, with an optional surface colour.
//! Meshes, colours, contexts and the shape around an item are built by
//! [`super::tessellation`], shared with the geometry patch; only the
//! extrusion is Add's own, its profile in [`super::add_profile`].

use super::add_profile::profile;
use super::add_types::{Extrusion, Representation};
use super::placement::fmt;
use super::tessellation::{body_shape, mesh_item, Emit};
use super::types::SurfaceColour;

/// Build the product's shape, returning the `IfcProductDefinitionShape` id,
/// or `None` for [`Representation::None`].
pub(crate) fn product_shape(
    emit: &mut Emit,
    context: u32,
    rep: &Representation,
    colour: Option<&SurfaceColour>,
) -> Result<Option<u32>, String> {
    let (items, rep_type) = match rep {
        Representation::None => return Ok(None),
        Representation::Mesh(m) => mesh_item(emit, m).map(|(item, rep_type)| (vec![item], rep_type))?,
        Representation::Extrusion(_) | Representation::Extrusions(_) => {
            let solids = rep.extrusions().iter().map(|e| extruded_solid(emit, e)).collect::<Result<_, _>>()?;
            (solids, "SweptSolid")
        }
    };
    body_shape(emit, context, &items, rep_type, colour).map(Some)
}

fn extruded_solid(emit: &mut Emit, e: &Extrusion) -> Result<u32, String> {
    let profile = profile(emit, e)?;
    let position = emit.identity_placement()?;
    let [dx, dy, dz] = e.direction;
    let direction = emit.record("IFCDIRECTION", &[("DirectionRatios", format!("({},{},{})", fmt(dx), fmt(dy), fmt(dz)))])?;
    emit.record(
        "IFCEXTRUDEDAREASOLID",
        &[
            ("SweptArea", format!("#{profile}")),
            ("Position", format!("#{position}")),
            ("ExtrudedDirection", format!("#{direction}")),
            ("Depth", fmt(e.depth)),
        ],
    )
}

#[cfg(test)]
#[path = "add_geometry_tests.rs"]
mod tests;
