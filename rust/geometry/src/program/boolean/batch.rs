// SPDX-License-Identifier: MPL-2.0
//! Provisional batch continuations preserve source order and consumed work.
use super::{BooleanState, Frame, Walk, Services, work};
use super::state::{Collector, GroupState};
use crate::processors::boolean::{half_space_plan::HalfSpacePlan,
    source_read};
use crate::{BoolOp, Error, Result};
use ifc_lite_core::{slot, DecodedEntity, IfcType};

impl BooleanState {
    pub(super) fn walk(&mut self, mut walk: Walk) -> Result<()> {
        if !walk.seen.insert(walk.current.id) {
            return Err(Error::geometry(format!("cyclic boolean FirstOperand chain at #{}", walk.current.id)));
        }
        if !matches!(walk.current.ifc_type, IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult) {
            let entity = walk.current.clone();
            let depth = walk.depth;
            self.frames.push(Frame::AfterBase(walk));
            self.frames.push(Frame::Operand { entity, operator: BoolOp::Unknown, depth });
        } else if super::boolean_operator(&walk.current) == Ok(BoolOp::Difference) {
            let current = walk.current.clone();
            self.frames.push(Frame::Collect(Collector { walk, current,
                seen: Default::default(), cutters: Vec::new() }));
        } else { self.frames.push(Frame::NextFirst(walk)); }
        Ok(())
    }
    pub(super) fn collect(&mut self, mut collector: Collector,
        services: &mut Services<'_, '_>,
    ) -> Result<()> {
        let current = &collector.current;
        if !collector.seen.insert(current.id)
            || !matches!(current.ifc_type, IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult)
            || super::boolean_operator(current) != Ok(BoolOp::Difference) {
            self.finish_collect(collector, services);
            return Ok(());
        }
        let read = source_read::read_operand(current, services.decoder, false);
        crate::processors::diagnostic_capture::restore(&read.reports);
        self.reports.decoder_refused_record_ids.extend(read.reports.decoder_refused_record_ids);
        crate::resource::check_current()?;
        match read.result {
            Ok(cutter) if cutter.ifc_type == IfcType::IfcPolygonalBoundedHalfSpace => {
                collector.cutters.push(cutter);
                self.frames.push(Frame::CollectFirst(collector));
            }
            _ => self.finish_collect(collector, services),
        }
        Ok(())
    }
    pub(super) fn collect_first(&mut self, mut collector: Collector,
        services: &mut Services<'_, '_>,
    ) -> Result<()> {
        let read = source_read::read_operand(&collector.current, services.decoder, true);
        crate::processors::diagnostic_capture::restore(&read.reports);
        self.reports.decoder_refused_record_ids.extend(read.reports.decoder_refused_record_ids);
        crate::resource::check_current()?;
        match read.result {
            Ok(first) => {
                collector.current = first;
                self.frames.push(Frame::Collect(collector));
            }
            _ => self.finish_collect(collector, services),
        }
        Ok(())
    }
    fn finish_collect(&mut self, mut collector: Collector, services: &mut Services<'_, '_>) {
        collector.cutters.reverse();
        if collector.cutters.len() >= 2 {
            let mark = services.recorder.failure_mark();
            let depth = collector.walk.depth;
            self.frames.push(Frame::AfterBatch { walk: collector.walk, cutters: collector.cutters, mark });
            self.frames.push(Frame::Operand { entity: collector.current, operator: BoolOp::Unknown, depth });
        } else { self.frames.push(Frame::NextFirst(collector.walk)); }
    }
    pub(super) fn next_first(&mut self, mut walk: Walk, services: &mut Services<'_, '_>) -> Result<()> {
        let attr = walk.current.get(slot::IfcBooleanResult::FIRST_OPERAND.index())
            .ok_or_else(|| Error::geometry("BooleanResult missing FirstOperand"))?;
        let first = services.decoder.resolve_ref(attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve FirstOperand"))?;
        walk.spine.push(walk.current);
        walk.current = first;
        self.frames.push(Frame::Walk(walk));
        Ok(())
    }
    pub(super) fn finish_batch(&mut self, walk: Walk, cutters: Vec<DecodedEntity>, mark: usize,
    ) -> Result<()> {
        crate::resource::check_current()?;
        let (base, empty_recorded) = self.value.take().expect("batch base continuation result");
        if base.is_empty() {
            self.frames.push(Frame::Steps(walk.steps((base, empty_recorded), true)));
        } else {
            let prisms = Vec::with_capacity(cutters.len());
            self.frames.push(Frame::GroupSource(GroupState { walk, cutters: cutters.into_iter(),
                base, prisms, mark }));
        }
        Ok(())
    }
    pub(super) fn group_source(&mut self, mut group: GroupState,
        services: &mut Services<'_, '_>,
    ) -> Result<()> {
        let Some(cutter) = group.cutters.next() else {
            let units = services.decoder.length_unit_scale();
            crate::resource::check_current()?;
            self.frames.push(Frame::Numerical(work::Ready::Group(work::Group {
                base: group.base, prisms: group.prisms, length_unit_scale: units }),
                work::Continuation::Group { walk: group.walk, mark: group.mark }));
            return Ok(());
        };
        let plane = crate::resource::observe(services.recorder.parse_half_space_solid(&cutter, services.decoder));
        match plane {
            Err(error @ crate::Error::ProgramStopped(_)) => Err(error),
            Ok((point, normal, agreement)) => {
                self.frames.push(Frame::GroupPrismSource { group, cutter,
                    plane: HalfSpacePlan { point, normal, agreement } });
                Ok(())
            }
            Err(_) => { self.defer_group(group, services); Ok(()) }
        }
    }
    pub(super) fn group_prism_source(&mut self, mut group: GroupState, cutter: DecodedEntity,
        plane: HalfSpacePlan, services: &mut Services<'_, '_>,
    ) -> Result<()> {
        let admitted = crate::resource::observe(services.recorder.lower_bounded_prism(
            &cutter, services.decoder, self.quality));
        match admitted {
            Err(error @ crate::Error::ProgramStopped(_)) => Err(error),
            Ok(Some(plan)) => {
                let base = std::mem::take(&mut group.base);
                self.frames.push(Frame::Numerical(work::Ready::Prism(work::Prism { plan, host: base, plane }),
                    work::Continuation::GroupPrism(group)));
                Ok(())
            }
            _ => { self.defer_group(group, services); Ok(()) }
        }
    }
    fn defer_group(&mut self, group: GroupState, services: &mut Services<'_, '_>) {
        services.recorder.rewind_to(group.mark);
        self.frames.push(Frame::NextFirst(group.walk));
    }
}
