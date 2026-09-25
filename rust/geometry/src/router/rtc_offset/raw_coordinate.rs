// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Precision guard for early f64 RTC rebasing of representation items.

use super::GeometryRouter;
use crate::coord_is_large;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

impl GeometryRouter {
    pub(in crate::router) fn representation_item_first_vertex_meters(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(f64, f64, f64)> {
        let point = match item.ifc_type {
            IfcType::IfcFacetedBrep
            | IfcType::IfcFacetedBrepWithVoids
            | IfcType::IfcAdvancedBrep
            | IfcType::IfcAdvancedBrepWithVoids => self.brep_first_vertex(item, decoder),
            IfcType::IfcFaceSurface | IfcType::IfcAdvancedFace => {
                self.face_first_vertex(item, decoder)
            }
            IfcType::IfcTriangulatedFaceSet
            | IfcType::IfcTriangulatedIrregularNetwork
            | IfcType::IfcPolygonalFaceSet => self.tessellated_first_vertex(item, decoder),
            // First control point: a B-spline surface lies in its net's hull,
            // so the net's magnitude is the surface's (#5698). Rebase probe
            // only; RTC detection deliberately abstains on these (#1526).
            IfcType::IfcBSplineSurfaceWithKnots
            | IfcType::IfcRationalBSplineSurfaceWithKnots => {
                let rows = item.get(2)?.as_list()?;
                let point_id = rows.first()?.as_list()?.first()?.as_entity_ref()?;
                decoder.get_cartesian_point_fast(point_id)
            }
            IfcType::IfcFaceBasedSurfaceModel | IfcType::IfcShellBasedSurfaceModel => {
                let shells = item.get(0)?.as_list()?;
                let shell_id = shells.first()?.as_entity_ref()?;
                let shell = decoder.decode_by_id(shell_id).ok()?;
                self.shell_first_vertex(&shell, decoder)
            }
            _ => None,
        }?;
        Some((
            point.0 * self.unit_scale,
            point.1 * self.unit_scale,
            point.2 * self.unit_scale,
        ))
    }

    /// Check the proposed offset in the SAME frame as the item's coordinates.
    /// Element-aware callers pull world RTC through their inverse rotation first.
    pub(in crate::router) fn representation_item_benefits_from_rtc(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        offset_meters: (f64, f64, f64),
    ) -> bool {
        let Some(point) = self.representation_item_first_vertex_meters(item, decoder) else {
            return false;
        };
        let magnitude = |p: (f64, f64, f64)| p.0.abs().max(p.1.abs()).max(p.2.abs());
        let shifted = (
            point.0 - offset_meters.0,
            point.1 - offset_meters.1,
            point.2 - offset_meters.2,
        );
        // #5684: vertices several km from their object origin can still be
        // local to a site millions of metres away. Subtracting the site's RTC
        // here would INCREASE their f32 magnitude and collapse thin geometry.
        // Keep such meshes in their object frame until final world placement.
        coord_is_large(point) && magnitude(shifted) < magnitude(point)
    }
}
