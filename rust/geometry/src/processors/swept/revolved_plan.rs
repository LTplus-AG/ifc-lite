// SPDX-License-Identifier: MPL-2.0
//! Owned production revolution of admitted sampled profile regions.
//! Lengths remain in file units; the source plane-angle unit is resolved to
//! radians during lowering. No product/mapping placement, unit scaling or RTC
//! is applied here. An empty profile keeps the original axis-data short circuit.

use crate::{extrusion::apply_transform, profile::Profile2D, profiles::ProfileProcessor,
    scale_segments, Error, Mesh, Point3, Result, TessellationQuality, Vector3};
use crate::processors::{helpers::parse_axis2_placement_3d, tessellated::PolygonalFaceSetProcessor};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;
use super::Revolution;

#[derive(Debug, Clone)]
pub(crate) enum RevolvedPlan {
    Empty,
    Regions {
        regions: Vec<Profile2D>,
        position_transform: Matrix4<f64>,
        sweep: Revolution,
    },
}

pub(super) fn lower(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
    profile_processor: &ProfileProcessor,
) -> Result<RevolvedPlan> {
    let profile_attr = entity
        .get(slot::IfcRevolvedAreaSolid::SWEPT_AREA.index())
        .ok_or_else(|| Error::geometry("RevolvedAreaSolid missing SweptArea".to_string()))?;
    let profile = decoder
        .resolve_ref(profile_attr)?
        .ok_or_else(|| Error::geometry("Failed to resolve SweptArea".to_string()))?;

    // Position transform: maps Position-local coords -> object coords.
    // Optional in some files; default to identity.
    let position_transform = if let Some(pos_attr) = entity.get(slot::IfcRevolvedAreaSolid::POSITION.index()) {
        if !pos_attr.is_null() {
            if let Some(pos_entity) = decoder.resolve_ref(pos_attr)? {
                parse_axis2_placement_3d(&pos_entity, decoder)?
            } else {
                Matrix4::identity()
            }
        } else {
            Matrix4::identity()
        }
    } else {
        Matrix4::identity()
    };

    let axis_attr = entity
        .get(slot::IfcRevolvedAreaSolid::AXIS.index())
        .ok_or_else(|| Error::geometry("RevolvedAreaSolid missing Axis".to_string()))?;
    let axis_placement = decoder
        .resolve_ref(axis_attr)?
        .ok_or_else(|| Error::geometry("Failed to resolve Axis".to_string()))?;

    let angle = entity
        .get_float(slot::IfcRevolvedAreaSolid::ANGLE.index())
        .ok_or_else(|| Error::geometry("RevolvedAreaSolid missing Angle".to_string()))?
        * decoder.plane_angle_to_radians();

    // One solid per disjoint admitted profile area.
    profile_processor.arm_solid_budget();
    let mut regions = profile_processor.process_regions(&profile, decoder, quality)?;
    regions.retain(|region| region.outer.len() >= 3);
    if regions.is_empty() {
        return Ok(RevolvedPlan::Empty);
    }

    // IfcAxis1Placement: 0=Location (IfcCartesianPoint), 1=Axis (IfcDirection, optional)
    let axis_location = {
        let loc_attr = axis_placement
            .get(slot::IfcAxis1Placement::LOCATION.index())
            .ok_or_else(|| Error::geometry("Axis1Placement missing Location".to_string()))?;
        let loc = decoder
            .resolve_ref(loc_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve axis location".to_string()))?;
        let coords = loc
            .get(slot::IfcCartesianPoint::COORDINATES.index())
            .and_then(|v| v.as_list())
            .ok_or_else(|| Error::geometry("Axis location missing coordinates".to_string()))?;
        Point3::new(
            coords.first().and_then(|v| v.as_float()).unwrap_or(0.0),
            coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0), // not-an-attribute: Y coordinate in coordinate list
            coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0), // not-an-attribute: Z coordinate in coordinate list
        )
    };

    let axis_direction = {
        if let Some(dir_attr) = axis_placement.get(slot::IfcAxis1Placement::AXIS.index()) {
            if !dir_attr.is_null() {
                let dir = decoder.resolve_ref(dir_attr)?.ok_or_else(|| {
                    Error::geometry("Failed to resolve axis direction".to_string())
                })?;
                let coords = dir.get(slot::IfcDirection::DIRECTION_RATIOS.index()).and_then(|v| v.as_list()).ok_or_else(|| {
                    Error::geometry("Axis direction missing coordinates".to_string())
                })?;
                let raw = Vector3::new(
                    coords.first().and_then(|v| v.as_float()).unwrap_or(0.0),
                    coords.get(1).and_then(|v| v.as_float()).unwrap_or(1.0), // not-an-attribute: Y component in DirectionRatios
                    coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0), // not-an-attribute: Z component in DirectionRatios
                );
                if raw.norm() < 1e-12 {
                    Vector3::new(0.0, 1.0, 0.0)
                } else {
                    raw.normalize()
                }
            } else {
                Vector3::new(0.0, 1.0, 0.0)
            }
        } else {
            Vector3::new(0.0, 1.0, 0.0)
        }
    };

    let full_circle = angle.abs() >= std::f64::consts::PI * 1.99;
    // 24 segments for a full revolve at Medium; ~12 per 180° (min 8) for a
    // partial arc. Both scaled by quality; the high upper bound preserves
    // the original uncapped partial-arc count at Medium.
    let segments = if full_circle {
        scale_segments(24, 8, 96, quality)
    } else {
        let base = (angle.abs() / std::f64::consts::PI * 12.0).ceil() as usize;
        scale_segments(base, 8, 4096, quality)
    };

    // Every ring point is placed once per step: refuse a revolution of
    // rings base did not sweep (areas, holes) above the output cap,
    // before building it.
    let ring_count = if full_circle { segments } else { segments + 1 };
    let placed = regions.iter().map(crate::profiles::region_points).sum::<usize>() * ring_count;
    crate::profiles::check_sweep_vertices(placed, crate::profiles::sweeps_new_rings(&regions), entity.id)?;

    Ok(RevolvedPlan::Regions { regions, position_transform,
        sweep: Revolution { axis_location, axis_direction, angle, full_circle, segments } })
}

impl RevolvedPlan {
    pub(crate) fn evaluate(&self) -> Result<Mesh> {
        let Self::Regions { regions, position_transform, sweep } = self else {
            return Ok(Mesh::new());
        };
        let mut positions = Vec::new();
        let mut indices = Vec::new();
        for region in regions {
            sweep.emit_region(region, &mut positions, &mut indices)?;
        }

        let mut mesh = Mesh {
            positions,
            normals: Vec::new(),
            indices,
            rtc_applied: false,
            welded_in_object_frame: false,
            plane_tags: None,
            origin: [0.0; 3],        instance_meta: None, local_bounds: None, local_to_world: None };

        // Apply Position to lift Position-local coords into object coords.
        apply_transform(&mut mesh, position_transform);

        // Profile-boundary creases (e.g. flange-to-web on an I-beam) are
        // all sharp 90° edges, but the swept mesh shares vertices between
        // adjacent side quads — so per-vertex normal averaging smooths the
        // shading across every crease and the cross-section reads as a
        // smooth blob. Flat-shade the whole revolved solid (each triangle
        // gets its own three vertices with the face normal) so the
        // shading matches the actual geometry.
        let flat =
            PolygonalFaceSetProcessor::build_flat_shaded_mesh(&mesh.positions, &mesh.indices);
        mesh.positions = flat.positions;
        mesh.normals = flat.normals;
        mesh.indices = flat.indices;

        Ok(mesh)
    }
}

#[cfg(test)]
#[path = "revolved_plan_tests.rs"]
mod tests;
