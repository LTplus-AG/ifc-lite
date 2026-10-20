// SPDX-License-Identifier: MPL-2.0
//! Flat ownership and demand-driven execution. No recursive drop or walk.
use super::{Construction, ConstructionBatch, ConstructionDiagnostic, ConstructionEvaluation,
    ConstructionExecutionError};
use crate::{BoolFailure, BoolOp, Error, Mesh, Result};
use crate::processors::boolean::{BooleanClippingProcessor, solid_execution::SolidBooleanPlan};

#[derive(Debug, Clone)]
pub(super) enum Instruction {
    Leaf(Construction),
    Boolean { first: usize, second: usize, plan: SolidBooleanPlan },
    Csg { root: usize },
}
impl Instruction {
    pub(super) fn dependencies(&self) -> impl Iterator<Item = usize> {
        let ids = match self {
            Self::Leaf(_) => [None, None],
            Self::Boolean { first, second, .. } => [Some(*first), Some(*second)],
            Self::Csg { root } => [Some(*root), None],
        };
        ids.into_iter().flatten()
    }
}
#[derive(Clone)]
struct Evaluated {
    mesh: Mesh,
    empty_recorded: bool,
    diagnostics: Vec<BoolFailure>,
}
// Charge records and copies before allocation: shared empty DAGs can double
// semantic losses per level even though graph work itself is linear.
const MAX_DIAGNOSTIC_WORK: usize = 65_536;
struct State {
    instructions: Vec<Option<Instruction>>,
    values: Vec<Option<Evaluated>>,
    uses: Vec<usize>,
    budget: usize,
    observed: Vec<ConstructionDiagnostic>,
    sources: Vec<u32>,
    current: usize,
    recorder: BooleanClippingProcessor,
}
impl State {
    fn charge(&mut self, count: usize) -> Result<()> {
        self.budget = self.budget.checked_sub(count)
            .ok_or_else(|| Error::geometry("Construction diagnostic work budget exhausted"))?;
        Ok(())
    }
    fn take(&mut self, index: usize) -> Result<Evaluated> {
        self.uses[index] -= 1;
        if self.uses[index] == 0 {
            Ok(self.values[index].take().expect("evaluated dependency"))
        } else {
            let count = self.values[index].as_ref().expect("live dependency").diagnostics.len();
            self.charge(count)?;
            Ok(self.values[index].as_ref().unwrap().clone())
        }
    }
    fn discard(&mut self, index: usize) {
        let mut pending = vec![index];
        while let Some(index) = pending.pop() {
            self.uses[index] -= 1;
            if self.uses[index] != 0 { continue; }
            if self.values[index].take().is_some() { continue; }
            if let Some(instruction) = self.instructions[index].take() {
                pending.extend(instruction.dependencies());
            }
        }
    }
    fn record(&mut self, failures: Vec<BoolFailure>) -> Result<Vec<BoolFailure>> {
        let start = self.observed.len();
        // Retain fresh builder evidence even when its subsequent diagnostic
        // copy exceeds the work budget: the error must explain the loss that
        // occurred. This append is bounded by executed instructions and their
        // builder reports, separately from the shared-DAG copying budget.
        self.observed.extend(failures.into_iter().map(|failure| ConstructionDiagnostic {
            source_id: self.sources[self.current], failure,
        }));
        let count = self.observed.len() - start;
        self.charge(count)?;
        Ok(self.observed[start..].iter().map(|record| record.failure.clone()).collect())
    }
    fn boolean(&mut self, plan: SolidBooleanPlan, mut first: Evaluated,
        second: Evaluated) -> Result<Evaluated> {
        let result = plan.evaluate(&self.recorder, first.mesh, second.mesh, second.empty_recorded);
        // Drain even when numerical execution failed; the error owns evidence.
        let emitted = self.recorder.take_failures();
        let failures = self.record(emitted)?;
        let (mesh, dropped) = result?;
        first.diagnostics.extend(second.diagnostics);
        first.diagnostics.extend(failures);
        Ok(Evaluated { empty_recorded: mesh.is_empty() && (first.empty_recorded || dropped),
            mesh, diagnostics: first.diagnostics })
    }
    fn run(&mut self, root: usize) -> Result<Evaluated> {
        enum Frame { Enter(usize), First(usize), Finish(usize, Option<Evaluated>) }
        let mut stack = vec![Frame::Enter(root)];
        while let Some(frame) = stack.pop() {
            let index = match frame { Frame::Enter(i) | Frame::First(i) | Frame::Finish(i, _) => i };
            self.current = index;
            match frame {
                Frame::Enter(_) => {
                    if self.values[index].is_some() { continue; }
                    match self.instructions[index].as_ref().expect("live instruction") {
                        Instruction::Leaf(_) => {
                            let Some(Instruction::Leaf(plan)) = self.instructions[index].take() else { unreachable!() };
                            let result = plan.evaluate(&self.recorder);
                            let emitted = self.recorder.take_failures();
                            let diagnostics = self.record(emitted)?;
                            let (mesh, empty_recorded) = result?;
                            self.values[index] = Some(Evaluated { mesh, empty_recorded, diagnostics });
                        }
                        Instruction::Csg { root } => {
                            stack.push(Frame::Finish(index, None));
                            stack.push(Frame::Enter(*root));
                        }
                        Instruction::Boolean { first, .. } => {
                            stack.push(Frame::First(index));
                            stack.push(Frame::Enter(*first));
                        }
                    }
                }
                Frame::First(_) => {
                    let Some(Instruction::Boolean { first, second, plan }) = self.instructions[index].as_ref() else { unreachable!() };
                    let (first, second) = (*first, *second);
                    if self.values[first].as_ref().unwrap().mesh.is_empty()
                        && matches!(plan.operator, BoolOp::Difference | BoolOp::Intersection) {
                        self.discard(second);
                        self.instructions[index].take();
                        self.values[index] = Some(self.take(first)?);
                    } else {
                        let operator = plan.operator;
                        let mut first = self.take(first)?;
                        // Production reports this before entering the second
                        // operand, including when that operand later fails.
                        if first.mesh.is_empty() && operator == BoolOp::Union {
                            if !first.empty_recorded {
                                first.diagnostics.extend(self.record(vec![BoolFailure::new(
                                    BoolOp::Union, crate::BoolFailureReason::EmptyOperand)])?);
                            }
                            first.empty_recorded = true;
                        }
                        stack.push(Frame::Finish(index, Some(first)));
                        stack.push(Frame::Enter(second));
                    }
                }
                Frame::Finish(_, first_value) => {
                    let instruction = self.instructions[index].take().expect("pending instruction");
                    let value = match instruction {
                        Instruction::Csg { root } => self.take(root)?,
                        Instruction::Boolean { second, plan, .. } => {
                            let first = first_value.expect("first operand executed before second");
                            let second = self.take(second)?;
                            self.boolean(plan, first, second)?
                        }
                        Instruction::Leaf(_) => unreachable!(),
                    };
                    self.values[index] = Some(value);
                }
            }
        }
        self.current = root;
        self.take(root)
    }
}
pub(super) fn evaluate(batch: ConstructionBatch)
    -> std::result::Result<ConstructionEvaluation, ConstructionExecutionError> {
    let mut uses = vec![0; batch.program.len()];
    for instruction in &batch.program {
        for dependency in instruction.dependencies() { uses[dependency] += 1; }
    }
    for root in &batch.nodes { uses[*root.construction.as_ref().expect("preflighted root")] += 1; }
    let mut state = State {
        values: (0..batch.program.len()).map(|_| None).collect(),
        instructions: batch.program.into_iter().map(Some).collect(), uses,
        sources: batch.program_sources, current: 0, budget: MAX_DIAGNOSTIC_WORK, observed: Vec::new(),
        recorder: BooleanClippingProcessor::new(),
    };
    let mut definitions = Vec::with_capacity(batch.nodes.len());
    let mut diagnostics = Vec::with_capacity(batch.nodes.len());
    for root in batch.nodes {
        match state.run(root.construction.expect("preflighted root")) {
            Ok(result) => { definitions.push(result.mesh); diagnostics.push(result.diagnostics); }
            Err(error) => return Err(ConstructionExecutionError {
                root_source_id: Some(root.source_id), failed_source_id: Some(state.sources[state.current]),
                error: Box::new(error), diagnostics: state.observed, reports: batch.reports,
            }),
        }
    }
    Ok(ConstructionEvaluation { definitions, diagnostics, occurrences: batch.occurrences,
        reports: batch.reports, observed_diagnostics: state.observed })
}
