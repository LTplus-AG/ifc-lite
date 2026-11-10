// SPDX-License-Identifier: MPL-2.0
//! Output units and coordinates: where a pipeline vertex lands in the file.
//!
//! The pipeline emits metres in its mesh frame, f32 positions relative to an
//! f64 per-mesh origin. A written vertex is `origin + position` in f64, mapped
//! to IFC world through `MeshFrame::world_mapper` when `world` was asked for, then
//! divided by the output unit's metres-per-unit.

use ifc_lite_core::fmt_num::fmt_num;
use ifc_lite_geometry::math::mat4;
use ifc_lite_processing::MeshFrame;

use super::options::{RhinoCoordinates, RhinoUnits};

/// `(rhino3dm UnitSystem name, metres per unit)` for every unit the scene
/// writes; [`resolve_units`] indexes it.
const UNITS: [(&str, f64); 5] = [
    ("Millimeters", 0.001),
    ("Centimeters", 0.01),
    ("Meters", 1.0),
    ("Feet", 0.3048),
    ("Inches", 0.0254),
];

/// The Rhino unit whose scale is `metres_per_unit`, when there is one.
pub(super) fn rhino_unit_for_scale(metres_per_unit: f64) -> Option<(&'static str, f64)> {
    UNITS.iter().copied().find(|&(_, m)| (metres_per_unit - m).abs() <= m * 1e-9)
}

/// Resolve the output unit. `source_scale` is the project length unit in
/// metres (`ModelMetadata::length_unit_scale`). A source unit Rhino has no
/// member for falls back to metres and pushes one warning.
pub(super) fn resolve_units(units: RhinoUnits, source_scale: Option<f64>, warnings: &mut Vec<String>) -> (&'static str, f64) {
    match units {
        RhinoUnits::Millimeters => UNITS[0],
        RhinoUnits::Centimeters => UNITS[1],
        RhinoUnits::Meters => UNITS[2],
        RhinoUnits::Feet => UNITS[3],
        RhinoUnits::Inches => UNITS[4],
        RhinoUnits::Source => match source_scale {
            Some(s) => rhino_unit_for_scale(s).unwrap_or_else(|| {
                warnings.push(format!("length unit scale {} is not a Rhino unit; wrote Meters", fmt_num(s)));
                UNITS[2]
            }),
            None => {
                warnings.push("the model declares no usable length unit; wrote Meters".to_string());
                UNITS[2]
            }
        },
    }
}

/// Maps pipeline points, directions and instance transforms into the file.
pub(super) struct OutputSpace {
    frame: MeshFrame,
    world: bool,
    units_per_metre: f64,
}

impl OutputSpace {
    pub(super) fn new(frame: MeshFrame, coordinates: RhinoCoordinates, metres_per_unit: f64) -> Self {
        Self { frame, world: coordinates == RhinoCoordinates::World, units_per_metre: 1.0 / metres_per_unit }
    }

    /// A point in metres, in output units. No frame applied: a baked point
    /// is already in the written frame under `local`, a block point stays in
    /// the template's.
    #[inline]
    pub(super) fn to_units(&self, p: [f64; 3]) -> [f64; 3] {
        p.map(|v| v * self.units_per_metre)
    }

    /// The frame baked points and directions leave under `world`, through
    /// `MeshFrame::world_mapper` / `direction_mapper` (the rotation check made
    /// once, as the OBJ writer does); `None` under `local`, where nothing moves.
    pub(super) fn world_frame(&self) -> Option<MeshFrame> {
        self.world.then_some(self.frame)
    }

    /// An IFC world point (metres) in the file.
    pub(super) fn world_point(&self, p: [f64; 3]) -> [f64; 3] {
        let q = if self.world {
            p
        } else {
            let (x, y, z) = self.frame.rtc_offset();
            self.frame.rotate_into_frame([p[0] - x, p[1] - y, p[2] - z])
        };
        q.map(|v| v * self.units_per_metre)
    }

    /// An IFC world direction in the file.
    pub(super) fn world_direction(&self, v: [f64; 3]) -> [f64; 3] {
        if self.world { v } else { self.frame.rotate_into_frame(v) }
    }

    /// Row-major transform from block coordinates (template positions, output
    /// units) to written coordinates for an occurrence placed by `rel`
    /// (`InstanceRecord::transform`, row-major, template-relative) on a
    /// template baked at `origin`: `S · W · rel · T(origin) · S⁻¹`, with `W`
    /// the frame restore under `world` and the identity otherwise.
    pub(super) fn instance_xform(&self, rel: &[f64; 16], origin: [f64; 3]) -> [f64; 16] {
        let mut m = mat4::mul(rel, &mat4::translation(origin));
        if self.world {
            m = mat4::mul(&self.world_rows(), &m);
        }
        // S · M · S⁻¹ with a uniform S keeps the linear part and scales the translation.
        for r in 0..3 {
            m[r * 4 + 3] *= self.units_per_metre;
        }
        m
    }

    /// `IFC::WorldFromModel`: the row-major frame restore, metres. Only for a `local` export
    /// of a shifted model: `world` vertices are already IFC world, so there is nothing to restore.
    pub(super) fn world_from_model(&self) -> Option<[f64; 16]> {
        (!self.world && self.frame.needs_shift()).then(|| self.world_rows())
    }

    /// The frame restore (`MeshFrame::world_matrix`, column-major) row-major.
    fn world_rows(&self) -> [f64; 16] {
        mat4::transpose(&self.frame.world_matrix())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_units_map_rhino_members_and_warn_once_otherwise() {
        let mut w = Vec::new();
        assert_eq!(resolve_units(RhinoUnits::Source, Some(0.001), &mut w), ("Millimeters", 0.001));
        assert_eq!(resolve_units(RhinoUnits::Source, Some(0.3048), &mut w), ("Feet", 0.3048));
        assert!(w.is_empty());
        assert_eq!(resolve_units(RhinoUnits::Source, Some(0.5), &mut w), ("Meters", 1.0));
        assert_eq!(w, ["length unit scale 0.5 is not a Rhino unit; wrote Meters"]);
        assert_eq!(resolve_units(RhinoUnits::Inches, Some(0.001), &mut w), ("Inches", 0.0254));
    }

    #[test]
    fn instance_xform_scales_translation_only() {
        let space = OutputSpace::new(MeshFrame::RawIfc, RhinoCoordinates::Local, 0.001);
        let mut rel = [0.0f64; 16];
        // 90 degrees about Z, then +2 m in x.
        rel[1] = -1.0;
        rel[3] = 2.0;
        rel[4] = 1.0;
        rel[10] = 1.0;
        rel[15] = 1.0;
        let m = space.instance_xform(&rel, [1.0, 0.0, 0.0]);
        // Block vertex (0 mm) is the template origin (1, 0, 0) m, rotated to (0, 1, 0), moved to (2, 1, 0) m.
        assert_eq!([m[3], m[7], m[11]], [2000.0, 1000.0, 0.0]);
        assert_eq!([m[0], m[1], m[4], m[5]], [0.0, -1.0, 1.0, 0.0]);
    }
}
