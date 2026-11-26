// SPDX-License-Identifier: MPL-2.0
//! The constant IFC4 action an IFC2X3 varying action is written as when its
//! locations and subsequent loads cannot be written as an
//! IfcStructuralLoadConfiguration (#11037): the initial load stays, PredefinedType
//! is CONST. The one home of that fallback, for the filtered or edited export
//! (`schema_structural_varying_effective`) and the full one
//! (`StructuralVarying::rewrite`), so the two cannot drift (#11354). Twin of
//! `packages/export/src/schema-structural-varying-constant.ts`.
use crate::schema_convert::holds_value;

/// The slots a configuration would have held: VaryingAppliedLoadLocation, SubsequentAppliedLoads.
const OMITTED_SLOTS: [(usize, &str); 2] = [(12, "varying locations"), (13, "subsequent loads")];
fn loss(omitted: &[&str]) -> String {
    format!("The retained varying structural action has no complete load configuration; its {} were omitted (#11037).", omitted.join(" and "))
}
pub(super) fn require_applied_load(id: u32, ty: &str, load: bool) -> Result<(), crate::schema_unrepresented::UnrepresentedEntityError> {
    if load {
        return Ok(());
    }
    Err(crate::schema_unrepresented::UnrepresentedEntityError {
        express_id: id,
        entity_type: ty.into(),
        to_schema: "IFC4".into(),
        reason: Some("the constant action has no usable AppliedLoad (#11354)."),
    })
}

/// The target body, its loss warnings and the attribute values it drops.
pub(crate) struct Constant {
    pub(crate) body: String,
    pub(crate) warnings: Vec<String>,
    pub(crate) dropped: usize,
}

/// `args` are the 14 IFC2X3 attributes of the varying action `ty`.
/// AppliedLoad must name an eligible direct load before calling this function.
pub(crate) fn constant_action(target: &str, ty: &str, args: &[String], cause_carried: bool) -> Constant {
    let omitted: Vec<&str> = OMITTED_SLOTS.iter().filter(|(at, _)| holds_value(&args[*at])).map(|(_, name)| *name).collect();
    // Reported only when a slot held a value, and naming only those (#11354).
    let mut warnings = if omitted.is_empty() { vec![] } else { vec![loss(&omitted)] };
    let mut dropped = omitted.len();
    let applied = &args[7];
    if !cause_carried && holds_value(&args[10]) {
        warnings.push(format!("{ty}.CausedBy has no slot in IFC4; its value is omitted (#11037)."));
        dropped += 1;
    }
    let body = format!("{target}({},{applied},{},{},{},.CONST.)", args[..7].join(","), args[8], args[9], args[11]);
    Constant { body, warnings, dropped }
}
