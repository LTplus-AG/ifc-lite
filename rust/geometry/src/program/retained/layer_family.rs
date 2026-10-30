// SPDX-License-Identifier: MPL-2.0
//! IFC layer coordinates; exact supplies admission and scalar order (#7955).
use crate::{GeometryRouter, material_layer_index::LayerAxis};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use nalgebra::{Matrix4, Point3, Vector3};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LayerFamily {
    Planar { axis: [f64; 3] },
    Cylindrical { center: [f64; 3], radius: f64, sigma: f64 },
}
#[derive(Debug)]
pub struct LayerSpec {
    pub source_id: u32,
    pub family: LayerFamily,
    pub layers: Vec<(u32, f64)>,
    pub sense: f64,
    pub offset_m: f64,
    pub world_from_object: [f64; 16],
}
#[derive(Debug)]
pub enum LayerAdmission { None, Skip(&'static str), Bands(LayerSpec) }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShapeLayer { pub index: u16, pub material_id: u32 }
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LayerInterface {
    Plane { normal: [f64; 3], distance: f64 },
    Cylinder { center: [f64; 3], axis: [f64; 3], radius: f64, outward: f64 },
}
#[derive(Debug)]
pub struct LayerCompletion {
    pub tags: Vec<ShapeLayer>,
    pub interfaces: Vec<LayerInterface>,
}

impl LayerSpec {
    pub fn cumulative(&self) -> impl Iterator<Item = f64> + '_ {
        let mut sum = 0.;
        self.layers.iter().take(self.layers.len().saturating_sub(1)).map(move |(_, t)| { sum += t; sum })
    }
    /// The scalar law is exact's d=offset+sense*C. Along a directed circle,
    /// positive Axis2 is its left normal: q=sigma*(R-rho), so solve q=d.
    pub fn radius_at(&self, cumulative: f64) -> Option<f64> {
        let LayerFamily::Cylindrical { radius, sigma, .. } = self.family else { return None; };
        Some(radius - sigma * self.offset_m - sigma * self.sense * cumulative)
    }
    pub(crate) fn interfaces(&self, host_frame: [f64; 16]) -> Result<Vec<LayerInterface>, &'static str> {
        let frame = crate::document::retained_frames::relative(host_frame, self.world_from_object)
            .map_err(|_| "layer_frame")?;
        let g = Matrix4::from_column_slice(&frame);
        let mut out = Vec::new();
        crate::resource::reserve_headers(&mut out, self.layers.len().saturating_sub(1))
            .map_err(|_| "layer_budget")?.retain();
        for c in self.cumulative() {
            out.push(match self.family {
                LayerFamily::Planar { axis } => {
                    let a = Vector3::from(axis);
                    let n = g.transform_vector(&(a * self.sense));
                    let p = g.transform_point(&Point3::from(a * (self.offset_m + self.sense * c)));
                    LayerInterface::Plane { normal: n.into(), distance: n.dot(&p.coords) }
                }
                LayerFamily::Cylindrical { center, sigma, .. } => LayerInterface::Cylinder {
                    center: g.transform_point(&Point3::from(center)).into(),
                    axis: g.transform_vector(&Vector3::z()).into(),
                    radius: self.radius_at(c).ok_or("layer_radius")?, outward: -sigma * self.sense,
                },
            });
        }
        Ok(out)
    }
}

pub(crate) fn admit(element: &DecodedEntity, router: &GeometryRouter,
    usages: &super::layer_source::LayerUsages, decoder: &mut EntityDecoder) -> Result<LayerAdmission, &'static str> {
    let Some(buildup) = router.material_layer_index().and_then(|i| i.get(element.id)) else {
        return Ok(LayerAdmission::None);
    };
    if let crate::material_layer_index::LayerBuildup::Sliceable { layers, .. } = buildup {
        // Exact's merge repeatedly scans/removes the thinnest layer. Charge
        // its worst-case work and both scalar-stack allocations before reuse;
        // the latched stop preserves the product resource refusal precedence.
        let n = layers.len() as u64;
        crate::resource::charge(crate::resource::Cost {
            work: n.saturating_mul(n), live_bytes: n.saturating_mul(64),
            ..Default::default()
        }).map_err(|_| "layer_budget")?.retain();
    }
    let program = match crate::router::layers::LayerProgram::admit(element, decoder, buildup, router.unit_scale()) {
        Ok(Some(p)) => p,
        Ok(None) => return Ok(LayerAdmission::None),
        Err(skip) => return Ok(LayerAdmission::Skip(skip.reason())),
    };
    let (layers, axis, sense, offset) = program.retained_parameters();
    if layers.len() > usize::from(u16::MAX) || !offset.is_finite() || !matches!(sense, -1. | 1.) {
        return Err("layer_parameters");
    }
    let family = if axis == LayerAxis::Axis2 {
        super::layer_source::axis_family(element, decoder, router.unit_scale())?
    } else { LayerFamily::Planar { axis: axis.unit_vector() } };
    let source_id = usages.get(element.id)?;
    let placement = router.resolve_scaled_placement_strict(element, decoder).map_err(|_| "layer_frame")?;
    let spec = LayerSpec { source_id, family, layers, sense, offset_m: offset * router.unit_scale(),
        world_from_object: placement };
    if spec.cumulative().any(|c| spec.radius_at(c).is_some_and(|r| !r.is_finite() || r <= 0.)) {
        return Err("layer_radius");
    }
    Ok(LayerAdmission::Bands(spec))
}
