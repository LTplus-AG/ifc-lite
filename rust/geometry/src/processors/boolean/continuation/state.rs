// SPDX-License-Identifier: MPL-2.0
//! Owned control frames. A suspended operand owns its host and remaining spine.
use crate::{BoolOp, Mesh};
use ifc_lite_core::DecodedEntity;
use std::collections::HashSet;

/// A meshed operand and whether its emptiness is a loss already on record.
pub(super) type Value = (Mesh, bool);

/// The left (FirstOperand) spine being descended.
pub(super) struct Walk {
    pub current: DecodedEntity,
    /// Nodes above `current`, outermost first.
    pub spine: Vec<DecodedEntity>,
    pub seen: HashSet<u32>,
    pub depth: u32,
}

impl Walk {
    pub fn new(current: DecodedEntity, depth: u32) -> Self {
        Self { current, depth, spine: Vec::new(), seen: HashSet::new() }
    }

    /// Start applying the spine to `(mesh, empty_recorded)`. `batched` is true
    /// when the mesh already carries a successfully batched cutter group, so a
    /// lone leftover node is not the true single-cutter shape (#3923).
    pub fn steps(self, (mesh, empty_recorded): Value, batched: bool) -> Steps {
        Steps {
            solo_step: self.spine.len() == 1 && !batched,
            nodes: self.spine,
            depth: self.depth,
            mesh,
            empty_recorded,
        }
    }
}

/// The spine nodes still to apply, innermost last (popped first).
pub(super) struct Steps {
    pub nodes: Vec<DecodedEntity>,
    pub depth: u32,
    pub solo_step: bool,
    pub mesh: Mesh,
    pub empty_recorded: bool,
}

impl Steps {
    /// Take one step's result. The flag follows the emptiness: a step that
    /// emptied the mesh by dropping its operand recorded that; a later
    /// emptying is new.
    pub fn accept(&mut self, (mesh, dropped): Value) {
        self.empty_recorded = mesh.is_empty() && (self.empty_recorded || dropped);
        self.mesh = mesh;
    }
}

pub(super) enum Frame {
    /// Enter a boolean node: charge, path-admit, depth-check, then walk it.
    Boolean(DecodedEntity, u32),
    /// Enter an `IfcCsgSolid`; `guarded` admits its id to the operand path.
    Csg { entity: DecodedEntity, depth: u32, guarded: bool },
    /// Mesh one operand with the given operator attribution.
    Operand { entity: DecodedEntity, operator: BoolOp, depth: u32 },
    /// Leave the path scope opened by `enter_path`.
    ExitPath(u32),
    Walk(Walk),
    /// The spine's base operand is meshed.
    AfterBase(Walk),
    /// The base of a batched polygonal chain is meshed.
    AfterBatch { walk: Walk, cutters: Vec<DecodedEntity>, mark: usize },
    Steps(Steps),
    /// A solid second operand is meshed.
    AfterStep { steps: Steps, operator: BoolOp, host: Mesh },
}
