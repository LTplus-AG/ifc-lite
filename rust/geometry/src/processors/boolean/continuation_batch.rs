// SPDX-License-Identifier: MPL-2.0
//! Provisional batch continuations preserve source order and consumed work.
use super::{Driver, Frame, Walk};
use crate::{BoolOp, Error, Mesh, Result};
use ifc_lite_core::{slot, DecodedEntity, IfcType};

impl Driver<'_, '_> {
    pub(super) fn walk(&mut self, mut walk: Walk) -> Result<()> {
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
            let (base, cutters) = self.recorder.collect_polygonal_chain(walk.current.clone(), self.decoder)?;
            if cutters.len() >= 2 {
                let mark = self.recorder.failure_mark();
                let depth = walk.depth;
                self.frames.push(Frame::AfterBatch { walk, cutters, mark });
                self.frames.push(Frame::Operand { entity: base, operator: BoolOp::Unknown, depth });
                return Ok(());
            }
        }
        self.next_first(walk)
    }
    fn next_first(&mut self, mut walk: Walk) -> Result<()> {
        let attr = walk.current.get(slot::IfcBooleanResult::FIRST_OPERAND.index())
            .ok_or_else(|| Error::geometry("BooleanResult missing FirstOperand"))?;
        let first = self.decoder.resolve_ref(attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve FirstOperand"))?;
        walk.spine.push(walk.current);
        walk.current = first;
        self.frames.push(Frame::Walk(walk));
        Ok(())
    }
    pub(super) fn finish_batch(&mut self, walk: Walk,
        cutters: Vec<DecodedEntity>, mark: usize) -> Result<()> {
        let (base, empty_recorded) = self.value.take().expect("batch base continuation result");
        if base.is_empty() {
            self.frames.push(Frame::Steps(walk.steps((base, empty_recorded), true)));
            return Ok(());
        }
        let attempt = self.prepare_group(&base, cutters, mark)?;
        let result = match attempt {
            Some(prisms) => self.recorder.evaluate_polygonal_group(
                base, prisms, self.decoder.length_unit_scale(), mark)?,
            None => None,
        };
        match result {
            Some(value) => self.frames.push(Frame::Steps(walk.steps(value, true))),
            // Group preparation/numerics already rewound the provisional
            // boolean records. Source reports and operand visits stay spent.
            None => self.next_first(walk)?,
        }
        Ok(())
    }
    fn prepare_group(&mut self, base: &Mesh, cutters: Vec<DecodedEntity>,
        mark: usize) -> Result<Option<Vec<Mesh>>> {
        let mut prisms = Vec::with_capacity(cutters.len());
        for cutter in cutters {
            let Ok(plane) = self.recorder.parse_half_space_solid(&cutter, self.decoder)
                else { return self.recorder.defer_after(mark); };
            match self.recorder.build_polygonal_bounded_half_space_mesh(
                &cutter, self.decoder, base, plane, self.quality) {
                Ok(Some(prism)) if !prism.is_empty() => prisms.push(prism),
                _ => return self.recorder.defer_after(mark),
            }
        }
        Ok(Some(prisms))
    }
}
