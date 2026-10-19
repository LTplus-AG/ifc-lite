// SPDX-License-Identifier: MPL-2.0
//! One reached speculative collector reference, with occurrence-local reports.
use crate::{construction::ConstructionReports, Error, Result};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder};

pub(crate) struct SourceRead {
    pub result: Result<DecodedEntity>,
    pub reports: ConstructionReports,
}
pub(crate) fn read_operand(entity: &DecodedEntity, decoder: &mut EntityDecoder,
    first: bool,
) -> SourceRead {
    let (result, mut reports) = crate::processors::diagnostic_capture::capture(|| {
        let index = if first { slot::IfcBooleanResult::FIRST_OPERAND.index() }
            else { slot::IfcBooleanResult::SECOND_OPERAND.index() };
        let attr = entity.get(index).ok_or_else(|| Error::geometry(if first {
            "BooleanResult missing FirstOperand"
        } else { "BooleanResult missing SecondOperand" }))?;
        decoder.resolve_ref(attr)?.ok_or_else(|| Error::geometry(if first {
            "Failed to resolve FirstOperand"
        } else { "Failed to resolve SecondOperand" }))
    });
    if let Err(Error::CoreError(ifc_lite_core::Error::UnrepresentableReal(id)
        | ifc_lite_core::Error::MalformedRecord(id))) = &result {
        reports.decoder_refused_record_ids.push(*id);
    }
    reports.decoder_refused_record_ids.sort_unstable();
    reports.decoder_refused_record_ids.dedup();
    SourceRead { result, reports }
}
