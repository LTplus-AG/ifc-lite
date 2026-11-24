// SPDX-License-Identifier: MPL-2.0
//! The constant IFC4 action an IFC2X3 varying action is written as when its
//! locations and subsequent loads cannot be written as an
//! IfcStructuralLoadConfiguration (#11037): the initial load stays, PredefinedType
//! is CONST. The one home of that fallback, for the filtered or edited export
//! (`schema_structural_varying_effective`) and the full one
//! (`StructuralVarying::rewrite`), so the two cannot drift (#11354). Twin of
//! `packages/export/src/schema-structural-varying-constant.ts`.
use crate::schema_convert::holds_value;

pub(crate) const LOSS: &str = "The retained varying structural action has no complete load configuration; its varying locations and subsequent loads were omitted (#11037).";
pub(crate) const MISSING_LOAD: &str = "The retained varying structural action has no usable AppliedLoad; the required IFC4 slot was left unset (#11037).";

/// The target body, its loss warnings and the attribute values it drops.
pub(crate) struct Constant {
    pub(crate) body: String,
    pub(crate) warnings: Vec<String>,
    pub(crate) dropped: usize,
}

/// `args` are the 14 IFC2X3 attributes of the varying action `ty`. `load`: AppliedLoad
/// names an IfcStructuralLoad. `cause_carried`: a 'Causes' relationship holds the CausedBy.
pub(crate) fn constant_action(target: &str, ty: &str, args: &[String], load: bool, cause_carried: bool) -> Constant {
    let mut warnings = vec![LOSS.to_owned()];
    let mut dropped = 0;
    let mut applied = args[7].as_str();
    if !load {
        dropped += usize::from(holds_value(applied));
        applied = "$";
        warnings.push(MISSING_LOAD.to_owned());
    }
    if !cause_carried && holds_value(&args[10]) {
        warnings.push(format!("{ty}.CausedBy has no slot in IFC4; its value is omitted (#11037)."));
        dropped += 1;
    }
    dropped += [12, 13].into_iter().filter(|&at| holds_value(&args[at])).count();
    let body = format!("{target}({},{applied},{},{},{},.CONST.)", args[..7].join(","), args[8], args[9], args[11]);
    Constant { body, warnings, dropped }
}
