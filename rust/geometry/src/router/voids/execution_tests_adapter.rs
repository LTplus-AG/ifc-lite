// SPDX-License-Identifier: MPL-2.0
//! Existing numerical regression entry points drive the same owned operations.
use super::*;

impl GeometryRouter {
    pub(in crate::router::voids) fn apply_void_context_inner(
        &self,
        mesh: Mesh,
        ctx: &VoidContext,
        id: u32,
        bounds: ((f32, f32, f32), (f32, f32, f32)),
        local: bool,
    ) -> Mesh {
        let execution = Execution::new(self.tessellation_quality, numerical_configuration());
        let result = execution.apply_void_context_inner(mesh, ctx, id, bounds, local).unwrap();
        execution.finish().publish(self);
        result
    }
    pub(in crate::router::voids) fn try_param_rect_cut(
        &self,
        mesh: &Mesh,
        ctx: &VoidContext,
    ) -> Option<Mesh> {
        let execution = Execution::new(self.tessellation_quality, numerical_configuration());
        let result = execution.try_param_rect_cut(mesh, ctx).unwrap();
        execution.finish().publish(self);
        result
    }
    pub(super) fn try_prism_cut(
        &self,
        mesh: &Mesh,
        ctx: &VoidContext,
    ) -> Option<(Mesh, Option<VoidContext>)> {
        Execution::new(self.tessellation_quality, numerical_configuration())
            .try_prism_cut(mesh, ctx).unwrap()
    }
    pub(in crate::router::voids) fn try_staged_bool2d(
        &self,
        mesh: &Mesh,
        cut: &bool2d_path::Bool2dCut,
        id: u32,
    ) -> Option<Mesh> {
        let execution = Execution::new(self.tessellation_quality, numerical_configuration());
        let result = execution.try_staged_bool2d(mesh, cut, id).unwrap();
        execution.finish().publish(self);
        result
    }
    pub(in crate::router::voids) fn extend_opening_along_direction(
        &self,
        min: Point3<f64>,
        max: Point3<f64>,
        wall_min: Point3<f64>,
        wall_max: Point3<f64>,
        direction: Vector3<f64>,
    ) -> (Point3<f64>, Point3<f64>) {
        Execution::new(self.tessellation_quality, numerical_configuration())
            .extend_opening_along_direction(min, max, wall_min, wall_max, direction)
    }
    pub(in crate::router::voids) fn coaxial_union_prepass(
        &self,
        mesh: &mut Mesh,
        openings: &[&OpeningType],
        consumed: &mut [bool],
        mutated: &mut bool,
        clipper: &ClippingProcessor,
    ) {
        Execution::new(self.tessellation_quality, numerical_configuration())
            .coaxial_union_prepass(mesh, openings, consumed, mutated, clipper).unwrap();
    }
}
