// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Build a Rapier world from `PhysicsMesh` inputs.
//!
//! Strategy:
//! - Each non-empty mesh becomes one rigid body whose translation is the AABB
//!   center, with vertices recentered around the origin so the trimesh
//!   collider sits at the body's local origin.
//! - Anchored elements get [`RigidBodyType::Fixed`]; everything else is
//!   [`RigidBodyType::Dynamic`].
//! - Mass is inferred from a per-IFC-type density × the trimesh volume Rapier
//!   computes from the mesh.
//! - Pairs of bodies whose AABBs touch within `adjacency_tolerance` are
//!   welded with a fixed joint. Deliberate over-approximation — see notes.

use rapier3d::prelude::*;
use rustc_hash::{FxHashMap, FxHashSet};

use crate::types::{Aabb, AnchorReason, ColliderStrategy, PhysicsMesh, SimulateOptions};

pub(crate) struct BodyEntry {
    pub express_id: u32,
    pub ifc_type: String,
    pub handle: RigidBodyHandle,
    pub anchored: bool,
    pub anchor_reason: Option<AnchorReason>,
    pub start_translation: Vector,
    pub start_rotation: Rotation,
}

pub(crate) struct WorldBuild {
    pub bodies: RigidBodySet,
    pub colliders: ColliderSet,
    pub joints: ImpulseJointSet,
    pub multibody_joints: MultibodyJointSet,
    pub entries: Vec<BodyEntry>,
    pub joint_pairs: Vec<(u32, u32)>,
}

pub(crate) fn build_world(meshes: &[PhysicsMesh], options: &SimulateOptions) -> WorldBuild {
    let mut bodies = RigidBodySet::new();
    let mut colliders = ColliderSet::new();
    let multibody_joints = MultibodyJointSet::new();

    let removed: FxHashSet<u32> = options.remove.iter().copied().collect();
    let explicit_anchors: FxHashSet<u32> = options.anchor.iter().copied().collect();
    let anchor_types: FxHashSet<&str> = options
        .anchor_ifc_types
        .iter()
        .map(String::as_str)
        .collect();

    let model_floor = compute_model_floor(meshes);

    let mut entries: Vec<BodyEntry> = Vec::with_capacity(meshes.len());
    let mut aabbs: FxHashMap<u32, Aabb> = FxHashMap::default();
    let mut handle_for: FxHashMap<u32, RigidBodyHandle> = FxHashMap::default();
    let mut lowest_with_no_anchor: Option<(u32, f32)> = None;

    for mesh in meshes {
        if mesh.is_empty() || removed.contains(&mesh.express_id) {
            continue;
        }
        let Some(aabb) = mesh.aabb() else {
            continue;
        };

        let anchor_reason = classify_anchor(
            mesh.express_id,
            &mesh.ifc_type,
            &aabb,
            model_floor,
            options.ground_anchor_tolerance,
            &explicit_anchors,
            &anchor_types,
        );
        let anchored = anchor_reason.is_some();

        let center = aabb.center();
        let translation = Vector::new(center[0], center[1], center[2]);

        let body = if anchored {
            RigidBodyBuilder::fixed().translation(translation).build()
        } else {
            RigidBodyBuilder::dynamic()
                .translation(translation)
                .ccd_enabled(true)
                .build()
        };

        let start_translation = body.translation();
        let start_rotation = *body.rotation();
        let handle = bodies.insert(body);

        if let Some(collider) = build_collider(mesh, &center, &mesh.ifc_type, options.collider_strategy) {
            colliders.insert_with_parent(collider, handle, &mut bodies);
        }

        entries.push(BodyEntry {
            express_id: mesh.express_id,
            ifc_type: mesh.ifc_type.clone(),
            handle,
            anchored,
            anchor_reason,
            start_translation,
            start_rotation,
        });
        aabbs.insert(mesh.express_id, aabb);
        handle_for.insert(mesh.express_id, handle);

        if !anchored {
            match lowest_with_no_anchor {
                Some((_, current_min_z)) if aabb.min[2] >= current_min_z => {}
                _ => lowest_with_no_anchor = Some((mesh.express_id, aabb.min[2])),
            }
        }
    }

    if !entries.iter().any(|e| e.anchored) {
        if let Some((id, _)) = lowest_with_no_anchor {
            if let Some(entry) = entries.iter_mut().find(|e| e.express_id == id) {
                if let Some(body) = bodies.get_mut(entry.handle) {
                    body.set_body_type(RigidBodyType::Fixed, true);
                }
                entry.anchored = true;
                entry.anchor_reason = Some(AnchorReason::LowestElement);
            }
        }
    }

    let mut joint_set = ImpulseJointSet::new();
    let joint_pairs = compute_joints(&aabbs, options.adjacency_tolerance, &options.connections);
    for &(a, b) in &joint_pairs {
        let (Some(&ha), Some(&hb)) = (handle_for.get(&a), handle_for.get(&b)) else {
            continue;
        };
        // Preserve the bodies' current relative pose. A default fixed joint
        // would glue both origins to coincide and yank far-apart bodies
        // together, which is wrong for IFC elements that are connected by
        // some load path but not co-located in space.
        let body_a = bodies.get(ha).expect("inserted above");
        let body_b = bodies.get(hb).expect("inserted above");
        let pos_a = body_a.translation();
        let pos_b = body_b.translation();
        let offset = Vector::new(pos_a.x - pos_b.x, pos_a.y - pos_b.y, pos_a.z - pos_b.z);
        let builder = FixedJointBuilder::new()
            .local_anchor1(Vector::new(0.0, 0.0, 0.0))
            .local_anchor2(offset);
        joint_set.insert(ha, hb, builder, true);
    }

    WorldBuild {
        bodies,
        colliders,
        joints: joint_set,
        multibody_joints,
        entries,
        joint_pairs,
    }
}

fn compute_model_floor(meshes: &[PhysicsMesh]) -> f32 {
    let mut floor = f32::INFINITY;
    for mesh in meshes {
        if let Some(aabb) = mesh.aabb() {
            if aabb.min[2] < floor {
                floor = aabb.min[2];
            }
        }
    }
    if floor.is_finite() {
        floor
    } else {
        0.0
    }
}

fn classify_anchor(
    express_id: u32,
    ifc_type: &str,
    aabb: &Aabb,
    model_floor: f32,
    ground_tolerance: f32,
    explicit: &FxHashSet<u32>,
    anchor_types: &FxHashSet<&str>,
) -> Option<AnchorReason> {
    if explicit.contains(&express_id) {
        return Some(AnchorReason::Explicit);
    }
    if anchor_types.contains(ifc_type) {
        return Some(AnchorReason::IfcType);
    }
    let touches_ground = (aabb.min[2] - model_floor).abs() <= ground_tolerance;
    if touches_ground
        && matches!(ifc_type, "IfcSlab" | "IfcFooting" | "IfcPile" | "IfcFoundation")
    {
        return Some(AnchorReason::IfcType);
    }
    None
}

fn build_collider(
    mesh: &PhysicsMesh,
    center: &[f32; 3],
    ifc_type: &str,
    strategy: ColliderStrategy,
) -> Option<Collider> {
    let mut vertices: Vec<Vector> = Vec::with_capacity(mesh.vertex_count());
    for v in mesh.positions.chunks_exact(3) {
        vertices.push(Vector::new(v[0] - center[0], v[1] - center[1], v[2] - center[2]));
    }
    if vertices.is_empty() {
        return None;
    }
    let mut tris: Vec<[u32; 3]> = Vec::with_capacity(mesh.triangle_count());
    let vert_count = vertices.len() as u32;
    for t in mesh.indices.chunks_exact(3) {
        if t[0] < vert_count
            && t[1] < vert_count
            && t[2] < vert_count
            && t[0] != t[1]
            && t[1] != t[2]
            && t[0] != t[2]
        {
            tris.push([t[0], t[1], t[2]]);
        }
    }
    if tris.is_empty() {
        return None;
    }

    let density = density_for(ifc_type);
    let resolved = resolve_strategy(strategy, ifc_type);

    if matches!(resolved, ColliderStrategy::ConvexHull) {
        if let Some(builder) = ColliderBuilder::convex_hull(&vertices) {
            return Some(builder.density(density).build());
        }
        // convex hull rejects degenerate / coplanar inputs — fall through to
        // trimesh rather than dropping the body silently.
    }

    let builder = ColliderBuilder::trimesh(vertices, tris).ok()?.density(density);
    Some(builder.build())
}

/// Pick a concrete strategy when the caller asked for `Auto`. Convex-hull
/// approximations are great for elements whose IFC representation is plausibly
/// convex (columns, beams, footings) and a poor fit for elements that
/// routinely carry openings or holes (slabs, walls, roofs).
fn resolve_strategy(strategy: ColliderStrategy, ifc_type: &str) -> ColliderStrategy {
    match strategy {
        ColliderStrategy::Trimesh => ColliderStrategy::Trimesh,
        ColliderStrategy::ConvexHull => ColliderStrategy::ConvexHull,
        ColliderStrategy::Auto => match ifc_type {
            "IfcColumn"
            | "IfcBeam"
            | "IfcMember"
            | "IfcFooting"
            | "IfcPile"
            | "IfcPlate" => ColliderStrategy::ConvexHull,
            _ => ColliderStrategy::Trimesh,
        },
    }
}

/// Crude per-IFC-type density in kg/m³. Used because IFC files rarely carry
/// material density on the geometry side; the engine layer can override.
fn density_for(ifc_type: &str) -> f32 {
    match ifc_type {
        "IfcSlab" | "IfcWall" | "IfcWallStandardCase" | "IfcColumn" | "IfcBeam" | "IfcFooting"
        | "IfcPile" | "IfcFoundation" | "IfcStair" | "IfcRamp" | "IfcRoof" => 2400.0,
        "IfcMember" | "IfcPlate" => 7850.0,
        "IfcWindow" | "IfcDoor" | "IfcRailing" => 700.0,
        "IfcCovering" => 1500.0,
        _ => 1500.0,
    }
}

/// Compute the union of AABB-touch joints and caller-supplied connections.
///
/// Caller-supplied pairs are typically derived from IFC relationships
/// (`IfcRelConnectsElements`, `IfcRelConnectsPathElements`,
/// `IfcRelConnectsStructuralMember`). They take precedence in the sense
/// that the resulting joint list has no duplicates — order is normalized
/// so `(a, b)` and `(b, a)` collapse.
fn compute_joints(
    aabbs: &FxHashMap<u32, Aabb>,
    eps: f32,
    explicit: &[[u32; 2]],
) -> Vec<(u32, u32)> {
    let mut seen: rustc_hash::FxHashSet<(u32, u32)> = rustc_hash::FxHashSet::default();
    let mut pairs: Vec<(u32, u32)> = Vec::new();

    let normalize = |a: u32, b: u32| -> Option<(u32, u32)> {
        if a == b {
            None
        } else if a < b {
            Some((a, b))
        } else {
            Some((b, a))
        }
    };

    for pair in explicit {
        let Some(p) = normalize(pair[0], pair[1]) else {
            continue;
        };
        if !aabbs.contains_key(&p.0) || !aabbs.contains_key(&p.1) {
            continue;
        }
        if seen.insert(p) {
            pairs.push(p);
        }
    }

    let mut sorted: Vec<(u32, Aabb)> = aabbs.iter().map(|(id, b)| (*id, *b)).collect();
    sorted.sort_by_key(|(id, _)| *id);

    for i in 0..sorted.len() {
        let (id_a, a) = sorted[i];
        for j in (i + 1)..sorted.len() {
            let (id_b, b) = sorted[j];
            if !a.touches(&b, eps) {
                continue;
            }
            let Some(p) = normalize(id_a, id_b) else {
                continue;
            };
            if seen.insert(p) {
                pairs.push(p);
            }
        }
    }

    pairs
}
