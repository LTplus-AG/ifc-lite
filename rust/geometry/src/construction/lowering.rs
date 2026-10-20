// SPDX-License-Identifier: MPL-2.0
use super::{ConstructionBatch, ConstructionNode, ConstructionRequirement as Requirement};
use super::program::Instruction;
use super::source::{self, Admission, Key, Pending, Role};
use crate::{Error, GeometryRouter, Result};
use crate::router::builtin_family;
use ifc_lite_core::{EntityDecoder, IfcSchema};
use std::collections::HashMap;

// Limits of this opt-in graph, distinct from production contextual operand
// budgets. Payload allocation and kernel effort are independent bounds.
const MAX_GRAPH_NODES: usize = 16_384;
const MAX_GRAPH_WORK: usize = MAX_GRAPH_NODES * 8;

#[derive(Clone, Copy)]
enum State { Visiting, Done(usize) }
enum Frame { Enter(Key), Finish(Key, Pending) }
struct Compiler<'a, 'b> {
    router: &'a GeometryRouter,
    schema: &'a IfcSchema,
    decoder: &'a mut EntityDecoder<'b>,
    program: Vec<Instruction>,
    program_sources: Vec<u32>,
    states: HashMap<Key, State>,
    work: usize,
}

impl ConstructionBatch {
    pub(crate) fn compile(router: &GeometryRouter, schema: &IfcSchema,
        decoder: &mut EntityDecoder, roots: &[u32], max_items: usize) -> Result<Self> {
        if roots.len() > max_items {
            return Err(Error::geometry(format!(
                "Construction item budget exceeded: {} > {max_items}", roots.len())));
        }
        let (mut batch, mut reports) = crate::processors::diagnostic_capture::capture(||
            Self::compile_admitted(router, schema, decoder, roots));
        reports.decoder_refused_record_ids = decoder.refused_record_ids();
        reports.decoder_refused_record_ids.sort_unstable();
        batch.reports = reports;
        Ok(batch)
    }

    fn compile_admitted(router: &GeometryRouter, schema: &IfcSchema,
        decoder: &mut EntityDecoder, roots: &[u32]) -> Self {
        let mut compiler = Compiler { router, schema, decoder,
            program: Vec::new(), program_sources: Vec::new(), states: HashMap::new(), work: 0 };
        let mut nodes = Vec::new();
        let mut occurrences = Vec::with_capacity(roots.len());
        let mut definitions = HashMap::new();
        for &source_id in roots {
            let index = *definitions.entry(source_id).or_insert_with(|| {
                let index = nodes.len();
                let family = compiler.decoder.decode_by_id(source_id).ok()
                    .and_then(|entity| builtin_family(&entity.ifc_type));
                let construction = compiler.root((source_id, Role::Root));
                nodes.push(ConstructionNode { source_id, family, construction });
                index
            });
            occurrences.push(index);
        }
        Self { nodes, occurrences, program: compiler.program,
            program_sources: compiler.program_sources, reports: Default::default() }
    }
}

impl Compiler<'_, '_> {
    fn root(&mut self, key: Key) -> std::result::Result<usize, Requirement> {
        let result = self.walk(key);
        if result.is_err() {
            // Do not poison another root's path. Keep completed immutable
            // definitions, remove only active states. All ownership is flat.
            self.states.retain(|_, state| matches!(state, State::Done(_)));
        }
        result
    }

    fn walk(&mut self, root: Key) -> std::result::Result<usize, Requirement> {
        let mut stack = vec![Frame::Enter(root)];
        while let Some(frame) = stack.pop() {
            self.work += 1;
            if self.work > MAX_GRAPH_WORK { return Err(Requirement::GraphBudgetExhausted); }
            match frame {
                Frame::Enter(key) => {
                    match self.states.get(&key) {
                        Some(State::Done(_)) => continue,
                        Some(State::Visiting) => return Err(Requirement::CyclicDependency(key.0)),
                        None => {}
                    }
                    if self.states.len() >= MAX_GRAPH_NODES { return Err(Requirement::GraphBudgetExhausted); }
                    self.states.insert(key, State::Visiting);
                    match source::admit(self.router, self.schema, self.decoder, key)? {
                        Admission::Leaf(construction) => self.emit(key, Instruction::Leaf(construction)),
                        Admission::Operation(pending) => {
                            let children: Vec<_> = pending.dependencies().collect();
                            stack.push(Frame::Finish(key, pending));
                            for child in children.into_iter().rev() { stack.push(Frame::Enter(child)); }
                        }
                    }
                }
                Frame::Finish(key, pending) => {
                    let instruction = pending.resolve(|child| self.index(child));
                    self.emit(key, instruction);
                }
            }
        }
        Ok(self.index(root))
    }

    fn index(&self, key: Key) -> usize {
        match self.states.get(&key) {
            Some(State::Done(index)) => *index,
            _ => unreachable!("dependencies are emitted before their operation"),
        }
    }

    fn emit(&mut self, key: Key, instruction: Instruction) {
        let index = self.program.len();
        self.program.push(instruction);
        self.program_sources.push(key.0);
        self.states.insert(key, State::Done(index));
    }
}
