// SPDX-License-Identifier: MPL-2.0
//! Retained values use the same reached spine and ordered step continuations.
use super::{BooleanState, Frame, Services, Steps, work};
use crate::{BoolOp, Error, Result};
use crate::program::retained::{self, LogicalRetainedValue};
use ifc_lite_core::DecodedEntity;

impl BooleanState {
    pub(super) fn retained_step(&mut self, entity: DecodedEntity, mut steps: Steps,
        services: &mut Services<'_, '_>) -> Result<()> {
        let host=steps.retained.take().expect("retained host");
        let operator=super::boolean_operator(&entity).map_err(|keyword|
            Error::geometry(format!("retained Boolean operator unavailable: {keyword}")))?;
        if !matches!(operator,BoolOp::Difference|BoolOp::Union|BoolOp::Intersection) {
            return Err(Error::geometry("retained Boolean operator unavailable"));
        }
        if host.is_empty() && matches!(operator,BoolOp::Difference|BoolOp::Intersection) {
            steps.retained=Some(host);self.frames.push(Frame::Steps(steps));return Ok(());
        }
        let second=services.recorder.second_operand_or_record(operator,&entity,services.decoder);
        crate::resource::check_current()?;
        let second=second.ok_or_else(||Error::geometry("retained Boolean missing second operand"))?;
        if second.ifc_type.is_subtype_of(ifc_lite_core::IfcType::IfcHalfSpaceSolid) {
            let (contract,program)=self.retained.expect("selected retained contract");
            let scale=match services.router {Some(router)=>router.unit_scale(),None=>services.decoder.length_unit_scale()};
            let context=crate::program::retained_clip::ClipSourceContext {scale,contract,operator,boolean_id:entity.id,program};
            let clip=crate::program::retained_clip::capture(&second,services.decoder,&host,context)?;
            let operation=retained::clip_operation(host,clip,program)?;
            self.frames.push(Frame::Numerical(work::Ready::Retained(operation),work::Continuation::RetainedStep(steps)));
            return Ok(());
        }
        let depth=steps.depth;
        self.frames.push(Frame::RetainedAfterStep {steps,operator,host});
        self.frames.push(Frame::Operand {entity:second,operator,depth});
        Ok(())
    }
    pub(super) fn retained_solid(&mut self, steps: Steps, operator: BoolOp,
        host: LogicalRetainedValue) -> Result<()> {
        use crate::document::BooleanOperation;
        let right=self.retained_value.take().expect("retained second operand");
        let operation=match operator {BoolOp::Difference=>BooleanOperation::Difference,
            BoolOp::Union=>BooleanOperation::Union,BoolOp::Intersection=>BooleanOperation::Intersection,
            _=>return Err(Error::geometry("retained Boolean operator unavailable"))};
        let program=self.retained.expect("selected retained contract").1;
        let operation=retained::boolean_operation([host,right],operation,program)?;
        self.frames.push(Frame::Numerical(work::Ready::Retained(operation),work::Continuation::RetainedStep(steps)));
        Ok(())
    }
}
