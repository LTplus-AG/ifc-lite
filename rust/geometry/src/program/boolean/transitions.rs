// SPDX-License-Identifier: MPL-2.0
//! Consuming numerical acceptance. No source service is available here.
use super::{BooleanState, Frame, work};
use crate::processors::boolean::BooleanClippingProcessor;
use crate::Result;

impl BooleanState {
    pub(super) fn accept_numerical(&mut self, next: work::Continuation,
        reply: work::Reply, recorder: &BooleanClippingProcessor,
    ) -> Result<()> {
        match (next, reply) {
            (work::Continuation::RetainedOperand, work::Reply::Retained(value)) => self.retained_value = Some(value?),
            (work::Continuation::RetainedStep(mut steps), work::Reply::Retained(value)) => {
                steps.retained=Some(value?);self.frames.push(Frame::Steps(steps));
            }
            (work::Continuation::Operand { operand, op }, work::Reply::Constructor(done)) => {
                let outer = crate::resource::observe(done.assemble(recorder))?;
                self.begin_voids(operand, op, outer, recorder)?;
            }
            (work::Continuation::Step(mut steps), work::Reply::Plane(done)) => {
                steps.accept(crate::resource::observe(done.assemble(recorder))?);
                self.frames.push(Frame::Steps(steps));
            }
            (work::Continuation::SolidAdmission(steps), work::Reply::SolidAdmission(done)) => {
                let operation = done.assemble(recorder);
                crate::resource::check_current()?;
                if operation.admission == crate::processors::boolean::solid_execution::SolidAdmission::Kernel {
                    self.frames.push(Frame::SolidUnits { steps, operation });
                } else {
                    self.frames.push(Frame::Numerical(work::Ready::Solid(operation), work::Continuation::Step(steps)));
                }
            }
            (work::Continuation::Step(mut steps), work::Reply::Solid(done)) => {
                steps.accept(crate::resource::observe(done.assemble(recorder))?);
                self.frames.push(Frame::Steps(steps));
            }
            (work::Continuation::Kept { mut steps, operand, plane }, work::Reply::Kept(done)) => {
                let (host, kept) = done.assemble(recorder);
                crate::resource::check_current()?;
                if kept {
                    steps.accept((host, false));
                    self.frames.push(Frame::Steps(steps));
                } else { self.frames.push(Frame::PrismSource { steps, host, operand, plane }); }
            }
            (work::Continuation::Prism { steps, plane }, work::Reply::Prism(done)) => {
                let (host, built) = done.assemble(recorder);
                match crate::resource::observe(built) {
                    Err(error @ crate::Error::ProgramStopped(_)) => return Err(error),
                    Ok(cutter) => self.frames.push(Frame::SingleUnits { steps, host, cutter, plane }),
                    Err(_) => self.plane(steps, host, plane, true),
                }
            }
            (work::Continuation::Single { mut steps, plane }, work::Reply::Single(done)) => {
                match done.assemble_single(recorder)? {
                    work::SingleResult::Done(value) => {
                        steps.accept(value);
                        self.frames.push(Frame::Steps(steps));
                    }
                    work::SingleResult::Fallback(host) => self.plane(steps, host, plane, true),
                }
            }
            (work::Continuation::GroupPrism(mut group), work::Reply::Prism(done)) => {
                let (base, built) = done.assemble(recorder);
                group.base = base;
                match crate::resource::observe(built) {
                    Ok(prism) if !prism.is_empty() => {
                        group.prisms.push(prism);
                        self.frames.push(Frame::GroupSource(group));
                    }
                    Err(error @ crate::Error::ProgramStopped(_)) => return Err(error),
                    _ => {
                        recorder.rewind_to(group.mark);
                        self.frames.push(Frame::NextFirst(group.walk));
                    }
                }
            }
            (work::Continuation::Group { walk, mark }, work::Reply::Group(done)) => {
                match crate::resource::observe(done.assemble_group(recorder, mark))? {
                    Some(value) => self.frames.push(Frame::Steps(walk.steps(value, true))),
                    None => self.frames.push(Frame::NextFirst(walk)),
                }
            }
            (work::Continuation::Shell(mut voids), work::Reply::Shell(done)) => {
                let mesh = crate::resource::observe(done.assemble(recorder));
                crate::resource::check_current()?;
                match mesh {
                    Ok(mesh) if !mesh.is_empty() => {
                        voids.meshes.push(mesh);
                        self.frames.push(Frame::VoidsSource(voids));
                    }
                    Err(error @ crate::Error::ProgramStopped(_)) => return Err(error),
                    _ => self.refuse_voids(&voids, recorder),
                }
            }
            (work::Continuation::Value, work::Reply::Voids(done)) => {
                self.value = Some(done.assemble(recorder));
                crate::resource::check_current()?;
            }
            _ => unreachable!("validated Boolean numerical continuation"),
        }
        Ok(())
    }
}
