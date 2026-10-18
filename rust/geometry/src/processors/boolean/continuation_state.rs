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
    Csg { entity: DecodedEntity, depth: u32, guarded: bool },
    Operand { entity: DecodedEntity, operator: BoolOp, depth: u32 },
    ExitPath(u32),
    Walk(Walk),
    AfterBase(Walk),
    AfterBatch { walk: Walk, cutters: Vec<DecodedEntity>, mark: usize },
    Steps(Steps),
    AfterStep { steps: Steps, operator: BoolOp, host: Mesh },
}
