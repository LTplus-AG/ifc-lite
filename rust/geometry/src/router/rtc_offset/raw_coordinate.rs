// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Detection of large coordinates stored directly in representation items.

use super::GeometryRouter;
use crate::coord_is_large;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

impl GeometryRouter {
    fn raw_coordinate_is_large(&self, point: (f64, f64, f64)) -> bool {
        let scale = self.unit_scale;
        coord_is_large((point.0 * scale, point.1 * scale, point.2 * scale))
    }

    pub(in crate::router) fn representation_item_uses_raw_large_coordinates(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> bool {
        let first_vertex = match item.ifc_type {
            IfcType::IfcFacetedBrep | IfcType::IfcFacetedBrepWithVoids => {
                self.brep_first_vertex(item, decoder)
            }
            IfcType::IfcFaceSurface | IfcType::IfcAdvancedFace => {
                self.face_first_vertex(item, decoder)
            }
            IfcType::IfcTriangulatedFaceSet
            | IfcType::IfcTriangulatedIrregularNetwork
            | IfcType::IfcPolygonalFaceSet => self.tessellated_first_vertex(item, decoder),
            IfcType::IfcFaceBasedSurfaceModel | IfcType::IfcShellBasedSurfaceModel => {
                let Some(shells_attr) = item.get(0) else {
                    return false;
                };
                let Some(shells) = shells_attr.as_list() else {
                    return false;
                };
                let Some(shell_ref) = shells.first() else {
                    return false;
                };
                let Some(shell_id) = shell_ref.as_entity_ref() else {
                    return false;
                };
                match decoder.decode_by_id(shell_id) {
                    Ok(shell) => self.shell_first_vertex(&shell, decoder),
                    Err(_) => None,
                }
            }
            _ => None,
        };

        first_vertex
            .map(|point| self.raw_coordinate_is_large(point))
            .unwrap_or(false)
    }
}
