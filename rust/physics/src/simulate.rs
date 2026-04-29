// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Step the physics world for a fixed duration and classify each body.

use rapier3d::prelude::*;

use crate::types::{
    BodyOutcome, PhysicsMesh, SimulateOptions, SimulationResult, SimulationTrajectory, Stability,
};
use crate::world::build_world;

pub fn simulate(meshes: &[PhysicsMesh], options: &SimulateOptions) -> SimulationResult {
    let mut build = build_world(meshes, options);

    let gravity = Vector::new(options.gravity[0], options.gravity[1], options.gravity[2]);

    let dt = options.time_step.max(1.0e-4);
    let mut params = IntegrationParameters::default();
    params.dt = dt;

    let mut physics_pipeline = PhysicsPipeline::new();
    let mut island_manager = IslandManager::new();
    let mut broad_phase = DefaultBroadPhase::new();
    let mut narrow_phase = NarrowPhase::new();
    let mut ccd_solver = CCDSolver::new();
    let physics_hooks = ();
    let event_handler = ();

    // The "down" axis for fall classification is whichever component of
    // gravity is most negative — Z for IFC Z-up data, Y for the viewer's
    // Y-up frame.
    let down_axis = {
        let g = options.gravity;
        let mut idx = 2usize;
        let mut val = g[2];
        if g[0] < val { idx = 0; val = g[0]; }
        if g[1] < val { idx = 1; }
        idx
    };

    let total = options.duration_seconds.max(0.0);
    let steps = (total / dt).ceil() as usize;
    let stride = options.trajectory_stride.max(1);
    let body_count = build.entries.len();
    let mut trajectory_poses: Vec<f32> = if options.capture_trajectory {
        // Pre-allocate: 1 (initial) + steps/stride frames worst-case.
        let estimated_frames = 1 + steps / stride;
        Vec::with_capacity(estimated_frames * body_count * 7)
    } else {
        Vec::new()
    };
    let record_pose =
        |poses: &mut Vec<f32>, bodies: &RigidBodySet, entries: &[crate::world::BodyEntry]| {
            for entry in entries {
                if let Some(body) = bodies.get(entry.handle) {
                    let t = body.translation();
                    let r = body.rotation();
                    poses.extend_from_slice(&[t.x, t.y, t.z, r.x, r.y, r.z, r.w]);
                } else {
                    poses.extend_from_slice(&[0.0; 7]);
                }
            }
        };

    if options.capture_trajectory {
        record_pose(&mut trajectory_poses, &build.bodies, &build.entries);
    }

    for step_index in 0..steps {
        physics_pipeline.step(
            gravity,
            &params,
            &mut island_manager,
            &mut broad_phase,
            &mut narrow_phase,
            &mut build.bodies,
            &mut build.colliders,
            &mut build.joints,
            &mut build.multibody_joints,
            &mut ccd_solver,
            &physics_hooks,
            &event_handler,
        );
        if options.capture_trajectory && (step_index + 1) % stride == 0 {
            record_pose(&mut trajectory_poses, &build.bodies, &build.entries);
        }
    }

    let mut bodies_out: Vec<BodyOutcome> = Vec::with_capacity(build.entries.len());
    let mut stable: Vec<u32> = Vec::new();
    let mut falling: Vec<u32> = Vec::new();
    let mut tilted: Vec<u32> = Vec::new();
    let mut anchored: Vec<u32> = Vec::new();

    for entry in &build.entries {
        let body = match build.bodies.get(entry.handle) {
            Some(b) => b,
            None => continue,
        };
        let translation = body.translation();
        let rotation = *body.rotation();

        let dx = translation.x - entry.start_translation.x;
        let dy = translation.y - entry.start_translation.y;
        let dz = translation.z - entry.start_translation.z;
        let displacement = (dx * dx + dy * dy + dz * dz).sqrt();
        // `vertical` reports motion along the gravity axis with the sign
        // convention that *negative = fell* (matches the docs and the JS
        // sibling). Pull the right component for whichever axis is "up".
        let vertical = match down_axis {
            0 => dx,
            1 => dy,
            _ => dz,
        };

        let delta_rot = rotation * entry.start_rotation.inverse();
        let (_axis, angular_raw) = delta_rot.to_axis_angle();
        let angular = angular_raw.abs();

        let stability = if entry.anchored {
            Stability::Stable
        } else if -vertical > options.fall_threshold || displacement > options.fall_threshold {
            Stability::Falling
        } else if angular > options.tilt_threshold {
            Stability::Tilted
        } else {
            Stability::Stable
        };

        match stability {
            Stability::Stable => stable.push(entry.express_id),
            Stability::Falling => falling.push(entry.express_id),
            Stability::Tilted => tilted.push(entry.express_id),
            Stability::Removed => {}
        }
        if entry.anchored {
            anchored.push(entry.express_id);
        }

        bodies_out.push(BodyOutcome {
            express_id: entry.express_id,
            ifc_type: entry.ifc_type.clone(),
            stability,
            anchored: entry.anchored,
            anchor_reason: entry.anchor_reason,
            displacement,
            vertical_displacement: vertical,
            angular_displacement: angular,
        });
    }

    bodies_out.sort_by_key(|b| b.express_id);
    stable.sort_unstable();
    falling.sort_unstable();
    tilted.sort_unstable();
    anchored.sort_unstable();
    let mut removed_sorted = options.remove.clone();
    removed_sorted.sort_unstable();
    removed_sorted.dedup();

    let trajectory = if options.capture_trajectory {
        let frame_count = if body_count == 0 {
            0
        } else {
            trajectory_poses.len() / (body_count * 7)
        };
        Some(SimulationTrajectory {
            frame_count,
            frame_dt: dt * stride as f32,
            body_order: build.entries.iter().map(|e| e.express_id).collect(),
            poses: trajectory_poses,
        })
    } else {
        None
    };

    SimulationResult {
        bodies: bodies_out,
        removed: removed_sorted,
        stable,
        falling,
        tilted,
        anchored,
        joints: build.joint_pairs,
        trajectory,
    }
}
