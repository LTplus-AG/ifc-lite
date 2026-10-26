// SPDX-License-Identifier: MPL-2.0
//! A physical nonrigid occurrence owns a new operation definition.
use super::*;
use super::value_error::ValueError;
impl LogicalRetainedValue {
    pub(in crate::program) fn bake(&mut self) -> Result<Option<RetainedPlanOperation>, ValueError> {
        self.validate_identity()?;
        let matrix = nalgebra::Matrix4::from_column_slice(&self.object_frame);
        validate_affine(&matrix)?;
        if proper_rigid(&matrix).is_ok() { return Ok(None); }
        crate::resource::charge(crate::resource::Cost { work: 1, occurrences: 1, ..Default::default() })?.retain();
        let input = self.try_copy()?;
        let outcome = outcome::new()?;
        self.slot = next_slot(self.slot.program)?;
        self.outcome = outcome;
        self.definition = LogicalRetainedDefinition::Operation(self.slot);
        self.object_frame = crate::math::mat4::col_major_array(&nalgebra::Matrix4::identity());
        Ok(Some(RetainedPlanOperation { value: self.try_copy()?,
            kind: RetainedOperationKind::Affine { input, matrix: crate::math::mat4::col_major_array(&matrix) } }))
    }
}
