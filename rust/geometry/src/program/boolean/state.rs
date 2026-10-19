// SPDX-License-Identifier: MPL-2.0
//! Owned control frames. A suspended operand owns its host and remaining spine.
use crate::{BoolOp, Mesh};
use ifc_lite_core::DecodedEntity;
use std::collections::HashSet;

pub(super) type Value = (Mesh, bool);

pub(super) struct Walk {
    pub current: DecodedEntity,
    pub spine: Vec<DecodedEntity>,
    pub seen: HashSet<u32>,
    pub depth: u32,
}
impl Walk {
    pub fn new(current: DecodedEntity, depth: u32) -> Self {
        Self { current, depth, spine: Vec::new(), seen: HashSet::new() }
    }
    pub fn steps(self, (mesh, empty_recorded): Value, batched: bool) -> Steps {
        Steps { solo_step: self.spine.len() == 1 && !batched,
            nodes: self.spine, depth: self.depth, mesh, empty_recorded }
    }
}

pub(super) struct Steps {
    pub nodes: Vec<DecodedEntity>,
    pub depth: u32,
    pub solo_step: bool,
    pub mesh: Mesh,
    pub empty_recorded: bool,
}
impl Steps {
    pub fn accept(&mut self, (mesh, dropped): Value) {
        self.empty_recorded = mesh.is_empty() && (self.empty_recorded || dropped);
        self.mesh = mesh;
    }
}

pub(super) enum Frame {
    Boolean(DecodedEntity, u32),
    #[cfg(test)]
    BeginShells { shell_kind: ifc_lite_core::IfcType, operand: DecodedEntity, op: BoolOp, outer: Mesh },
    Csg { entity: DecodedEntity, depth: u32, guarded: bool },
    Operand { entity: DecodedEntity, operator: BoolOp, depth: u32 },
    ExitPath(u32),
    Walk(Walk),
    Collect(Collector),
    CollectFirst(Collector),
    NextFirst(Walk),
    AfterBase(Walk),
    AfterBatch { walk: Walk, cutters: Vec<DecodedEntity>, mark: usize },
    Steps(Steps),
    AfterStep { steps: Steps, operator: BoolOp, host: Mesh },
    PlaneSource { steps: Steps, host: Mesh, operand: DecodedEntity },
    PrismSource { steps: Steps, host: Mesh, operand: DecodedEntity,
        plane: crate::processors::boolean::half_space_plan::HalfSpacePlan },
    SingleUnits { steps: Steps, host: Mesh, cutter: Mesh,
        plane: crate::processors::boolean::half_space_plan::HalfSpacePlan },
    SolidUnits { steps: Steps, operation: super::work::Solid },
    GroupSource(GroupState),
    GroupPrismSource { group: GroupState, cutter: DecodedEntity,
        plane: crate::processors::boolean::half_space_plan::HalfSpacePlan },
    VoidsSource(VoidsState),
    Numerical(super::work::Ready, super::work::Continuation),
}

pub(super) struct GroupState {
    pub walk: Walk,
    pub cutters: std::vec::IntoIter<DecodedEntity>,
    pub base: Mesh,
    pub prisms: Vec<Mesh>,
    pub mark: usize,
}
pub(super) struct VoidsState {
    pub outer: Mesh,
    pub refs: std::vec::IntoIter<ifc_lite_core::AttributeValue>,
    pub meshes: Vec<Mesh>,
    pub kind: crate::processors::boolean::brep_voids::plan::ShellKind,
    pub op: BoolOp,
    pub operand_type: ifc_lite_core::IfcType,
}


pub(super) struct Collector {
    pub walk: Walk,
    pub current: DecodedEntity,
    pub seen: HashSet<u32>,
    pub cutters: Vec<DecodedEntity>,
}
