// SPDX-License-Identifier: MPL-2.0
//! Provisional batch continuations preserve source order and consumed work.
use super::{BooleanProgram, Frame, Walk, Services, work};
use super::work::Execute;
use crate::processors::boolean::half_space_plan::HalfSpacePlan;
use crate::{BoolOp, Error, Mesh, Result};
use ifc_lite_core::{slot, DecodedEntity, IfcType};

impl BooleanProgram {
    pub(super) fn walk(&mut self, mut walk: Walk, services: &mut Services<'_, '_>) -> Result<()> {
        if !walk.seen.insert(walk.current.id) {
            return Err(Error::geometry(format!(
                "cyclic boolean FirstOperand chain at #{}", walk.current.id)));
        }
        if !matches!(walk.current.ifc_type,
            IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult) {
            let entity = walk.current.clone();
            let depth = walk.depth;
            self.frames.push(Frame::AfterBase(walk));
            self.frames.push(Frame::Operand { entity, operator: BoolOp::Unknown, depth });
            return Ok(());
        }
        if super::boolean_operator(&walk.current) == Ok(BoolOp::Difference) {
            // Collector admission precedes base evaluation even if the base
            // will be empty. Preserve these speculative direct source reads.
            let (base, cutters) = crate::resource::observe(services.recorder.collect_polygonal_chain(walk.current.clone(), services.decoder))?;
            if cutters.len() >= 2 {
                let mark = services.recorder.failure_mark();
                let depth = walk.depth;
                self.frames.push(Frame::AfterBatch { walk, cutters, mark });
                self.frames.push(Frame::Operand { entity: base, operator: BoolOp::Unknown, depth });
                return Ok(());
            }
        }
        self.next_first(walk, services)
    }
    fn next_first(&mut self, mut walk: Walk, services: &mut Services<'_, '_>) -> Result<()> {
        let attr = walk.current.get(slot::IfcBooleanResult::FIRST_OPERAND.index())
            .ok_or_else(|| Error::geometry("BooleanResult missing FirstOperand"))?;
        let first = services.decoder.resolve_ref(attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve FirstOperand"))?;
        walk.spine.push(walk.current);
        walk.current = first;
        self.frames.push(Frame::Walk(walk));
        Ok(())
    }
    pub(super) fn finish_batch(&mut self, walk: Walk,
        cutters: Vec<DecodedEntity>, mark: usize, services: &mut Services<'_, '_>) -> Result<()> {
        crate::resource::check_current()?;
        let (base, empty_recorded) = self.value.take().expect("batch base continuation result");
        if base.is_empty() {
            self.frames.push(Frame::Steps(walk.steps((base, empty_recorded), true)));
            return Ok(());
        }
        let (base, attempt) = self.prepare_group(base, cutters, mark, services)?;
        let result = match attempt {
            Some(prisms) => {
                let units = services.decoder.length_unit_scale();
                crate::resource::check_current()?;
                let completed = work::Group { base, prisms, length_unit_scale: units }
                    .execute(&services.recorder.effects);
                crate::resource::observe(completed.assemble_group(services.recorder, mark))?
            }
            None => None,
        };
        match result {
            Some(value) => self.frames.push(Frame::Steps(walk.steps(value, true))),
            // Group preparation/numerics already rewound the provisional
            // boolean records. Source reports and operand visits stay spent.
            None => self.next_first(walk, services)?,
        }
        Ok(())
    }
    fn prepare_group(&mut self, mut base: Mesh, cutters: Vec<DecodedEntity>,
        mark: usize, services: &mut Services<'_, '_>) -> Result<(Mesh, Option<Vec<Mesh>>)> {
        crate::resource::check_current()?;
        let mut prisms = Vec::with_capacity(cutters.len());
        for cutter in cutters {
            crate::resource::check_current()?;
            let plane = crate::resource::observe(services.recorder.parse_half_space_solid(&cutter, services.decoder));
            if let Err(error @ crate::Error::ProgramStopped(_)) = plane { return Err(error); }
            let Ok(plane) = plane
                else { services.recorder.rewind_to(mark); return Ok((base, None)); };
            let admitted = crate::resource::observe(services.recorder.lower_bounded_prism(&cutter, services.decoder, self.quality));
            let plan = match admitted {
                Ok(Some(plan)) => plan,
                Err(error @ crate::Error::ProgramStopped(_)) => return Err(error),
                _ => { services.recorder.rewind_to(mark); return Ok((base, None)); }
            };
            let plane = HalfSpacePlan { point: plane.0, normal: plane.1, agreement: plane.2 };
            let (host, built) = work::Prism { plan, host: base, plane }.execute(&services.recorder.effects).assemble(services.recorder);
            base = host;
            match crate::resource::observe(built) {
                Ok(prism) if !prism.is_empty() => prisms.push(prism),
                Err(error @ crate::Error::ProgramStopped(_)) => return Err(error),
                _ => { services.recorder.rewind_to(mark); return Ok((base, None)); }
            }
        }
        Ok((base, Some(prisms)))
    }
}
