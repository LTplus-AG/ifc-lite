// SPDX-License-Identifier: MPL-2.0
//! Placement admission preserves each occurrence and orders physical bakes.
use super::*;
use crate::program::inner::retained_program::RetainedProgramError;
impl MappingControl<'_> {
    pub(super) fn admit_retained_affine(&mut self)
        -> std::result::Result<(MappingReply, Vec<crate::program::retained::RetainedPlanOperation>), RetainedProgramError> {
        let mut reply = match std::mem::replace(&mut self.action, Action::Taken) {
            Action::Place(Place { parts: Placing::Retained(values), item_id, source_id, transform, .. }) =>
                Self::place_retained_mapping(item_id, source_id, transform, *values),
            Action::TypeFinish(origin) => self.finish_retained_type_map(origin)?,
            other => { self.action = other; return Err(RetainedProgramError::StaleRequest); }
        };
        let values = match &mut reply {
            MappingReply::RetainedPlaced { value, .. } | MappingReply::RetainedTypeFinished(value) => value,
            _ => return Err(RetainedProgramError::WrongPayload),
        };
        let mut operations = Vec::new();
        if let Ok(values) = values {
            crate::resource::reserve_headers(&mut operations, values.len())
                .map_err(RetainedProgramError::Stopped)?.retain();
            for value in values {
                match value.bake() {
                    Ok(Some(operation)) => operations.push(operation),
                    Ok(None) => {}
                    Err(crate::Error::ProgramStopped(stop)) => return Err(RetainedProgramError::Stopped(stop)),
                    Err(error) => return Ok((match reply {
                        MappingReply::RetainedPlaced { item_id, .. } => MappingReply::RetainedPlaced { item_id, value: Err(error) },
                        _ => MappingReply::RetainedTypeFinished(Err(error)),
                    }, Vec::new())),
                }
            }
        }
        Ok((reply, operations))
    }
}
