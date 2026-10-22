// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Existing numerical regression entry points drive the same owned execution
//! the gateways use, publishing its diagnostics into the test's router.
use super::*;

impl GeometryRouter {
    fn test_execution<T>(&self, run: impl FnOnce(&Execution) -> T) -> T {
        let execution = Execution::new(self.tessellation_quality);
        let (value, telemetry) = crate::telemetry_transaction::capture(|| run(&execution));
        execution.finish().publish(self);
        telemetry.commit();
        value
    }

    pub(super) fn apply_void_context(&self, mesh: Mesh, ctx: &VoidContext, id: u32) -> Mesh {
        match execute(mesh, ctx, id, self.tessellation_quality).publish(self) {
            Ok(mesh) => mesh,
            Err(error) => panic!("numerical cut outcome: {error:?}"),
        }
    }

    pub(super) fn apply_void_context_inner(
        &self,
        mesh: Mesh,
        ctx: &VoidContext,
        id: u32,
        bounds: ((f32, f32, f32), (f32, f32, f32)),
        allow_local_frame: bool,
    ) -> Mesh {
        self.test_execution(|e| {
            e.apply_void_context_inner(mesh, ctx, id, bounds, allow_local_frame)
        })
    }

    pub(super) fn try_param_rect_cut(&self, mesh: &Mesh, ctx: &VoidContext) -> Option<Mesh> {
        self.test_execution(|e| e.try_param_rect_cut(mesh, ctx))
    }

    pub(super) fn try_prism_cut(
        &self,
        mesh: &Mesh,
        ctx: &VoidContext,
    ) -> Option<(Mesh, Option<VoidContext>)> {
        self.test_execution(|e| e.try_prism_cut(mesh, ctx))
    }

    pub(super) fn try_staged_bool2d(
        &self,
        mesh: &Mesh,
        cut: &bool2d_path::Bool2dCut,
        id: u32,
    ) -> Option<Mesh> {
        self.test_execution(|e| e.try_staged_bool2d(mesh, cut, id))
    }

    pub(super) fn extend_opening_along_direction(
        &self,
        min: Point3<f64>,
        max: Point3<f64>,
        wall_min: Point3<f64>,
        wall_max: Point3<f64>,
        direction: Vector3<f64>,
    ) -> (Point3<f64>, Point3<f64>) {
        self.test_execution(|e| {
            e.extend_opening_along_direction(min, max, wall_min, wall_max, direction)
        })
    }

    pub(super) fn coaxial_union_prepass(
        &self,
        mesh: &mut Mesh,
        openings: &[&OpeningType],
        consumed: &mut [bool],
        mutated: &mut bool,
        clipper: &ClippingProcessor,
    ) {
        self.test_execution(|e| e.coaxial_union_prepass(mesh, openings, consumed, mutated, clipper))
    }
}
