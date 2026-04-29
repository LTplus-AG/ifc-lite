// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Rigid-body plausibility checks for IFC geometry.
//!
//! Given a set of triangulated meshes (one per IFC element) and a removal
//! request ("remove these express IDs"), this crate builds a Rapier world,
//! infers anchors and connections, and reports which elements stayed put,
//! tipped, or fell.
//!
//! The output is a *plausibility check*, not structural engineering — it
//! ignores bending, buckling, material yield, and dynamic loading. Use it for
//! quick what-if exploration, BIM coordination, and education; route real
//! analysis through `IfcStructuralAnalysisModel` and an FEM solver.
//!
//! ```no_run
//! use ifc_lite_physics::{simulate, PhysicsMesh, SimulateOptions};
//!
//! let meshes: Vec<PhysicsMesh> = vec![/* …from your IFC pipeline… */];
//! let mut options = SimulateOptions::default();
//! options.remove.push(42); // express id of the column we want to yank
//! let result = simulate(&meshes, &options);
//! println!("{} elements would fall", result.falling.len());
//! ```

mod simulate;
mod types;
mod world;

pub use simulate::simulate;
pub use types::{
    Aabb, AnchorReason, BodyOutcome, ColliderStrategy, PhysicsMesh, SimulateOptions,
    SimulationResult, SimulationTrajectory, Stability,
};

#[cfg(test)]
mod tests {
    use super::*;

    /// A unit cube centered at the origin, scaled and translated.
    fn cube(express_id: u32, ifc_type: &str, center: [f32; 3], size: [f32; 3]) -> PhysicsMesh {
        let hx = size[0] * 0.5;
        let hy = size[1] * 0.5;
        let hz = size[2] * 0.5;
        let cx = center[0];
        let cy = center[1];
        let cz = center[2];
        let positions: Vec<f32> = vec![
            cx - hx, cy - hy, cz - hz,
            cx + hx, cy - hy, cz - hz,
            cx + hx, cy + hy, cz - hz,
            cx - hx, cy + hy, cz - hz,
            cx - hx, cy - hy, cz + hz,
            cx + hx, cy - hy, cz + hz,
            cx + hx, cy + hy, cz + hz,
            cx - hx, cy + hy, cz + hz,
        ];
        let indices: Vec<u32> = vec![
            0, 1, 2, 0, 2, 3, // bottom (-z)
            4, 6, 5, 4, 7, 6, // top (+z)
            0, 4, 5, 0, 5, 1, // -y
            1, 5, 6, 1, 6, 2, // +x
            2, 6, 7, 2, 7, 3, // +y
            3, 7, 4, 3, 4, 0, // -x
        ];
        PhysicsMesh {
            express_id,
            ifc_type: ifc_type.to_string(),
            positions,
            indices,
        }
    }

    #[test]
    fn floor_anchors_via_ifc_type() {
        let slab = cube(1, "IfcSlab", [0.0, 0.0, 0.05], [4.0, 4.0, 0.1]);
        let column = cube(2, "IfcColumn", [0.0, 0.0, 1.6], [0.3, 0.3, 3.0]);
        let result = simulate(
            &[slab, column],
            &SimulateOptions {
                duration_seconds: 1.0,
                ..Default::default()
            },
        );
        assert!(result.anchored.contains(&1), "slab should be anchored");
        assert!(result.stable.contains(&2), "column resting on anchored slab should stay stable");
        assert!(!result.falling.contains(&2));
    }

    #[test]
    fn removing_load_bearing_column_lets_slab_fall() {
        // Column-on-slab with the slab carried only by the column.
        // Our anchor heuristic anchors any IfcSlab whose underside touches
        // the model floor — so we offset the slab off the floor here so it
        // genuinely depends on the column.
        let column = cube(1, "IfcColumn", [0.0, 0.0, 1.5], [0.3, 0.3, 3.0]);
        let slab = cube(2, "IfcSlab", [0.0, 0.0, 3.05], [3.0, 3.0, 0.1]);
        let footing = cube(3, "IfcFooting", [0.0, 0.0, -0.05], [1.0, 1.0, 0.1]);

        let baseline = simulate(
            &[footing.clone(), column.clone(), slab.clone()],
            &SimulateOptions {
                duration_seconds: 1.0,
                ..Default::default()
            },
        );
        assert!(baseline.anchored.contains(&3), "footing must anchor");
        assert!(baseline.stable.contains(&2), "slab stable in baseline");

        let removed = simulate(
            &[footing, column, slab],
            &SimulateOptions {
                remove: vec![1],
                duration_seconds: 1.5,
                ..Default::default()
            },
        );
        assert!(removed.removed.contains(&1));
        assert!(!removed.bodies.iter().any(|b| b.express_id == 1));
        assert!(
            removed.falling.contains(&2),
            "slab should fall once the column is removed; got falling={:?}",
            removed.falling
        );
    }

    #[test]
    fn explicit_anchor_overrides_dynamic() {
        let column = cube(1, "IfcColumn", [0.0, 0.0, 1.5], [0.3, 0.3, 3.0]);
        let result = simulate(
            &[column],
            &SimulateOptions {
                anchor: vec![1],
                duration_seconds: 0.5,
                ..Default::default()
            },
        );
        assert!(result.anchored.contains(&1));
        assert!(result.stable.contains(&1));
        assert!(!result.falling.contains(&1));
    }

    #[test]
    fn explicit_connection_welds_unrelated_elements() {
        // Two cubes that don't touch by AABB. Without an explicit connection
        // the second one falls; with one it should hang on its anchored neighbor.
        let anchor = cube(1, "IfcFooting", [0.0, 0.0, 0.0], [1.0, 1.0, 0.1]);
        let floater = cube(2, "IfcBeam", [5.0, 0.0, 1.0], [0.3, 0.3, 0.3]);

        let baseline = simulate(
            &[anchor.clone(), floater.clone()],
            &SimulateOptions {
                duration_seconds: 1.0,
                ..Default::default()
            },
        );
        assert!(baseline.falling.contains(&2), "baseline: floater falls");

        let with_link = simulate(
            &[anchor, floater],
            &SimulateOptions {
                duration_seconds: 1.0,
                connections: vec![[1, 2]],
                ..Default::default()
            },
        );
        assert!(
            !with_link.falling.contains(&2),
            "explicit connection should suspend floater; got falling={:?}",
            with_link.falling,
        );
        assert!(with_link.joints.contains(&(1, 2)) || with_link.joints.contains(&(2, 1)));
    }

    #[test]
    fn explicit_connections_are_deduplicated_against_aabb_pairs() {
        let slab = cube(1, "IfcSlab", [0.0, 0.0, 0.05], [4.0, 4.0, 0.1]);
        let column = cube(2, "IfcColumn", [0.0, 0.0, 1.6], [0.3, 0.3, 3.0]);
        let result = simulate(
            &[slab, column],
            &SimulateOptions {
                duration_seconds: 0.5,
                connections: vec![[1, 2], [2, 1]], // duplicate + reversed
                ..Default::default()
            },
        );
        let count = result
            .joints
            .iter()
            .filter(|p| **p == (1, 2) || **p == (2, 1))
            .count();
        assert_eq!(count, 1, "duplicate joints not collapsed: {:?}", result.joints);
    }

    #[test]
    fn convex_hull_strategy_keeps_column_stable_on_anchored_slab() {
        // The 'Auto' strategy promotes IfcColumn to a convex-hull collider.
        // A column resting on an anchored slab should remain stable.
        let slab = cube(1, "IfcSlab", [0.0, 0.0, 0.05], [4.0, 4.0, 0.1]);
        let column = cube(2, "IfcColumn", [0.0, 0.0, 1.6], [0.3, 0.3, 3.0]);
        let result = simulate(
            &[slab, column],
            &SimulateOptions {
                duration_seconds: 1.0,
                collider_strategy: ColliderStrategy::Auto,
                ..Default::default()
            },
        );
        assert!(result.stable.contains(&2));
    }

    #[test]
    fn forced_trimesh_strategy_still_simulates() {
        let slab = cube(1, "IfcSlab", [0.0, 0.0, 0.05], [4.0, 4.0, 0.1]);
        let column = cube(2, "IfcColumn", [0.0, 0.0, 1.6], [0.3, 0.3, 3.0]);
        let result = simulate(
            &[slab, column],
            &SimulateOptions {
                duration_seconds: 0.5,
                collider_strategy: ColliderStrategy::Trimesh,
                ..Default::default()
            },
        );
        assert_eq!(result.bodies.len(), 2);
    }

    #[test]
    fn capture_trajectory_records_per_frame_poses() {
        let slab = cube(1, "IfcSlab", [0.0, 0.0, 0.05], [4.0, 4.0, 0.1]);
        let column = cube(2, "IfcColumn", [0.0, 0.0, 1.6], [0.3, 0.3, 3.0]);
        let result = simulate(
            &[slab, column],
            &SimulateOptions {
                duration_seconds: 0.5,
                capture_trajectory: true,
                trajectory_stride: 1,
                ..Default::default()
            },
        );
        let trajectory = result.trajectory.expect("trajectory captured");
        assert_eq!(trajectory.body_order, vec![1, 2]);
        // dt = 1/60 ≈ 0.0167; 0.5s ⇒ 30 steps; +1 initial frame ⇒ 31.
        assert!(trajectory.frame_count >= 30);
        assert_eq!(trajectory.poses.len(), trajectory.frame_count * 2 * 7);
    }

    #[test]
    fn trajectory_stride_thins_frames() {
        let slab = cube(1, "IfcSlab", [0.0, 0.0, 0.05], [4.0, 4.0, 0.1]);
        let result = simulate(
            &[slab],
            &SimulateOptions {
                duration_seconds: 0.5,
                capture_trajectory: true,
                trajectory_stride: 5,
                ..Default::default()
            },
        );
        let trajectory = result.trajectory.expect("trajectory captured");
        // 30 / 5 = 6 stride frames + 1 initial = 7
        assert!(trajectory.frame_count <= 8);
        assert!(trajectory.frame_count >= 6);
    }

    #[test]
    fn y_up_gravity_anchors_floor_slab_correctly() {
        // Same scene as `floor_anchors_via_ifc_type`, but rotated so Y is up.
        // The slab's underside is at Y=0; the column rests on it from above.
        // With gravity along -Y, the engine should anchor the slab and keep
        // the column stable — not let it fall sideways.
        let slab = cube(1, "IfcSlab", [0.0, 0.05, 0.0], [4.0, 0.1, 4.0]);
        let column = cube(2, "IfcColumn", [0.0, 1.6, 0.0], [0.3, 3.0, 0.3]);
        let result = simulate(
            &[slab, column],
            &SimulateOptions {
                duration_seconds: 1.0,
                gravity: [0.0, -9.81, 0.0],
                ..Default::default()
            },
        );
        assert!(
            result.anchored.contains(&1),
            "slab should be anchored under Y-down gravity; got anchored={:?}",
            result.anchored,
        );
        assert!(
            result.stable.contains(&2),
            "column should be stable on anchored slab; got falling={:?} tilted={:?}",
            result.falling,
            result.tilted,
        );
    }

    #[test]
    fn opening_and_space_meshes_are_excluded_by_default() {
        let slab = cube(1, "IfcSlab", [0.0, 0.0, 0.05], [4.0, 4.0, 0.1]);
        let opening = cube(2, "IfcOpeningElement", [1.0, 0.0, 1.0], [0.3, 0.3, 0.3]);
        let space = cube(3, "IfcSpace", [0.0, 0.0, 1.5], [3.0, 3.0, 3.0]);
        let result = simulate(
            &[slab, opening, space],
            &SimulateOptions {
                duration_seconds: 0.5,
                ..Default::default()
            },
        );
        assert!(!result.bodies.iter().any(|b| b.express_id == 2));
        assert!(!result.bodies.iter().any(|b| b.express_id == 3));
        assert!(result.bodies.iter().any(|b| b.express_id == 1));
    }

    #[test]
    fn empty_meshes_are_skipped() {
        let empty = PhysicsMesh {
            express_id: 99,
            ifc_type: "IfcWall".to_string(),
            positions: vec![],
            indices: vec![],
        };
        let result = simulate(&[empty], &SimulateOptions::default());
        assert!(result.bodies.is_empty());
    }
}
