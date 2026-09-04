// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! CSG primitive processors.
//!
//! Handles `IfcCsgSolid` (the solid-model wrapper around a CSG tree) and the
//! `IfcCsgPrimitive3D` subtypes that can sit at the leaves of that tree.
//! `IfcBlock` is here; `IfcSphere` lives in the `sphere` sibling. The rest
//! (`IfcRectangularPyramid`, `IfcRightCircularCone`, `IfcRightCircularCylinder`)
//! are not yet implemented.

use super::boolean::OperandPath;
use crate::extrusion::apply_transform;
use crate::{Error, Mesh, Result, TessellationQuality, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::Point3;

use super::boolean::BooleanClippingProcessor;
use super::sphere::SphereProcessor;
use super::helpers::parse_axis2_placement_3d;
use crate::router::GeometryProcessor;

/// `IfcBlock` — axis-aligned box CSG primitive.
///
/// Attributes (inherits `IfcCsgPrimitive3D` → Position):
///   0: Position (`IfcAxis2Placement3D`)
///   1: XLength
///   2: YLength
///   3: ZLength
///
/// The block occupies `(0,0,0) .. (XLength, YLength, ZLength)` in the local
/// placement frame, then is transformed by Position into the enclosing CSG
/// tree's coordinate system.
pub struct BlockProcessor;

impl BlockProcessor {
    pub fn new() -> Self {
        Self
    }
}

impl Default for BlockProcessor {
    fn default() -> Self {
        Self::new()
    }
}

impl GeometryProcessor for BlockProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        _quality: TessellationQuality,
    ) -> Result<Mesh> {
        let x = entity
            .get_float(1)
            .ok_or_else(|| Error::geometry("IfcBlock missing XLength".to_string()))?;
        let y = entity
            .get_float(2)
            .ok_or_else(|| Error::geometry("IfcBlock missing YLength".to_string()))?;
        let z = entity
            .get_float(3)
            .ok_or_else(|| Error::geometry("IfcBlock missing ZLength".to_string()))?;

        if !(x.is_finite() && y.is_finite() && z.is_finite() && x > 0.0 && y > 0.0 && z > 0.0) {
            return Err(Error::geometry(format!(
                "IfcBlock requires finite positive lengths, got ({}, {}, {})",
                x, y, z
            )));
        }

        let mut mesh = build_axis_aligned_box(x, y, z);

        if let Some(pos_attr) = entity.get(0) {
            if !pos_attr.is_null() {
                if let Some(pos_entity) = decoder.resolve_ref(pos_attr)? {
                    if pos_entity.ifc_type == IfcType::IfcAxis2Placement3D {
                        let transform = parse_axis2_placement_3d(&pos_entity, decoder)?;
                        apply_transform(&mut mesh, &transform);
                    }
                }
            }
        }

        Ok(mesh)
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcBlock]
    }
}

/// `IfcCsgSolid` — wraps a CSG tree (`TreeRootExpression`, an `IfcCsgSelect`).
///
/// Attribute 0 (`TreeRootExpression`) is either an `IfcBooleanResult` /
/// `IfcBooleanClippingResult` or an `IfcCsgPrimitive3D`. This processor
/// resolves the reference and dispatches it to the matching leaf processor,
/// so callers don't need to know that the geometry was wrapped.
pub struct CsgSolidProcessor {
    /// Per-build small-cut skip, forwarded to the nested
    /// [`BooleanClippingProcessor`] this wraps so a CSG tree shares one scoped
    /// value (see `BooleanClippingProcessor::skip_small_cuts`).
    skip_small_cuts: bool,
}

impl CsgSolidProcessor {
    pub fn new() -> Self {
        Self::with_skip_small_cuts(false)
    }

    /// Construct with the per-build small-cut skip forwarded to the boolean
    /// processor at the root of the wrapped CSG tree.
    pub fn with_skip_small_cuts(skip_small_cuts: bool) -> Self {
        Self { skip_small_cuts }
    }
}

impl Default for CsgSolidProcessor {
    fn default() -> Self {
        Self::new()
    }
}

impl CsgSolidProcessor {
    /// Like [`GeometryProcessor::process`], but carrying the caller's boolean
    /// recursion depth and path-scoped visited set across the hop.
    ///
    /// `IfcCsgSolid.TreeRootExpression` may be an `IfcBooleanResult` whose
    /// operands may be `IfcCsgSolid`, so the two are mutually recursive over
    /// file-supplied references. Entering through `process()` built a FRESH
    /// `BooleanClippingProcessor`, resetting both, so three entities recursed
    /// forever with depth never passing 1 — and a stack overflow ABORTS in
    /// Rust, so nothing could turn it into a load error (#2866).
    ///
    /// The CSG id is inserted too, path-scoped like the boolean side, so
    /// `visited.len()` is an honest frame count. An earlier revision omitted
    /// it because deleting either insert left every test green — which meant
    /// neither was PINNED, not that one was redundant
    /// (`the_path_bound_counts_csg_frames_too_not_only_booleans` now pins it).
    /// Omitting it also made the `IfcCsgSolid -> IfcCsgSolid` rejection below
    /// load-bearing for stack safety instead of a spec check.
    pub(crate) fn process_with_boolean_cycle_guard(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        depth: u32,
        quality: TessellationQuality,
        visited: &mut OperandPath,
    ) -> Result<Mesh> {
        if !visited.insert(entity.id) {
            return Err(Error::geometry(format!(
                "Cyclic boolean/CSG operand reference at #{}",
                entity.id
            )));
        }
        let out = self.resolve_tree_root(entity, decoder, schema, depth, quality, visited);
        visited.remove(&entity.id);
        out
    }

    /// Shared body of `process` and `process_with_boolean_cycle_guard`.
    fn resolve_tree_root(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        depth: u32,
        quality: TessellationQuality,
        visited: &mut OperandPath,
    ) -> Result<Mesh> {
        let root_attr = entity.get(0).ok_or_else(|| {
            Error::geometry("IfcCsgSolid missing TreeRootExpression".to_string())
        })?;
        let root = decoder.resolve_ref(root_attr)?.ok_or_else(|| {
            Error::geometry("IfcCsgSolid TreeRootExpression unresolved".to_string())
        })?;

        // Per IFC 4.3 (`TreeRootExpression : IfcCsgSelect`), the root must be
        // an `IfcBooleanResult` or an `IfcCsgPrimitive3D`, NEVER another
        // `IfcCsgSolid`. Reject that case explicitly so a malformed (or
        // adversarial) file with a self-reference can't blow the stack on
        // unbounded recursion. That guard is one hop wide; the visited set
        // threaded through the boolean side closes the two-hop
        // CSG -> Boolean -> CSG cycle it cannot see (#2866).
        match root.ifc_type {
            IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult => {
                // This boolean processor is TRANSIENT — built per tree root and
                // dropped on return — so it is not in the router's processor
                // table and `drain_processor_failures` cannot reach it. Hand
                // its log to the thread-local escape hatch, which
                // `take_csg_failures` folds in (#3821); otherwise every
                // diagnostic from a boolean under an `IfcCsgSolid` is lost on
                // the way out, exactly as the router-registered one was.
                let boolean =
                    BooleanClippingProcessor::with_skip_small_cuts(self.skip_small_cuts);
                let out =
                    boolean.process_with_depth(&root, decoder, schema, depth, quality, visited);
                crate::diagnostics::push_pending_mapped_bool_failures(boolean.take_failures());
                out
            }
            IfcType::IfcBlock => BlockProcessor::new().process(&root, decoder, schema, quality),
            IfcType::IfcSphere => SphereProcessor::new().process(&root, decoder, schema, quality),
            IfcType::IfcCsgSolid => Err(Error::geometry(
                "IfcCsgSolid TreeRootExpression must be IfcBooleanResult or \
                 IfcCsgPrimitive3D, not another IfcCsgSolid (spec violation)"
                    .to_string(),
            )),
            other => Err(Error::geometry(format!(
                "Unsupported IfcCsgSolid TreeRootExpression: {}",
                other
            ))),
        }
    }
}

impl GeometryProcessor for CsgSolidProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        // Top-level entry (the router registers this processor directly, so
        // this is the path a file whose Body item IS the IfcCsgSolid takes).
        let mut visited = OperandPath::default();
        self.resolve_tree_root(entity, decoder, schema, 0, quality, &mut visited)
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcCsgSolid]
    }
}

/// Build an axis-aligned box from `(0,0,0)` to `(x, y, z)` with one flat
/// quad per face. Six faces × 4 unique vertices × 2 triangles = 24 verts /
/// 12 tris. Vertices are duplicated per face so per-face normals stay
/// flat-shaded.
fn build_axis_aligned_box(x: f64, y: f64, z: f64) -> Mesh {
    let mut mesh = Mesh::with_capacity(24, 36);

    // Six faces. Each face lists its four corners in CCW order as seen
    // from outside the box, paired with its outward normal.
    let faces: [([Point3<f64>; 4], Vector3<f64>); 6] = [
        // -Z (bottom): viewed from below, CCW is (0,0,0) → (0,y,0) → (x,y,0) → (x,0,0)
        (
            [
                Point3::new(0.0, 0.0, 0.0),
                Point3::new(0.0, y, 0.0),
                Point3::new(x, y, 0.0),
                Point3::new(x, 0.0, 0.0),
            ],
            Vector3::new(0.0, 0.0, -1.0),
        ),
        // +Z (top)
        (
            [
                Point3::new(0.0, 0.0, z),
                Point3::new(x, 0.0, z),
                Point3::new(x, y, z),
                Point3::new(0.0, y, z),
            ],
            Vector3::new(0.0, 0.0, 1.0),
        ),
        // -Y (front)
        (
            [
                Point3::new(0.0, 0.0, 0.0),
                Point3::new(x, 0.0, 0.0),
                Point3::new(x, 0.0, z),
                Point3::new(0.0, 0.0, z),
            ],
            Vector3::new(0.0, -1.0, 0.0),
        ),
        // +Y (back)
        (
            [
                Point3::new(x, y, 0.0),
                Point3::new(0.0, y, 0.0),
                Point3::new(0.0, y, z),
                Point3::new(x, y, z),
            ],
            Vector3::new(0.0, 1.0, 0.0),
        ),
        // -X (left)
        (
            [
                Point3::new(0.0, y, 0.0),
                Point3::new(0.0, 0.0, 0.0),
                Point3::new(0.0, 0.0, z),
                Point3::new(0.0, y, z),
            ],
            Vector3::new(-1.0, 0.0, 0.0),
        ),
        // +X (right)
        (
            [
                Point3::new(x, 0.0, 0.0),
                Point3::new(x, y, 0.0),
                Point3::new(x, y, z),
                Point3::new(x, 0.0, z),
            ],
            Vector3::new(1.0, 0.0, 0.0),
        ),
    ];

    for (corners, normal) in faces {
        let base = (mesh.positions.len() / 3) as u32;
        for p in &corners {
            mesh.add_vertex(*p, normal);
        }
        mesh.add_triangle(base, base + 1, base + 2);
        mesh.add_triangle(base, base + 2, base + 3);
    }

    mesh
}

#[cfg(test)]
#[path = "csg_primitive_tests.rs"]
mod tests;
