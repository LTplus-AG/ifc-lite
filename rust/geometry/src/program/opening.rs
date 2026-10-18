// SPDX-License-Identifier: MPL-2.0
//! Lenient opening policies on the same reached representation/item program.
use super::{EntryPolicy, ProductProgram, ReachedItem};
use crate::router::voids::geom::{extract_rotation_columns, rotate_and_normalize};
use crate::{GeometryRouter, Mesh, Point3, Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;

pub(crate) type OpeningBounds = Vec<(Point3<f64>, Point3<f64>, Option<Vector3<f64>>)>;
pub(crate) struct OpeningProgram {
    items: ProductProgram,
    placement: Matrix4<f64>,
}
impl OpeningProgram {
    pub(crate) fn admit(
        element: &DecodedEntity,
        policy: EntryPolicy,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>,
    ) -> Result<Option<Self>> {
        let Some(items) = ProductProgram::opening(element, policy, decoder)? else {
            return Ok(None);
        };
        // Whole representations have resolved; no Items have been requested yet.
        let mut placement = router
            .get_placement_transform_from_element(element, decoder)
            .unwrap_or_else(|_| Matrix4::identity());
        router.scale_transform(&mut placement);
        Ok(Some(Self { items, placement }))
    }

    pub(crate) fn meshes(
        mut self,
        element: &DecodedEntity,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>,
    ) -> Result<Vec<Mesh>> {
        let mut output = Vec::new();
        while let Some(ReachedItem { item, .. }) = self.items.next(decoder)? {
            // Only the mesh policy attempts the raw-per-element route first.
            let parts = match router.process_raw_item_for_element(&item, element, decoder) {
                Ok(Some(mesh)) => Ok(vec![mesh]),
                Ok(None) => router.process_representation_item_parts(&item, decoder),
                Err(error) => Err(error),
            };
            let Ok(parts) = parts else { continue };
            for mut mesh in parts.into_iter().filter(|mesh| !mesh.is_empty()) {
                let framed = router.needs_local_frame(&mesh, &self.placement);
                router.transform_mesh_world_framed(&mut mesh, &self.placement, framed);
                output.push(mesh);
            }
        }
        Ok(output)
    }

    pub(crate) fn bounds(
        mut self,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>,
    ) -> Result<OpeningBounds> {
        let mut output = Vec::new();
        while let Some(ReachedItem { item, .. }) = self.items.next(decoder)? {
            let direction = if let Some((local_dir, position_transform)) =
                router.extract_extrusion_direction_recursive(&item, decoder)
            {
                // A zero-length IFCDIRECTION drops only THIS item's direction
                // (coarser bounds), not `?`-abort every sibling item's bounds.
                let element_rot = extract_rotation_columns(&self.placement);
                if let Some(pos_transform) = position_transform {
                    let pos_rot = extract_rotation_columns(&pos_transform);
                    rotate_and_normalize(&pos_rot, &local_dir)
                        .ok()
                        .and_then(|world_dir| rotate_and_normalize(&element_rot, &world_dir).ok())
                } else {
                    rotate_and_normalize(&element_rot, &local_dir).ok()
                }
            } else {
                None
            };

            let Ok(parts) = router.process_representation_item_parts(&item, decoder) else {
                continue;
            };
            for mesh in parts.into_iter().filter(|mesh| !mesh.is_empty()) {
                let (min, max) =
                    super::opening_bounds::evaluate(&mesh, &self.placement, router.rtc_offset());
                output.push((min, max, direction));
            }
        }
        Ok(output)
    }
}
