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
use crate::{BoolFailure, Mesh, Result, TessellationQuality, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::Point3;
use std::cell::RefCell;

use super::boolean::BooleanClippingProcessor;
use crate::router::GeometryProcessor;

#[path = "primitive_plan.rs"]
pub(crate) mod plan;
#[path = "csg_root.rs"]
mod root;
pub(crate) use root::resolve_tree_root;

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

    pub(crate) fn lower(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<plan::BlockPlan> {
        plan::lower_block(entity, decoder)
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
        Ok(self.lower(entity, decoder)?.evaluate())
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
    /// Failures from the TRANSIENT [`BooleanClippingProcessor`] built per
    /// `TreeRootExpression` and dropped on return. Held here so they leave
    /// through [`GeometryProcessor::take_bool_failures`] — i.e. through the
    /// router that owns THIS processor — instead of a thread-local a
    /// different router could drain (#3821).
    failures: RefCell<Vec<BoolFailure>>,
}

impl CsgSolidProcessor {
    pub fn new() -> Self {
        Self::with_skip_small_cuts(false)
    }

    /// Construct with the per-build small-cut skip forwarded to the boolean
    /// processor at the root of the wrapped CSG tree.
    pub fn with_skip_small_cuts(skip_small_cuts: bool) -> Self {
        Self {
            skip_small_cuts,
            failures: RefCell::new(Vec::new()),
        }
    }

    /// Drain failures recorded by canonical continuation execution at this
    /// router-held CSG entry point, including losses retained on errors.
    pub fn take_failures(&self) -> Vec<BoolFailure> {
        std::mem::take(&mut *self.failures.borrow_mut())
    }
}

impl Default for CsgSolidProcessor {
    fn default() -> Self {
        Self::new()
    }
}

impl GeometryProcessor for CsgSolidProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        // Top-level entry (the router registers this processor directly, so
        // this is the path a file whose Body item IS the IfcCsgSolid takes).
        let mut visited = OperandPath::default();
        let boolean = BooleanClippingProcessor::with_skip_small_cuts(self.skip_small_cuts);
        let result = boolean.execute_csg(entity, decoder, 0, quality, &mut visited, false);
        // Drain the transient recorder even when a later continuation failed.
        self.failures.borrow_mut().extend(boolean.take_failures());
        result.map(|(mesh, _)| mesh)
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcCsgSolid]
    }

    fn take_bool_failures(&self) -> Vec<BoolFailure> {
        self.take_failures()
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
