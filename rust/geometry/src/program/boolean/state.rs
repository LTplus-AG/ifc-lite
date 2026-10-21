// SPDX-License-Identifier: MPL-2.0
//! Owned control frames. A suspended operand owns its host and remaining spine.
use crate::processors::boolean::solid_execution::SolidBooleanPlan;
use crate::processors::boolean::{BoundedPrismPlan, HalfSpacePlan};
use crate::{BoolOp, Mesh, Point3, Vector3};
use ifc_lite_core::{DecodedEntity, IfcType};
use std::collections::HashSet;

/// A meshed operand and whether its emptiness is a loss already on record.
pub(crate) type Value = (Mesh, bool);

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

/// A half-space cutter's plane: point, normal and `AgreementFlag`.
pub(super) type CutPlane = (Point3<f64>, Vector3<f64>, bool);

/// One spine step's host and the remaining spine, suspended while its cutter
/// is admitted (source) or applied (numerical).
pub(super) struct Cut {
    pub steps: Steps,
    pub host: Mesh,
}

/// The batched polygonal chain: its base, cutters, and the prisms built so
/// far, in cutter order.
pub(super) struct Batch {
    pub walk: Walk,
    pub cutters: Vec<DecodedEntity>,
    /// The failure-log mark every deferral rewinds to.
    pub mark: usize,
    pub base: Mesh,
    pub prisms: Vec<Mesh>,
    /// The unit scale read by the latest cutter admission.
    pub length_unit_scale: f64,
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
    /// A solid second operand is meshed: read the late unit scale.
    AfterStep { steps: Steps, operator: BoolOp, host: Mesh },
    /// The solid/solid boolean over the meshed host and operand.
    Solid { steps: Steps, plan: SolidBooleanPlan, host: Mesh, second: Value },
    /// A DIFFERENCE by a plane half-space: the clip.
    HalfSpace { cut: Cut, plan: HalfSpacePlan },
    /// A polygonal-bounded cutter: does the host reach the removed side?
    Polygonal { cut: Cut, cutter: DecodedEntity, plane: CutPlane },
    /// Read the polygonal cutter's prism boundary.
    PolygonalPrism { cut: Cut, cutter: DecodedEntity, plane: CutPlane },
    /// Build the prism and subtract it, or fall back to the unbounded clip
    /// (`prism: None`: the boundary did not read).
    PolygonalCut { cut: Cut, plane: CutPlane, prism: Option<BoundedPrismPlan>, length_unit_scale: f64 },
    /// Admit the next batched cutter's plane and boundary.
    BatchLower(Batch),
    /// Build the admitted cutter's prism around the base.
    BatchBuild(Batch, CutPlane, BoundedPrismPlan),
    /// Every prism is built: one grouped subtract.
    BatchGroup(Batch),
    /// A deferred batch resumes the sequential spine at its next node.
    Defer(Walk),
}

impl Frame {
    /// A recursive operand continues on the stack rather than being meshed.
    pub(super) fn dispatches(entity: &DecodedEntity) -> bool {
        matches!(
            entity.ifc_type,
            IfcType::IfcCsgSolid | IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult
        )
    }

    /// Owned arithmetic over meshed operands: reads no source.
    pub(super) fn is_numerical(&self) -> bool {
        matches!(
            self,
            Self::Solid { .. } | Self::HalfSpace { .. } | Self::Polygonal { .. } | Self::PolygonalCut { .. }
                | Self::BatchBuild(..) | Self::BatchGroup(_)
        )
    }

    /// Pure control: settled after any step, reading no source.
    pub(super) fn is_control(&self) -> bool {
        match self {
            Self::Boolean(..) | Self::ExitPath(_) | Self::AfterBase(_) | Self::AfterBatch { .. } => true,
            Self::Operand { entity, .. } => Self::dispatches(entity),
            _ => false,
        }
    }
}
