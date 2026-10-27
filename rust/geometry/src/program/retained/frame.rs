// SPDX-License-Identifier: MPL-2.0
//! Pure frame checks return facts; only rejecting controllers record them.
use super::*;
use super::value_error::{ValueError, ValueReason};

impl LogicalRetainedValue {
    pub(in crate::program) fn place_in_place(
        &mut self,
        transform: &nalgebra::Matrix4<f64>,
        program: u64,
        stage: RetainedPlacementStage,
    ) -> Result<(), ValueError> {
        self.validate_identity()?;
        if program != self.slot.program {
            return Err(ValueReason::PlacementDomain.into());
        }
        validate_affine(transform)?;
        if matches!(stage, RetainedPlacementStage::Product { .. }) { proper_rigid(transform)?; }
        let matrix = crate::math::mat4::col_major_array(transform);
        // Finite inputs need not compose to a finite frame. Compute both
        // candidates before changing the occurrence or its placement lineage.
        let (world_from_source, object_frame) =
            if matches!(self.definition, LogicalRetainedDefinition::Source { .. }) {
                let world = compose_frame(&matrix, &self.world_from_source)?;
                let object = compose_frame(&world, &self.source_from_evaluation)?;
                (world, object)
            } else {
                (self.world_from_source, compose_frame(&matrix, &self.object_frame)?)
            };
        validate_affine(&nalgebra::Matrix4::from_column_slice(&object_frame))?;
        crate::resource::charge(crate::resource::Cost {
            work: 1,
            occurrences: 1,
            ..Default::default()
        })?
        .retain();
        crate::resource::reserve_headers(&mut self.placements, 1)?.retain();
        let input = self.slot;
        let output = next_slot(program)?;
        self.world_from_source = world_from_source;
        self.object_frame = object_frame;
        self.slot = output;
        self.placements.push(RetainedPlacement {
            input,
            output: self.slot,
            stage,
            matrix,
        });
        self.product_placed |= matches!(stage, RetainedPlacementStage::Product { .. });
        Ok(())
    }

}

// Transpose the existing row-major primitive to column-major operands. This
// preserves its ordered f64 accumulation and avoids inverse-frame round trips.
pub(super) fn compose_frame(a: &[f64; 16], b: &[f64; 16]) -> Result<[f64; 16], ValueReason> {
    let composed = crate::math::mat4::mul(b, a);
    if composed.iter().any(|value| !value.is_finite()) {
        return Err(ValueReason::NonfiniteComposition);
    }
    Ok(composed)
}
pub(in crate::program) fn validate_affine(matrix: &nalgebra::Matrix4<f64>) -> Result<(), ValueReason> {
    // Fail closed if f64 cannot establish nonsingularity. Keep the original
    // determinant evaluation and predicate order, including overflow refusal.
    let determinant = matrix.fixed_view::<3, 3>(0, 0).determinant();
    if matrix.iter().any(|x| !x.is_finite()) {
        return Err(ValueReason::NonfiniteFrame);
    }
    if matrix.row(3).iter().zip([0., 0., 0., 1.]).any(|(a, b)| *a != b) {
        return Err(ValueReason::NonAffineFrame);
    }
    if !determinant.is_finite() { return Err(ValueReason::NonfiniteDeterminant); }
    if determinant == 0. { return Err(ValueReason::SingularFrame); }
    Ok(())
}

/// A negative classifier result is not a committed controller refusal.
pub(in crate::program) fn proper_rigid(matrix: &nalgebra::Matrix4<f64>) -> Result<(), ValueReason> {
    let linear = matrix.fixed_view::<3, 3>(0, 0);
    // Both residuals are dimensionless. Preserve the whole Gram-matrix norm,
    // determinant residual, original order and retained source rounding budget.
    let rounding = crate::math::tol::RETAINED_RIGID_DOT_EPS;
    if matrix.iter().any(|v| !v.is_finite()) {
        return Err(ValueReason::NonfiniteRigidFrame);
    }
    if matrix.row(3).iter().zip([0., 0., 0., 1.]).any(|(a, b)| *a != b) {
        return Err(ValueReason::NonAffineRigidFrame);
    }
    if (linear.transpose() * linear - nalgebra::Matrix3::identity()).norm() > rounding {
        return Err(ValueReason::NonrigidGram);
    }
    if (linear.determinant() - 1.).abs() > rounding {
        return Err(ValueReason::ImproperRotation);
    }
    Ok(())
}
