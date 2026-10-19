// SPDX-License-Identifier: MPL-2.0
//! One late placement source admission and its source-free world transform.
use super::Geometry;
use crate::router::transforms::WorldFrame;
use crate::{GeometryRouter, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, slot};
use nalgebra::Matrix4;

pub(crate) struct ProductPlacementRequest {
    pub(super) element: DecodedEntity,
    pub(super) has_meshes: bool,
}
pub(crate) struct PlacementAdmission {
    transform: Matrix4<f64>,
    frame: Option<WorldFrame>,
    stamp_instance: bool,
    product_id: u32,
}
impl ProductPlacementRequest {
    pub(crate) fn admit(self, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>) -> Result<PlacementAdmission> {
        let placement = match self.element.get(slot::IfcProduct::OBJECT_PLACEMENT.index()).filter(|attribute| !attribute.is_null()) {
            Some(attribute) => decoder.resolve_ref(attribute)?,
            None => None,
        };
        let (transform, stamp_instance) = match placement {
            Some(placement) => {
                let mut transform = crate::placement::resolve_chain(&placement, decoder)?;
                router.scale_transform(&mut transform);
                (transform, true)
            }
            None => (Matrix4::identity(), false),
        };
        // An empty styled collection resolves its placement but performs no
        // world transform and must not eagerly initialize the lazy policy.
        let frame = self.has_meshes.then(|| router.world_frame());
        Ok(PlacementAdmission { transform, frame, stamp_instance, product_id:self.element.id })
    }
}

pub(crate) struct ReadyProductPlace {
    pub(super) geometry: Geometry,
    pub(super) admission: PlacementAdmission,
}
impl ReadyProductPlace {
    pub(crate) fn execute(mut self) -> Result<Geometry> {
        let admission = self.admission;
        match &mut self.geometry {
            Geometry::Retained(values) => {
                // Analytic world frames are f64. WorldFrame/RTC display assembly
                // remains a separate unqualified requirement, never an f32 bake.
                let mut output=Vec::new();
                crate::resource::reserve_headers(&mut output,values.len())?.retain();
                for value in std::mem::take(values) {
                    output.push(value.placed(&admission.transform,0,crate::program::retained::RetainedPlacementStage::Product {product_id:admission.product_id})?);
                }
                *values=output;
            }
            Geometry::Single(mesh) => {
                if admission.stamp_instance {
                    if let Some(instance) = &mut mesh.instance_meta {
                        instance.transform = crate::math::mat4::from_na(&admission.transform);
                    }
                }
                admission.frame.expect("single mesh has captured world frame")
                    .transform_mesh_world(mesh, &admission.transform);
            }
            Geometry::Styled(collection) => {
                if admission.stamp_instance && crate::router::transforms::instancing_enabled() {
                    let transform = crate::math::mat4::from_na(&admission.transform);
                    for sub in &mut collection.sub_meshes {
                        if let Some(instance) = &mut sub.mesh.instance_meta { instance.transform = transform; }
                    }
                }
                for sub in &mut collection.sub_meshes {
                    admission.frame.expect("nonempty collection has captured world frame")
                        .transform_mesh_world(&mut sub.mesh, &admission.transform);
                }
            }
        }
        Ok(self.geometry)
    }
}
