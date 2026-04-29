// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Engine-facade entry point for rigid-body what-if simulations.
//!
//! Wraps `ifc-lite-physics` so callers (server, desktop, CLI) can pass the
//! `MeshData` they already have without converting to a third type.
//!
//! See `ifc-lite-physics` for the simulation contract — this module only
//! adapts inputs.

use ifc_lite_physics::{simulate as physics_simulate, PhysicsMesh};
use ifc_lite_processing::MeshData;

pub use ifc_lite_physics::{
    Aabb as PhysicsAabb, AnchorReason, BodyOutcome, SimulateOptions, SimulationResult, Stability,
};

/// Run a rigid-body simulation against the engine's `MeshData` shape.
///
/// `meshes` is consumed read-only; only `express_id`, `ifc_type`, `positions`,
/// and `indices` are read.
pub fn simulate(meshes: &[MeshData], options: &SimulateOptions) -> SimulationResult {
    let physics_meshes: Vec<PhysicsMesh> = meshes
        .iter()
        .filter(|m| !m.is_empty())
        .map(|m| PhysicsMesh {
            express_id: m.express_id,
            ifc_type: m.ifc_type.clone(),
            positions: m.positions.clone(),
            indices: m.indices.clone(),
        })
        .collect();
    physics_simulate(&physics_meshes, options)
}
