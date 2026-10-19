// SPDX-License-Identifier: MPL-2.0
//! Bounded owned source control flow, not executable construction. Snapshots own
//! decoded attributes, not IFC bytes. Leaf sampling and numerical work belong to
//! subsequent lowering/evaluation. Source errors and reports are dormant data.
use super::super::boolean_operator;
use crate::{construction::ConstructionReports, BoolOp, Error};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};
use std::{collections::{HashMap, HashSet}, sync::Arc};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SourceLimit { Nodes, Work }

#[derive(Debug, Clone)]
pub(crate) enum Admission {
    Resolved(DecodedEntity),
    Fault(Arc<Error>),
    /// An unknown operator never uses its second operand.
    Unused,
    Limited(SourceLimit),
}
#[derive(Debug, Clone)]
pub(crate) struct SourceRead {
    pub admission: Admission,
    /// TLS evidence is isolated per read. Decoder refusal ids identify the
    /// directly refused record, including a repeat of an earlier read.
    /// The decoder itself retains its cumulative refusal set; callers must not
    /// publish that cumulative set as occurrence-attributed execution evidence.
    pub reports: ConstructionReports,
}
impl SourceRead {
    fn plain(admission: Admission) -> Self { Self { admission, reports: Default::default() } }
}

#[derive(Debug, Clone)]
pub(crate) struct SpineNode {
    pub entity: DecodedEntity,
    pub operator: std::result::Result<BoolOp, String>,
    pub first: SourceRead,
    pub second: SourceRead,
}

#[derive(Debug, Clone)]
pub(crate) enum SpineEnd {
    Base(DecodedEntity),
    FirstFault(usize),
    Cycle(u32),
    Limited { source_id: u32, reason: SourceLimit },
}

/// The production batching attempt starts at each DIFFERENCE spine node,
/// including candidates with fewer than two polygonal cutters (which defer).
#[derive(Debug, Clone, Copy)]
pub(crate) struct BatchCandidate { pub start_node: usize }
#[derive(Debug, Clone)]
pub(crate) struct CollectedCandidate {
    /// Indices into `nodes`, innermost first. No cutter is silently omitted.
    pub cutters: Vec<usize>,
    pub base: Admission,
}

#[derive(Debug, Clone)]
pub(crate) struct BooleanSpinePlan {
    /// Outermost first; sequential application traverses in reverse order.
    pub nodes: Vec<SpineNode>,
    pub end: SpineEnd,
    pub candidates: Vec<BatchCandidate>,
    by_id: HashMap<u32, usize>,
}

struct Budget { nodes: usize, work: usize }
impl Budget {
    fn charge(&mut self) -> bool {
        if self.work == 0 { return false; }
        self.work -= 1;
        true
    }
}

/// Bounds are supplied by the surrounding compiler. Exhaustion becomes owned
/// conditional admission data. This does not replace OperandPath's contextual
/// depth/path/monotonic-visit accounting or the element's kernel budget.
#[cfg(test)]
pub(crate) fn lower(entity: &DecodedEntity, decoder: &mut EntityDecoder,
    max_nodes: usize, max_work: usize) -> BooleanSpinePlan {
    lower_mode(entity, decoder, max_nodes, max_work, false)
}

/// Exact source-read mode of the production polygonal collector. Nonmatching
/// operators/cutters stop before FirstOperand; faults stop at the current node.
/// The caller activates captured reports when this attempt is actually reached.
/// Unbounded usize limits retain the existing iterative collector's policy.
pub(crate) fn lower_polygonal_candidate(entity: &DecodedEntity, decoder: &mut EntityDecoder,
    max_nodes: usize, max_work: usize) -> BooleanSpinePlan {
    lower_mode(entity, decoder, max_nodes, max_work, true)
}

fn lower_mode(entity: &DecodedEntity, decoder: &mut EntityDecoder,
    max_nodes: usize, max_work: usize, polygonal_only: bool) -> BooleanSpinePlan {
    let mut budget = Budget { nodes: max_nodes, work: max_work };
    let mut nodes = Vec::new();
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    let mut current = entity.clone();
    let end = loop {
        if !budget.charge() {
            break SpineEnd::Limited { source_id: current.id, reason: SourceLimit::Work };
        }
        if !seen.insert(current.id) { break SpineEnd::Cycle(current.id); }
        if !is_boolean(&current) { break SpineEnd::Base(current); }
        if nodes.len() >= budget.nodes {
            break SpineEnd::Limited { source_id: current.id, reason: SourceLimit::Nodes };
        }
        let operator = boolean_operator(&current).map_err(str::to_owned);
        if operator == Ok(BoolOp::Difference) {
            candidates.push(BatchCandidate { start_node: nodes.len() });
        }
        // Source decoding is eager; activating its failure/reports is delayed.
        // In particular a rejected operator does not even resolve its cutter.
        let second = if operator.is_ok() && (!polygonal_only || operator == Ok(BoolOp::Difference)) {
            read(&current, decoder, false, &mut budget)
        } else { SourceRead::plain(Admission::Unused) };
        if polygonal_only && (operator != Ok(BoolOp::Difference)
            || !matches!(&second.admission, Admission::Resolved(entity)
                if entity.ifc_type == IfcType::IfcPolygonalBoundedHalfSpace)) {
            let limited = if let Admission::Limited(reason) = &second.admission { Some(*reason) } else { None };
            nodes.push(SpineNode { entity: current.clone(), operator,
                first: SourceRead::plain(Admission::Unused), second });
            break match limited {
                Some(reason) => SpineEnd::Limited { source_id: current.id, reason },
                None => SpineEnd::Base(current),
            };
        }
        let first = read(&current, decoder, true, &mut budget);
        let next = first.admission.clone();
        nodes.push(SpineNode { entity: current.clone(), operator, first, second });
        match next {
            Admission::Resolved(entity) => current = entity,
            Admission::Fault(_) => break SpineEnd::FirstFault(nodes.len() - 1),
            Admission::Limited(reason) => break SpineEnd::Limited { source_id: current.id, reason },
            Admission::Unused => unreachable!("first operand is always read"),
        }
    };
    let by_id = nodes.iter().enumerate().map(|(index, node)| (node.entity.id, index)).collect();
    BooleanSpinePlan { nodes, end, candidates, by_id }
}

fn is_boolean(entity: &DecodedEntity) -> bool {
    matches!(entity.ifc_type, IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult)
}


fn read(entity: &DecodedEntity, decoder: &mut EntityDecoder,
    first: bool, budget: &mut Budget) -> SourceRead {
    if !budget.charge() { return SourceRead::plain(Admission::Limited(SourceLimit::Work)); }
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
    // Resolving this one reference decodes one record, not its reference graph.
    // Attribute its refusal from the typed error, avoiding cumulative decoder
    // snapshots (which both misattribute dormant reads and scale with the file).
    if let Err(Error::CoreError(ifc_lite_core::Error::UnrepresentableReal(id)
        | ifc_lite_core::Error::MalformedRecord(id))) = &result {
        reports.decoder_refused_record_ids.push(*id);
    }
    reports.decoder_refused_record_ids.sort_unstable();
    reports.decoder_refused_record_ids.dedup();
    SourceRead { admission: match result {
        Ok(entity) => Admission::Resolved(entity), Err(error) => Admission::Fault(Arc::new(error)),
    }, reports }
}

impl BooleanSpinePlan {
    /// Reproduce the polygonal collector against owned snapshots. The bounded
    /// result retains cycle/current-node stop behavior, including unreadable
    /// FirstOperand after a cutter has already entered the candidate. This
    /// query never samples a profile, builds a mesh or touches a decoder.
    pub(crate) fn collect_candidate(&self, candidate: BatchCandidate,
        max_work: usize) -> CollectedCandidate {
        let mut cutters = Vec::new();
        let mut seen = HashSet::new();
        let mut index = candidate.start_node;
        let mut work = max_work;
        let base = loop {
            let Some(node) = self.nodes.get(index) else {
                break match &self.end {
                    SpineEnd::Base(entity) if self.nodes.is_empty() && index == 0 => Admission::Resolved(entity.clone()),
                    SpineEnd::Limited { reason, .. } => Admission::Limited(*reason),
                    _ => Admission::Fault(Arc::new(Error::geometry("Invalid boolean candidate index"))),
                };
            };
            if work == 0 { break Admission::Limited(SourceLimit::Work); }
            work -= 1;
            if !seen.insert(node.entity.id) { break Admission::Resolved(node.entity.clone()); }
            if node.operator != Ok(BoolOp::Difference) { break Admission::Resolved(node.entity.clone()); }
            let Admission::Resolved(cutter) = &node.second.admission else {
                // Unlike an unreadable source link, compiler exhaustion is not
                // a valid reason to silently stop a candidate collection.
                break if let Admission::Limited(reason) = &node.second.admission {
                    Admission::Limited(*reason)
                } else { Admission::Resolved(node.entity.clone()) };
            };
            if cutter.ifc_type != IfcType::IfcPolygonalBoundedHalfSpace {
                break Admission::Resolved(node.entity.clone());
            }
            cutters.push(index);
            match &node.first.admission {
                Admission::Resolved(first) if is_boolean(first) => {
                    if let Some(next) = self.by_id.get(&first.id) {
                        index = *next;
                    } else { break Admission::Limited(SourceLimit::Nodes); }
                }
                Admission::Resolved(first) => break Admission::Resolved(first.clone()),
                Admission::Limited(reason) => break Admission::Limited(*reason),
                Admission::Fault(_) | Admission::Unused => break Admission::Resolved(node.entity.clone()),
            }
        };
        cutters.reverse();
        CollectedCandidate { cutters, base }
    }
}

#[cfg(test)]
#[path = "spine_plan_tests.rs"]
mod tests;
