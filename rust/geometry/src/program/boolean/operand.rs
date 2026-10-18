// SPDX-License-Identifier: MPL-2.0
//! Reached leaf admission uses fresh builtins, independently of router overrides.
use super::{state::Value, work::{self, Execute}};
use crate::processors::boolean::{BooleanClippingProcessor,
    brep_voids::{brep_with_voids_shell_kind, plan::{self, ShellKind, ShellPlan, VoidFault},
        void_evaluation}};
use crate::router::builtin_processor;
use crate::{BoolFailureReason, BoolOp, Error, Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

pub(crate) fn evaluate(recorder: &BooleanClippingProcessor, op: BoolOp,
    operand: &DecodedEntity, decoder: &mut EntityDecoder, quality: TessellationQuality,
) -> Result<Value> {
    match &operand.ifc_type {
        IfcType::IfcCsgSolid | IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult => {
            Err(Error::geometry("Recursive operand requires continuation dispatch"))
        }
        IfcType::IfcSurfaceOfLinearExtrusion => unsupported(recorder, op, &operand.ifc_type),
        other => match builtin_processor(other.clone(), &recorder.schema) {
            Some(processor) => {
                // Never invoke a source-reading process callback as numeric work.
                // Every non-recursive builtin has the shared owned constructor.
                let plan = processor.lower_owned(operand, decoder, quality, None)
                    .ok_or_else(|| Error::geometry("Builtin operand has no owned constructor"))??;
                let outer = plan.execute(&recorder.effects).assemble(recorder)?;
                if op != BoolOp::Unknown {
                    if let Some(kind) = brep_with_voids_shell_kind(other) {
                        return Ok(without_voids(recorder, kind, op, operand, outer, decoder, quality));
                    }
                }
                Ok((outer, false))
            }
            None => unsupported(recorder, op, other),
        },
    }
}
fn unsupported(recorder: &BooleanClippingProcessor, op: BoolOp, ty: &IfcType) -> Result<Value> {
    recorder.record_failure(op, BoolFailureReason::UnsupportedOperand(ty.to_string()));
    Ok((Mesh::new(), true))
}

pub(crate) fn without_voids(recorder: &BooleanClippingProcessor, shell_kind: IfcType,
    op: BoolOp, operand: &DecodedEntity, outer: Mesh, decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> Value {
    let Some(voids) = plan::void_refs(operand) else { return (outer, false); };
    if voids.is_empty() || outer.is_empty() { return (outer, false); }
    let Some(kind) = ShellKind::from_type(&shell_kind) else {
        return void_evaluation::refuse_source(recorder, op, &operand.ifc_type, VoidFault::NoProcessor.message());
    };
    let mut meshes = Vec::with_capacity(voids.len());
    // Do not lower the next shell until the previous shell actually meshed.
    for value in voids {
        let Some(id) = value.as_entity_ref() else {
            return void_evaluation::refuse_source(recorder, op, &operand.ifc_type, VoidFault::NotReference.message());
        };
        let mesh = ShellPlan::lower(id, kind, decoder, quality)
            .and_then(|plan| plan.execute(&recorder.effects).assemble(recorder));
        match mesh {
            Ok(mesh) if !mesh.is_empty() => meshes.push(mesh),
            _ => return void_evaluation::refuse_source(recorder, op, &operand.ifc_type, VoidFault::ShellDidNotMesh.message()),
        }
    }
    // Unit discovery stays after every required shell has succeeded.
    work::Voids { ready: void_evaluation::ReadyVoids::new(meshes), outer,
        length_unit_scale: decoder.length_unit_scale(), op, operand_type: operand.ifc_type.clone() }
        .execute(&recorder.effects).assemble(recorder)
}

// Direct private test adapters use the same program, never the superseded path.
#[cfg(test)]
impl BooleanClippingProcessor {
    pub(crate) fn process_operand_checked(&self, op: BoolOp, operand: &DecodedEntity,
        decoder: &mut EntityDecoder, quality: TessellationQuality) -> Result<Value> {
        evaluate(self, op, operand, decoder, quality)
    }
    pub(crate) fn without_voids(&self, shell_kind: IfcType, op: BoolOp,
        operand: &DecodedEntity, outer: Mesh, decoder: &mut EntityDecoder,
        quality: TessellationQuality) -> Value {
        without_voids(self, shell_kind, op, operand, outer, decoder, quality)
    }
}
