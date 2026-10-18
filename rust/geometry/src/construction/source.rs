// SPDX-License-Identifier: MPL-2.0
//! Ordered source operation admission; shared with the production operator rule.
use super::{Construction, ConstructionRequirement as Requirement};
use super::leaf::lower_leaf;
use super::brep_operand::BrepOperandPlan;
use super::program::Instruction;
use crate::GeometryRouter;
use crate::processors::boolean::{boolean_operator, solid_execution::SolidBooleanPlan};
use crate::router::{builtin_family, ProcessorOrigin};
use ifc_lite_core::{slot, EntityDecoder, IfcSchema, IfcType};

// Context belongs in the memo key: Base preserves Outer-only, while an
// operation operand owns its void-subtracted meaning and diagnostic operator.
pub(super) use crate::processors::boolean::spine_plan::OperandRole as Role;
pub(super) type Key = (u32, Role);
pub(super) enum Admission { Leaf(Construction), Operation(Pending) }
pub(super) enum Pending {
    Boolean { first: Key, second: Key, plan: SolidBooleanPlan },
    Csg { root: Key },
}

impl Pending {
    pub(super) fn dependencies(&self) -> impl Iterator<Item = Key> {
        match self {
            Self::Boolean { first, second, .. } => [Some(*first), Some(*second)],
            Self::Csg { root } => [Some(*root), None],
        }.into_iter().flatten()
    }

    pub(super) fn resolve(self, index: impl Fn(Key) -> usize) -> Instruction {
        match self {
            Self::Boolean { first, second, plan } => Instruction::Boolean {
                first: index(first), second: index(second), plan,
            },
            Self::Csg { root } => Instruction::Csg { root: index(root) },
        }
    }
}

pub(super) fn admit(router: &GeometryRouter, schema: &IfcSchema,
    decoder: &mut EntityDecoder, key: Key) -> std::result::Result<Admission, Requirement> {
    if router.length_unit_refused() { return Err(Requirement::LengthUnitRefused); }
    let entity = decoder.decode_by_id(key.0)
        .map_err(|error| Requirement::SourceAdmission(error.to_string()))?;
    if key.1 == Role::Root && router.processor_origin(&entity.ifc_type) == Some(ProcessorOrigin::Custom) {
        return Err(Requirement::CustomProcessor);
    }
    match entity.ifc_type {
        IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult => {
            let operator = boolean_operator(&entity).map_err(|keyword|
                Requirement::OperationPolicyNotLowered(format!("unknown boolean operator {keyword}")))?;
            let first = entity.ref_at(slot::IfcBooleanResult::FIRST_OPERAND)
                .ok_or_else(|| Requirement::SourceAdmission("BooleanResult missing FirstOperand reference".into()))?;
            let second = entity.ref_at(slot::IfcBooleanResult::SECOND_OPERAND)
                .ok_or_else(|| Requirement::OperationPolicyNotLowered("unreadable second-operand recovery".into()))?;
            let plan = SolidBooleanPlan { operator, length_unit_scale: decoder.length_unit_scale(),
                quality: router.tessellation_quality(), skip_small_cuts: router.skip_small_cuts() };
            Ok(Admission::Operation(Pending::Boolean { first: (first, Role::Base), second: (second, Role::Operation(operator)), plan }))
        }
        IfcType::IfcCsgSolid => {
            let root = entity.ref_at(slot::IfcCsgSolid::TREE_ROOT_EXPRESSION)
                .ok_or_else(|| Requirement::SourceAdmission("IfcCsgSolid missing TreeRootExpression reference".into()))?;
            let root_entity = decoder.decode_by_id(root)
                .map_err(|error| Requirement::SourceAdmission(error.to_string()))?;
            if !matches!(root_entity.ifc_type, IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult
                | IfcType::IfcBlock | IfcType::IfcSphere) {
                return Err(Requirement::SourceAdmission(format!("Unsupported IfcCsgSolid TreeRootExpression: {}", root_entity.ifc_type)));
            }
            Ok(Admission::Operation(Pending::Csg { root: (root, Role::Base) }))
        }
        IfcType::IfcSurfaceOfLinearExtrusion if key.1 != Role::Root => Err(Requirement::OperationPolicyNotLowered(
            "open swept surface is not a solid operand".into())),
        IfcType::IfcFacetedBrepWithVoids | IfcType::IfcAdvancedBrepWithVoids
            if matches!(key.1, Role::Operation(_)) => {
            let plan = BrepOperandPlan::lower(&entity, decoder,
                router.tessellation_quality(), key.1.diagnostic_operator())
                .map_err(|error| Requirement::SourceAdmission(error.to_string()))?;
            // Eager source evidence remains available even when another root
            // prevents execution. Evaluation replays shell reports in order.
            crate::processors::diagnostic_capture::restore(&plan.source_reports());
            Ok(Admission::Leaf(Construction::BrepOperand(plan)))
        }
        _ => lower_leaf(router, schema, decoder, &entity, builtin_family(&entity.ifc_type))
            .map(Admission::Leaf),
    }
}
