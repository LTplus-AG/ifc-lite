// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Public input/output types for the physics crate.
//!
//! These intentionally mirror the shape of `MeshData` from `ifc-lite-processing`
//! without depending on it, so the physics crate stays a self-contained leaf
//! that can be reused outside the IFClite engine pipeline.

use serde::{Deserialize, Serialize};

/// Single mesh fed to the physics world. Coordinates are IFC convention (Z-up, meters).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhysicsMesh {
    pub express_id: u32,
    pub ifc_type: String,
    /// Vertex positions as flat `[x, y, z, x, y, z, ...]` triplets.
    pub positions: Vec<f32>,
    /// Triangle indices as flat `[a, b, c, a, b, c, ...]` triplets.
    pub indices: Vec<u32>,
}

impl PhysicsMesh {
    pub fn vertex_count(&self) -> usize {
        self.positions.len() / 3
    }

    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }

    pub fn is_empty(&self) -> bool {
        self.positions.is_empty() || self.indices.is_empty()
    }

    /// AABB in world coordinates. Returns `None` if the mesh is empty.
    pub fn aabb(&self) -> Option<Aabb> {
        if self.is_empty() {
            return None;
        }
        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for v in self.positions.chunks_exact(3) {
            for i in 0..3 {
                if v[i] < min[i] {
                    min[i] = v[i];
                }
                if v[i] > max[i] {
                    max[i] = v[i];
                }
            }
        }
        Some(Aabb { min, max })
    }
}

/// Axis-aligned bounding box. Z is up.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Aabb {
    pub min: [f32; 3],
    pub max: [f32; 3],
}

impl Aabb {
    pub fn center(&self) -> [f32; 3] {
        [
            0.5 * (self.min[0] + self.max[0]),
            0.5 * (self.min[1] + self.max[1]),
            0.5 * (self.min[2] + self.max[2]),
        ]
    }

    pub fn size(&self) -> [f32; 3] {
        [
            self.max[0] - self.min[0],
            self.max[1] - self.min[1],
            self.max[2] - self.min[2],
        ]
    }

    pub fn volume(&self) -> f32 {
        let s = self.size();
        s[0].max(0.0) * s[1].max(0.0) * s[2].max(0.0)
    }

    pub fn touches(&self, other: &Aabb, eps: f32) -> bool {
        self.min[0] - eps <= other.max[0]
            && self.max[0] + eps >= other.min[0]
            && self.min[1] - eps <= other.max[1]
            && self.max[1] + eps >= other.min[1]
            && self.min[2] - eps <= other.max[2]
            && self.max[2] + eps >= other.min[2]
    }
}

/// How an entity was anchored when the world was built.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum AnchorReason {
    /// Marked anchored explicitly by the caller.
    Explicit,
    /// IFC type heuristic (footing, ground-contacting slab, foundation).
    IfcType,
    /// Lowest element in the model — keeps the world from sinking when no
    /// other anchor heuristic matched.
    LowestElement,
}

/// Collider shape strategy. Different IFC element types respond best to
/// different shape representations:
/// - `Trimesh` is exact but slow and contact-unstable for thin elements.
/// - `ConvexHull` is dramatically faster and more stable, but loses concavity
///   (holes in slabs, web cutouts in I-beams).
/// - `Auto` picks per IFC type — convex for column/beam/member/footing/pile,
///   trimesh for slab/wall/roof/stair (which routinely have openings).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ColliderStrategy {
    Auto,
    Trimesh,
    ConvexHull,
}

impl Default for ColliderStrategy {
    fn default() -> Self {
        Self::Auto
    }
}

/// Final classification of a body after simulation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum Stability {
    /// Either explicitly anchored or barely moved during the simulation.
    Stable,
    /// Stayed in place but rotated noticeably — e.g. tipped beam.
    Tilted,
    /// Translated downward beyond the displacement threshold.
    Falling,
    /// Element was removed and is therefore not part of the result.
    Removed,
}

/// Caller-supplied options for a single simulation run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimulateOptions {
    /// Express IDs to delete from the world before stepping.
    pub remove: Vec<u32>,

    /// Express IDs to keep fixed regardless of inferred anchoring.
    pub anchor: Vec<u32>,

    /// Pre-computed connection pairs (e.g. from `IfcRelConnectsElements`,
    /// `IfcRelConnectsPathElements`, or `IfcRelConnectsStructuralMember`).
    /// Each pair becomes a fixed joint, in addition to whatever AABB-touch
    /// inference produces. Order within a pair doesn't matter; duplicates
    /// against the AABB pass are deduplicated. Pairs referencing express
    /// IDs that aren't in `meshes` are silently skipped.
    pub connections: Vec<[u32; 2]>,

    /// Gravity in m/s² (IFC Z-up). Default: `(0, 0, -9.81)`.
    pub gravity: [f32; 3],

    /// Total simulated time in seconds. Default: `3.0`.
    pub duration_seconds: f32,

    /// Per-step time delta. Default: `1.0 / 60.0`.
    pub time_step: f32,

    /// AABB-touch tolerance for joint inference, in meters. Default: `0.05`.
    pub adjacency_tolerance: f32,

    /// Vertical displacement (meters) above which a body is classified `Falling`.
    /// Default: `0.20`.
    pub fall_threshold: f32,

    /// Angular displacement (radians) above which a body that did not fall is
    /// classified `Tilted`. Default: `0.05` rad ≈ 2.9°.
    pub tilt_threshold: f32,

    /// Treat any element whose AABB minimum Z lies within this distance of the
    /// global model floor as anchored. Default: `0.05` m.
    pub ground_anchor_tolerance: f32,

    /// IFC types to treat as anchors regardless of position.
    pub anchor_ifc_types: Vec<String>,

    /// IFC types to skip entirely. Defaults to abstract volumes that
    /// overlap their physical hosts (`IfcOpeningElement`, `IfcSpace`,
    /// `IfcZone`, `IfcVirtualElement`).
    pub exclude_ifc_types: Vec<String>,

    /// How to convert each mesh into a collider shape.
    pub collider_strategy: ColliderStrategy,

    /// If true, record per-frame body poses so the caller can play back
    /// the simulation as an animation.
    pub capture_trajectory: bool,

    /// Sample every Nth step for the trajectory. Default 1 (every step).
    pub trajectory_stride: usize,
}

/// Per-frame body poses, indexed `frame * body_count * 7 + body_index * 7`.
/// Each pose: translation (x, y, z) then rotation quaternion (x, y, z, w).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimulationTrajectory {
    pub frame_count: usize,
    pub frame_dt: f32,
    pub body_order: Vec<u32>,
    pub poses: Vec<f32>,
}

impl Default for SimulateOptions {
    fn default() -> Self {
        Self {
            remove: Vec::new(),
            anchor: Vec::new(),
            connections: Vec::new(),
            gravity: [0.0, 0.0, -9.81],
            duration_seconds: 3.0,
            time_step: 1.0 / 60.0,
            adjacency_tolerance: 0.05,
            fall_threshold: 0.20,
            tilt_threshold: 0.05,
            ground_anchor_tolerance: 0.05,
            anchor_ifc_types: vec![
                "IfcFooting".to_string(),
                "IfcPile".to_string(),
                "IfcFoundation".to_string(),
            ],
            exclude_ifc_types: vec![
                "IfcOpeningElement".to_string(),
                "IfcSpace".to_string(),
                "IfcZone".to_string(),
                "IfcVirtualElement".to_string(),
            ],
            collider_strategy: ColliderStrategy::Auto,
            capture_trajectory: false,
            trajectory_stride: 1,
        }
    }
}

/// Per-body simulation outcome.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BodyOutcome {
    pub express_id: u32,
    pub ifc_type: String,
    pub stability: Stability,
    pub anchored: bool,
    pub anchor_reason: Option<AnchorReason>,
    /// Translation magnitude from start to end position, in meters.
    pub displacement: f32,
    /// Vertical (Z) displacement, signed. Negative = fell.
    pub vertical_displacement: f32,
    /// Final angular displacement in radians (rotation magnitude relative to start).
    pub angular_displacement: f32,
}

/// Aggregate simulation result. Stable, falling, and tilted are sorted by ID.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimulationResult {
    pub bodies: Vec<BodyOutcome>,
    pub removed: Vec<u32>,
    pub stable: Vec<u32>,
    pub falling: Vec<u32>,
    pub tilted: Vec<u32>,
    pub anchored: Vec<u32>,
    /// Connection graph used for joint inference: pairs of express IDs whose
    /// AABBs touched within `adjacency_tolerance` and were welded together.
    pub joints: Vec<(u32, u32)>,
    /// Per-frame poses, present only when `capture_trajectory` was set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trajectory: Option<SimulationTrajectory>,
}
