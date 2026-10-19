// SPDX-License-Identifier: MPL-2.0
//! Reached leaf admission uses fresh builtins, independently of router overrides.
use super::{BooleanState, Frame, Services, work};
use super::state::VoidsState;
use crate::processors::boolean::{BooleanClippingProcessor,
    brep_voids::{brep_with_voids_shell_kind, plan::{self, ShellKind, ShellPlan, VoidFault},
        void_evaluation}};
use crate::router::builtin_processor;
use crate::{BoolFailureReason, BoolOp, Error, Mesh, Result};
use ifc_lite_core::{DecodedEntity, IfcType};

impl BooleanState {
    pub(super) fn admit_operand(&mut self, operand: DecodedEntity, op: BoolOp,
        services: &mut Services<'_, '_>,
    ) -> Result<()> {
        crate::resource::check_current()?;
        if let Some((contract,program)) = self.retained {
            if operand.ifc_type == IfcType::IfcMappedItem {
                let router=services.router.ok_or_else(||Error::geometry("retained mapped operand requires captured router"))?;
                let child=crate::program::GeometryProgram::retained_mapped(&operand,contract,router,self.retained_cache.clone().expect("retained Boolean cache"))?;
                self.frames.push(Frame::RetainedChild(Box::new(child)));
                return Ok(());
            }
            let scale=match services.router {Some(router)=>router.unit_scale(),None=>services.decoder.length_unit_scale()};
            let operation = crate::program::retained::capture(&operand,services.decoder,scale,contract,program)?;
            self.frames.push(Frame::Numerical(work::Ready::Retained(operation), work::Continuation::RetainedOperand));
            return Ok(());
        }
        match &operand.ifc_type {
            IfcType::IfcCsgSolid | IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult => {
                return Err(Error::geometry("Recursive operand requires continuation dispatch"));
            }
            IfcType::IfcSurfaceOfLinearExtrusion => {}
            other => if let Some(processor) = builtin_processor(other.clone(), &services.recorder.schema) {
                let admitted = processor.lower_owned(&operand, services.decoder, self.quality, None);
                crate::resource::check_current()?;
                let plan = crate::resource::observe(admitted
                    .ok_or_else(|| Error::geometry("Builtin operand has no owned constructor"))?)?;
                self.frames.push(Frame::Numerical(work::Ready::Constructor(plan),
                    work::Continuation::Operand { operand, op }));
                return Ok(());
            },
        }
        services.recorder.record_failure(op, BoolFailureReason::UnsupportedOperand(operand.ifc_type.to_string()));
        self.value = Some((Mesh::new(), true));
        Ok(())
    }
    pub(super) fn begin_voids(&mut self, operand: DecodedEntity, op: BoolOp,
        outer: Mesh, recorder: &BooleanClippingProcessor,
    ) -> Result<()> {
        crate::resource::check_current()?;
        if op != BoolOp::Unknown {
            if let Some(kind) = brep_with_voids_shell_kind(&operand.ifc_type) {
                return self.begin_shells(kind, operand, op, outer, recorder);
            }
        }
        self.value = Some((outer, false));
        Ok(())
    }
    pub(super) fn begin_shells(&mut self, shell_kind: IfcType, operand: DecodedEntity,
        op: BoolOp, outer: Mesh, recorder: &BooleanClippingProcessor,
    ) -> Result<()> {
        crate::resource::check_current()?;
        let Some(voids) = plan::void_refs(&operand) else { self.value = Some((outer, false)); return Ok(()); };
        if voids.is_empty() || outer.is_empty() { self.value = Some((outer, false)); return Ok(()); }
        let Some(kind) = ShellKind::from_type(&shell_kind) else {
            self.value = Some(void_evaluation::refuse_source(recorder, op, &operand.ifc_type,
                VoidFault::NoProcessor.message()));
            return Ok(());
        };
        let meshes = Vec::with_capacity(voids.len());
        let refs = voids.to_vec().into_iter();
        self.frames.push(Frame::VoidsSource(VoidsState { outer, refs, meshes, kind, op,
            operand_type: operand.ifc_type }));
        Ok(())
    }
    pub(super) fn voids_source(&mut self, mut voids: VoidsState,
        services: &mut Services<'_, '_>,
    ) -> Result<()> {
        crate::resource::check_current()?;
        let Some(value) = voids.refs.next() else {
            let units = services.decoder.length_unit_scale();
            crate::resource::check_current()?;
            self.frames.push(Frame::Numerical(work::Ready::Voids(work::Voids {
                ready: void_evaluation::ReadyVoids::new(voids.meshes), outer: voids.outer,
                length_unit_scale: units, op: voids.op, operand_type: voids.operand_type }),
                work::Continuation::Value));
            return Ok(());
        };
        let Some(id) = value.as_entity_ref() else {
            self.value = Some(void_evaluation::refuse_source(services.recorder, voids.op,
                &voids.operand_type, VoidFault::NotReference.message()));
            return Ok(());
        };
        match crate::resource::observe(ShellPlan::lower(id, voids.kind, services.decoder, self.quality)) {
            Ok(plan) => self.frames.push(Frame::Numerical(work::Ready::Shell(plan), work::Continuation::Shell(voids))),
            Err(error @ Error::ProgramStopped(_)) => return Err(error),
            Err(_) => self.refuse_voids(&voids, services.recorder),
        }
        Ok(())
    }
    pub(super) fn refuse_voids(&mut self, voids: &VoidsState, recorder: &BooleanClippingProcessor) {
        self.value = Some(void_evaluation::refuse_source(recorder, voids.op, &voids.operand_type,
            VoidFault::ShellDidNotMesh.message()));
    }
}

// Private compatibility tests drain exactly the same owned transitions.
#[cfg(test)]
pub(crate) fn without_voids(recorder: &BooleanClippingProcessor, shell_kind: IfcType,
    op: BoolOp, operand: &DecodedEntity, outer: Mesh,
    decoder: &mut ifc_lite_core::EntityDecoder, quality: crate::TessellationQuality,
) -> Result<super::Value> {
    let first = Frame::BeginShells { shell_kind, operand: operand.clone(), op, outer };
    super::run(recorder, decoder, &mut Default::default(), quality, first)
}
#[cfg(test)]
impl BooleanClippingProcessor {
    pub(crate) fn process_operand_checked(&self, op: BoolOp, operand: &DecodedEntity,
        decoder: &mut ifc_lite_core::EntityDecoder, quality: crate::TessellationQuality,
    ) -> Result<super::Value> {
        super::run(self, decoder, &mut Default::default(), quality,
            Frame::Operand { entity: operand.clone(), operator: op, depth: 0 })
    }
    pub(crate) fn without_voids(&self, shell_kind: IfcType, op: BoolOp,
        operand: &DecodedEntity, outer: Mesh, decoder: &mut ifc_lite_core::EntityDecoder,
        quality: crate::TessellationQuality,
    ) -> Result<super::Value> {
        without_voids(self, shell_kind, op, operand, outer, decoder, quality)
    }
}
