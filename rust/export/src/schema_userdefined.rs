// SPDX-License-Identifier: MPL-2.0
//! The `.USERDEFINED.` rule of a PredefinedType (#10780). IFC4's
//! `CorrectPredefinedType` (and many IFC2X3 WHERE rules) let a PredefinedType
//! be `.USERDEFINED.` only when the entity's label attribute (`ObjectType` on
//! an occurrence, `ElementType`, `ProcessType` or `ResourceType` on a type)
//! holds a value. A conversion can write such a record without one: an IFC2X3
//! enum carried into IFC4 as `.USERDEFINED.` with `ObjectType` unset. The
//! converter cannot invent the label, so it reports the record instead.
//!
//! Every non-abstract entity with both attributes has the rule except the ones
//! [`EXEMPT`] lists, re-derived from the EXPRESS files by the tests. Twin of
//! `packages/export/src/schema-converter-userdefined.ts`; both are held to
//! `tests/fixtures/schema_userdefined_rules.json`.

use crate::schema_convert::schema_attribute_names;
use crate::step_slot::split_top_level_args;

/// The label attributes a USERDEFINED rule can require, one per entity.
pub(crate) const LABELS: &[&str] = &["ObjectType", "ElementType", "ProcessType", "ResourceType"];

/// `(schema, entities with both attributes but no USERDEFINED rule)`.
pub(crate) const EXEMPT: &[(&str, &[&str])] = &[
    ("IFC2X3", &[
    "IFCACTUATORTYPE", "IFCALARMTYPE", "IFCBEAMTYPE", "IFCBUILDINGELEMENTPROXYTYPE",
    "IFCCABLECARRIERSEGMENTTYPE", "IFCCABLESEGMENTTYPE", "IFCCOLUMNTYPE", "IFCCONTROLLERTYPE",
    "IFCCOSTSCHEDULE", "IFCCOVERINGTYPE", "IFCCURTAINWALLTYPE", "IFCDISTRIBUTIONCHAMBERELEMENTTYPE",
    "IFCELECTRICAPPLIANCETYPE", "IFCELECTRICFLOWSTORAGEDEVICETYPE", "IFCELECTRICGENERATORTYPE", "IFCELECTRICHEATERTYPE",
    "IFCELECTRICMOTORTYPE", "IFCELECTRICTIMECONTROLTYPE", "IFCFIRESUPPRESSIONTERMINALTYPE", "IFCFLOWINSTRUMENTTYPE",
    "IFCJUNCTIONBOXTYPE", "IFCLAMPTYPE", "IFCLIGHTFIXTURETYPE", "IFCMEMBERTYPE",
    "IFCMOTORCONNECTIONTYPE", "IFCOUTLETTYPE", "IFCPLATETYPE", "IFCPROJECTORDER",
    "IFCPROJECTORDERRECORD", "IFCPROTECTIVEDEVICETYPE", "IFCRAILINGTYPE", "IFCRAMPFLIGHTTYPE",
    "IFCSANITARYTERMINALTYPE", "IFCSENSORTYPE", "IFCSLABTYPE", "IFCSPACETYPE",
    "IFCSTACKTERMINALTYPE", "IFCSTAIRFLIGHTTYPE", "IFCSTRUCTURALANALYSISMODEL", "IFCSTRUCTURALCURVEMEMBER",
    "IFCSTRUCTURALCURVEMEMBERVARYING", "IFCSTRUCTURALLOADGROUP", "IFCSTRUCTURALSURFACEMEMBER", "IFCSTRUCTURALSURFACEMEMBERVARYING",
    "IFCSWITCHINGDEVICETYPE", "IFCTRANSFORMERTYPE", "IFCTRANSPORTELEMENTTYPE", "IFCWALLTYPE",
    "IFCWASTETERMINALTYPE",
    ]),
    ("IFC4", &[
    "IFCACTIONREQUEST", "IFCBUILDINGSYSTEM", "IFCCOSTITEM", "IFCCOSTSCHEDULE",
    "IFCDISTRIBUTIONCIRCUIT", "IFCDISTRIBUTIONPORT", "IFCDISTRIBUTIONSYSTEM", "IFCDOOR",
    "IFCDOORSTANDARDCASE", "IFCEXTERNALSPATIALELEMENT", "IFCGRID", "IFCINVENTORY",
    "IFCOPENINGELEMENT", "IFCOPENINGSTANDARDCASE", "IFCPERFORMANCEHISTORY", "IFCPERMIT",
    "IFCPROJECTIONELEMENT", "IFCPROJECTORDER", "IFCWINDOW", "IFCWINDOWSTANDARDCASE",
    ]),
    ("IFC4X3", &[
    "IFCACTIONREQUEST", "IFCALIGNMENT", "IFCANNOTATION", "IFCCOSTITEM",
    "IFCCOSTSCHEDULE", "IFCDISTRIBUTIONPORT", "IFCEXTERNALSPATIALELEMENT", "IFCGRID",
    "IFCINVENTORY", "IFCPERFORMANCEHISTORY", "IFCPERMIT", "IFCPROJECTORDER",
    "IFCREFERENT",
    ]),
];

/// `(PredefinedType index, label index)` when `entity_type` (uppercase) has
/// the rule in the canonical schema `schema`.
pub(crate) fn rule(schema: &str, entity_type: &str) -> Option<(usize, usize)> {
    let names = schema_attribute_names(schema, entity_type)?;
    let predefined = names.iter().position(|n| *n == "PredefinedType")?;
    let label = names.iter().position(|n| LABELS.contains(n))?;
    let exempt = EXEMPT.iter().find(|(s, _)| *s == schema).is_some_and(|(_, list)| list.contains(&entity_type));
    (!exempt).then_some((predefined, label))
}

/// True when the converted `args` of a record with `rule` say `.USERDEFINED.`
/// and leave the label unset.
pub(crate) fn breaks(args: &[String], (predefined, label): (usize, usize)) -> bool {
    args.len() > predefined.max(label)
        && args[predefined].trim().eq_ignore_ascii_case(".USERDEFINED.")
        && args[label].trim() == "$"
}

/// [`breaks`] for a whole converted line.
pub(crate) fn line_breaks(line: &str, rule: (usize, usize)) -> bool {
    let Some(frame) = crate::step_record_frame::record_frame(line) else { return false };
    split_top_level_args(frame.args(line)).is_some_and(|args| breaks(&args, rule))
}

#[cfg(test)]
#[path = "schema_userdefined_tests.rs"]
mod tests;
