// SPDX-License-Identifier: MPL-2.0
//! IFC **schema conversion** for STEP export (Phase 2 P2). Ports
//! `packages/export/src/schema-converter.ts`: entity-type renames between
//! IFC2X3 / IFC4 / IFC4X3 / IFC5 (with multi-step chaining), trimming or padding
//! the attribute list wherever one schema only appended to the other (attribute
//! names from core's EXPRESS registry, #7683), and a proxy fallback for types
//! with no target representation.

use std::borrow::Cow;

use ifc_lite_core::SchemaFamily;

use crate::schema_ifc2x3_slots::Ifc2x3SlotFill;
use crate::schema_enum::ConversionChecks;
use crate::schema_plan::{plan_for, Adjust, Plan};
use crate::schema_unrepresented::{product_proxy, resolve_unrepresented_entity, UnrepresentedEntityError};
use crate::step_slot::{slot_is, split_top_level_args};

/// Canonicalize a FILE_SCHEMA label to one of the four families we convert
/// between. Re-export's default for a label naming no family is IFC4.
pub(crate) fn canon(s: &str) -> &'static str {
    SchemaFamily::from_label(s).unwrap_or(SchemaFamily::Ifc4).as_str()
}

fn map_2x3_to_4(t: &str) -> Option<&'static str> {
    Some(match t {
        "IFCELECTRICDISTRIBUTIONPOINT" => "IFCELECTRICDISTRIBUTIONBOARD",
        "IFCGASTERMINALTYPE" => "IFCBURNERTYPE",
        "IFCEQUIPMENTELEMENT" => "IFCBUILDINGELEMENTPROXY",
        "IFCRELCONNECTSSTRUCTURALELEMENT" => "IFCRELASSIGNSTOPRODUCT",
        _ => return None,
    })
}

fn map_4_to_2x3(t: &str) -> Option<&'static str> {
    Some(match t {
        "IFCBURNERTYPE" => "IFCGASTERMINALTYPE",
        "IFCCHIMNEY" | "IFCSHADINGDEVICE" | "IFCCIVILELEMENT" | "IFCGEOGRAPHICELEMENT"
        | "IFCBEARING" | "IFCCOURSE" | "IFCKERB" | "IFCBUILTELEMENT" => "IFCBUILDINGELEMENTPROXY",
        "IFCDEEPFOUNDATION" => "IFCFOOTING",
        "IFCPAVEMENT" => "IFCSLAB",
        "IFCFACILITY" | "IFCBRIDGE" | "IFCROAD" | "IFCRAILWAY" | "IFCMARINEFACILITY" => "IFCBUILDING",
        "IFCFACILITYPART" | "IFCFACILITYPARTCOMMON" | "IFCBRIDGEPART" | "IFCROADPART"
        | "IFCRAILWAYPART" | "IFCMARINEPART" => "IFCBUILDINGSTOREY",
        // IFC4 renamed the IFC2X3 door/window type objects. Left unmapped,
        // `should_skip_entity`-adjacent proxy fallback below treated them as
        // having no IFC2X3 representation and replaced every one with an
        // IFCPROXY carrying a freshly minted GlobalId (mirrors TS #3653).
        // `BY_NAME_ATTR_REMAP_TYPES` reconciles their attribute lists by
        // name since IFC4 inserted ElementType/PredefinedType mid-list.
        "IFCDOORTYPE" => "IFCDOORSTYLE",
        "IFCWINDOWTYPE" => "IFCWINDOWSTYLE",
        // #4206, door/window's bug class: unmapped, fell through to a proxy.
        "IFCSTRUCTURALLOADCASE" => "IFCSTRUCTURALLOADGROUP",
        "IFCSTRUCTURALCURVEACTION" => "IFCSTRUCTURALLINEARACTION",
        "IFCSTRUCTURALSURFACEACTION" => "IFCSTRUCTURALPLANARACTION",
        // #10763: IFC4 deleted this subtype for the now-concrete supertype (`schema_attr_maps`).
        "IFCPROFILEPROPERTIES" => "IFCGENERALPROFILEPROPERTIES",
        _ => return None,
    })
}

/// Renamed types whose source and target attribute lists share names but
/// neither is a positional prefix of the other (IFC4 inserted `ElementType`/
/// `PredefinedType` mid-list on the door/window types; IFC2X3 inserts
/// `CausedBy` where IFC4 appends `PredefinedType` on the structural actions,
/// #4206), so they are reconciled by NAME. The names come from core's
/// registry, like every other list here. Same set as the TypeScript twin's
/// `BY_NAME_ATTR_REMAP_TYPES`.
pub(crate) const BY_NAME_ATTR_REMAP_TYPES: &[&str] =
    &["IFCDOORTYPE", "IFCWINDOWTYPE", "IFCSTRUCTURALCURVEACTION", "IFCSTRUCTURALSURFACEACTION"];

/// Reconcile a renamed entity's attribute list by matching attribute NAMES
/// between the source and target schema tables, rather than by position.
/// A target attribute with no same-named source attribute becomes `$`
/// (unknown); a source attribute with no same-named target slot is dropped.
///
/// The `$` is not the last word on a slot IFC2X3 requires a value in.
/// `IfcDoorStyle`/`IfcWindowStyle` declare `OperationType`,
/// `ConstructionType`, `ParameterTakesPrecedence` and `Sizeable` mandatory,
/// and `IfcDoorType`/`IfcWindowType` have no `ConstructionType` or `Sizeable`
/// at all; [`Ifc2x3SlotFill`] settles all four from the generated
/// required-slot table straight after this runs, because the remap's output
/// carries exactly the target's attribute count. Same policy and same shape as
/// the TypeScript twin's `remapRenamedAttributesByName`, which reaches it
/// through its own fill: `convertStepLine` applies one on every IFC2X3 target,
/// substituting a throwaway when the caller passes none.
///
fn remap_attrs_by_name(values: &[String], src_names: &[&str], tgt_names: &[&str]) -> String {
    let mut by_name: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    for (name, value) in src_names.iter().zip(values.iter()) {
        by_name.insert(*name, value.as_str());
    }
    tgt_names
        .iter()
        .map(|name| {
            let given = by_name.get(name).copied().filter(|v| !crate::step_slot::slot_is(v, "$"));
            given.unwrap_or("$")
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// Source values a by-name remap has no same-named target slot for.
fn values_without_a_name(values: &[String], src_names: &[&str], tgt_names: &[&str], cause_carried: bool) -> usize {
    src_names.iter().zip(values).filter(|(name, v)| {
        !tgt_names.contains(name) && holds_value(v) && !(cause_carried && **name == "CausedBy")
    }).count()
}

/// A slot that carries information: not `$`, `*` or empty once comments go (#10779).
/// Twin of the TypeScript `holdsValue` (`step-comment-skip.ts`).
pub(crate) fn holds_value(slot: &str) -> bool {
    let bare = if slot.contains("/*") { Cow::Owned(crate::step_slot::without_comments(slot)) } else { Cow::Borrowed(slot.trim()) };
    !matches!(&*bare, "" | "$" | "*")
}

fn map_4x3_to_4(t: &str) -> Option<&'static str> {
    Some(match t {
        "IFCFACILITY" | "IFCBRIDGE" | "IFCROAD" | "IFCRAILWAY" | "IFCMARINEFACILITY" => "IFCBUILDING",
        "IFCFACILITYPART" | "IFCFACILITYPARTCOMMON" | "IFCBRIDGEPART" | "IFCROADPART"
        | "IFCRAILWAYPART" | "IFCMARINEPART" => "IFCBUILDINGSTOREY",
        "IFCBUILTELEMENT" | "IFCEARTHWORKSCUT" | "IFCEARTHWORKSELEMENT" | "IFCEARTHWORKSFILL"
        | "IFCNAVIGATIONELEMENT" | "IFCMOORINGDEVICE" | "IFCRAIL" | "IFCREINFORCEDSOIL"
        | "IFCSIGN" | "IFCSIGNAL" | "IFCTRACKELEMENT" | "IFCKERB" | "IFCCOURSE" => {
            "IFCBUILDINGELEMENTPROXY"
        }
        "IFCCAISSONFOUNDATION" => "IFCFOOTING",
        "IFCPAVEMENT" => "IFCSLAB",
        "IFCCONVEYORSEGMENT" => "IFCFLOWSEGMENT",
        "IFCLIQUIDTERMINAL" => "IFCFLOWTERMINAL",
        "IFCMOBILETELECOMMUNICATIONSAPPLIANCE" => "IFCCOMMUNICATIONSAPPLIANCE",
        "IFCDISTRIBUTIONBOARD" => "IFCELECTRICDISTRIBUTIONBOARD",
        "IFCELECTRICFLOWTREATMENTDEVICE" => "IFCFLOWTREATMENTDEVICE",
        _ => return None,
    })
}

/// IFC4X3 alignment and positioning types replaced by [`product_proxy`] in
/// IFC2X3 or IFC4. A bare rename would keep the wrong slot count and put the
/// alignment enum in `ProxyType` (EXPORT-MERGE-8, #7683).
pub(crate) fn should_skip_entity(t: &str, to: &str) -> bool {
    if to == "IFC4X3" || to == "IFC5" {
        return false;
    }
    matches!(
        t,
        "IFCALIGNMENTCANT" | "IFCALIGNMENTHORIZONTAL" | "IFCALIGNMENTVERTICAL" | "IFCALIGNMENTSEGMENT"
            | "IFCALIGNMENT" | "IFCREFERENT" | "IFCLINEARELEMENT" | "IFCPOSITIONINGELEMENT"
            | "IFCLINEARPOSITIONINGELEMENT"
    )
}

/// Positional attribute names `entity_type` declares in the canonical schema
/// `schema`, from core's EXPRESS registry: the one home for them (#7683).
/// `None` for an undeclared type, and for IFC5, which has no EXPRESS
/// registry (the TypeScript twin's `attrNameTable` answers `null` there too,
/// so neither side adjusts an IFC5 record's attribute count).
pub(crate) fn schema_attribute_names(schema: &str, entity_type: &str) -> Option<&'static [&'static str]> {
    match schema {
        "IFC2X3" | "IFC4" | "IFC4X3" => ifc_lite_core::attribute_names_for_schema(schema, entity_type),
        _ => None,
    }
}

/// Convert an entity type name between schemas (with multi-step chaining).
/// This owned test helper uses the same [`rename_type`] as the schema plan.
#[cfg(test)]
pub(crate) fn convert_entity_type(entity_type: &str, from: &str, to: &str) -> String {
    let (from, to) = (canon(from), canon(to));
    if from == to {
        return entity_type.to_string();
    }
    let u = entity_type.to_uppercase();
    rename_type(&u, from, to).map_or(u, str::to_string)
}

/// The renamed type for an uppercase `u` between two canonical schemas, or
/// `None` when it keeps its name.
pub(crate) fn rename_type(u: &str, from: &str, to: &str) -> Option<&'static str> {
    if to == "IFC2X3" {
        if let Some(target) = crate::schema_mep::ifc2x3_type(u) {
            return Some(target);
        }
    }
    match (from, to) {
        // 2X3 → 4 (then 4 → 4X3 is a no-op rename-wise)
        ("IFC2X3", "IFC4") | ("IFC2X3", "IFC4X3") | ("IFC2X3", "IFC5") => map_2x3_to_4(u),
        ("IFC4", "IFC2X3") => map_4_to_2x3(u),
        ("IFC4X3", "IFC4") | ("IFC5", "IFC4") => map_4x3_to_4(u),
        ("IFC4X3", "IFC2X3") | ("IFC5", "IFC2X3") => match map_4x3_to_4(u) {
            Some(s1) => Some(map_4_to_2x3(s1).unwrap_or(s1)),
            None => map_4_to_2x3(u),
        },
        // 4 ↔ 4X3 / 5 carry no entity renames in this table.
        _ => None,
    }
}

/// Deterministic 22-char IFC-GUID-shaped placeholder derived from an express id
/// (used for proxy fallbacks + synthesized pset/rel entities; avoids a clock/RNG in wasm).
pub(crate) fn placeholder_guid(id: u32) -> String {
    ifc_lite_core::guid::placeholder(id)
}

/// Convert one STEP entity line `#id=TYPE(attrs);` from `from` to `to`.
/// Returns the line unchanged when it isn't a parseable entity line.
///
/// On a downgrade to IFC2X3, `slots` settles the slots IFC2X3 requires a value
/// in that the converted record still holds `$` in: `OwnerHistory` by reuse
/// (#4686) and the rest from the generated required-slot table (#4714); see
/// [`crate::schema_ifc2x3_slots`]. Required rather than defaulted, so an
/// exporter cannot convert without having decided which owner history it
/// writes, and cannot lose the count of what stayed `$`.
///
/// `checks`: enum members the target lacks (#5365); IFC4-required `$` slots, counted (#5307).
///
/// Errs for a type with no representation in `to` at all (#5116, [`crate::schema_unrepresented`]).
pub fn convert_step_line(
    line: &str,
    from: &str,
    to: &str,
    express_id: u32,
    slots: &mut Ifc2x3SlotFill,
    checks: Option<&mut ConversionChecks>,
) -> Result<String, UnrepresentedEntityError> {
    let (cfrom, cto) = (canon(from), canon(to));
    if cfrom == cto {
        return Ok(line.to_string());
    }
    let mut checks = checks;
    let mut converted = convert_record(line, cfrom, cto, express_id, checks.as_deref_mut())?;
    converted = crate::schema_retyped::apply(converted, cfrom, cto, checks.as_deref_mut().map(|c| &mut c.attribute_values_dropped)); // #10778
    converted = crate::schema_userdefined_label::carry(line, converted, cfrom, cto, checks.as_deref_mut().map(|c| &mut c.attribute_values_dropped)); // #10824
    if let Some(checks) = checks {
        if let Some(repointed) = checks.structural.values.placement(express_id).and_then(|p| crate::step_log::replace_argument(&converted, 5, &format!("#{p}"))) {
            converted = repointed;
        }
        converted = checks.enums.apply(checks.forms.apply(converted, cfrom, cto, express_id, &mut checks.attribute_values_dropped), cto);
        converted = checks.documents.apply(express_id, converted, &mut checks.attribute_values_dropped);
        if cto == "IFC2X3" { converted = checks.structural.after(express_id, converted); }
        (cto == "IFC4" && (cfrom != "IFC2X3" || crate::schema_attr_maps::upgrade_counts_ifc4_slots(&converted))).then(|| checks.ifc4_slots.count(&converted));
    }
    Ok(if cto == "IFC2X3" { slots.apply(converted) } else { converted })
}

/// [`convert_step_line`] before the IFC2X3 required-slot fills, between two
/// different canonical schemas. With `checks`, the per-type decision comes
/// from its [`crate::schema_plan::PlanCache`] and the values the conversion
/// had no target slot for are counted into it.
fn convert_record(
    line: &str,
    cfrom: &'static str,
    cto: &'static str,
    express_id: u32,
    mut checks: Option<&mut ConversionChecks>,
) -> Result<String, UnrepresentedEntityError> {
    // Comments can contain delimiters. Use the same frame as the source
    // prepasses for commented records and keep the simple path for plain lines.
    let (prefix, raw_type, attrs) = if let Some(frame) = line.contains("/*").then(|| crate::step_record_frame::record_frame(line)).flatten() {
        (&line[..=frame.head.eq], frame.head.type_name(line), frame.args(line))
    } else {
        let trimmed = line.trim_end();
        let body = trimmed.strip_suffix(';').unwrap_or(trimmed);
        let Some(eq) = body.find('=') else { return Ok(line.to_string()) };
        let after = &body[eq + 1..];
        let Some(open) = after.find('(') else { return Ok(line.to_string()) };
        let Some(close) = after.rfind(')').filter(|&close| close > open) else { return Ok(line.to_string()) };
        (&body[..=eq], after[..open].trim(), &after[open + 1..close])
    };
    // Writers emit uppercase type names; only allocate for one that is not.
    let entity_type: Cow<'_, str> = if raw_type.bytes().any(|b| b.is_ascii_lowercase() || !b.is_ascii()) {
        Cow::Owned(raw_type.to_uppercase())
    } else {
        Cow::Borrowed(raw_type)
    };

    // Validate before choosing any conversion branch. Otherwise a malformed
    // slot list can still receive a type rename, proxy replacement, trim, or
    // padding and become a partially converted record (#4200). The one split
    // is then reused by every branch below.
    let Some(mut args) = split_top_level_args(attrs) else {
        return Ok(line.to_string());
    };

    if let Some(c) = checks.as_deref_mut() {
        if let Some((body, cause_dropped)) = c.structural.rewrite(express_id, &entity_type, &args) {
            c.attribute_values_dropped += usize::from(cause_dropped);
            return Ok(format!("{prefix}{body};"));
        }
    }
    let cause_carried = checks.as_ref().is_some_and(|c| c.structural.cause(express_id, &entity_type).is_some());
    let axis = checks.as_ref().filter(|_| cfrom == "IFC2X3" && cto == "IFC4").and_then(|c| c.structural.axes.axis(express_id, &entity_type, &args));
    if let Some(c) = checks.as_deref_mut() { c.structural.inspect(express_id, &entity_type, &args, cfrom, cto, axis.is_some()); }
    if let Some(axis) = axis { return Ok(format!("{prefix}{entity_type}({},{});", args.join(","), axis)); }
    if let Some(attrs) = crate::schema_structural::attributes(&entity_type, &args, cfrom, cto) {
        if crate::schema_structural::constant_action(&entity_type) {
            if let (Some(c), Some(src), Some(tgt)) = (checks, schema_attribute_names(cfrom, &entity_type), schema_attribute_names(cto, &entity_type)) {
                c.attribute_values_dropped += values_without_a_name(&args, src, tgt, cause_carried);
            }
        }
        return Ok(format!("{prefix}{}({attrs});", rename_type(&entity_type, cfrom, cto).unwrap_or(&entity_type)));
    }
    let (plan, dropped) = match checks {
        Some(c) => (c.plans.get(&entity_type, cfrom, cto), Some(&mut c.attribute_values_dropped)),
        None => (plan_for(&entity_type, cfrom, cto), None),
    };
    let mut lost = 0usize;
    let out = match plan {
        Plan::ProductProxy => {
            // The proxy carries a MINTED GlobalId, not the source entity's, and the
            // authored identity is therefore lost on a downgrade. That is
            // deliberate on the TypeScript twin (`convertStepLine` in
            // `packages/export/src/schema-converter.ts`), which documents the
            // counter-example and pins it in `merged-exporter.test.ts`: two
            // federated models can legitimately carry the SAME alignment GlobalId,
            // and copying the source id would unify two distinct alignments into
            // one. The two implementations do not agree on WHAT to mint — this one
            // derives from the express id, the TypeScript one from the whole source
            // line — so the same model downgraded by each yields different proxy
            // ids. Left as found; changing either is a decision for the maintainer,
            // not a side effect of a round-trip test.
            lost = args.get(7..).unwrap_or_default().iter().filter(|v| holds_value(v)).count();
            product_proxy(prefix, &placeholder_guid(express_id), &entity_type, &args)
        }
        // #5116, see `resolve_unrepresented_entity`'s doc.
        Plan::Unrepresented => return resolve_unrepresented_entity(prefix, &entity_type, cto, express_id),
        // The attribute list against the target schema (#7683): see
        // `schema_plan::plan_for` for which way it moves and why.
        Plan::Write { renamed, adjust, replaced } => {
            let new_type = renamed.unwrap_or(&entity_type);
            // #10758: a slot a schema replaced in place keeps no value across.
            let rebuilt;
            let attrs = match replaced.filter(|&i| args.get(i).is_some_and(|v| !slot_is(v, "$"))) {
                Some(i) => {
                    lost += usize::from(holds_value(&args[i]));
                    args[i] = "$".to_owned();
                    rebuilt = args.join(",");
                    rebuilt.as_str()
                }
                None => attrs,
            };
            let final_attrs: Cow<'_, str> = match adjust {
                Adjust::Trim(n) if !args.is_empty() => {
                    let keep = n.min(args.len());
                    let carried_slot = cause_carried.then_some(crate::schema_structural_carriers::CAUSED_BY);
                    lost += args.iter().enumerate().skip(keep).filter(|(i, v)| Some(*i) != carried_slot && holds_value(v)).count();
                    Cow::Owned(args[..keep].join(","))
                }
                // An attribute-less record is left alone rather than fabricated
                // from nothing, matching the TypeScript twin's `currentCount > 0`.
                Adjust::Pad(n) if !args.is_empty() && n > args.len() => {
                    Cow::Owned(format!("{attrs}{}", ",$".repeat(n - args.len())))
                }
                // `GridFrames` already wrote this one in the target's layout.
                Adjust::ByName(_, tgt) if &*entity_type == crate::schema_grid_frames::GRID_PLACEMENT && args.len() == tgt.len() => Cow::Borrowed(attrs),
                Adjust::ByName(src, tgt) => {
                    lost += values_without_a_name(&args, src, tgt, cause_carried);
                    Cow::Owned(remap_attrs_by_name(&args, src, tgt))
                }
                Adjust::Mapped(map, up, src, tgt) if !args.is_empty() => Cow::Owned(crate::schema_attr_maps::remap(map, up, &args, src, tgt, &mut lost)),
                Adjust::Trim(_) | Adjust::Pad(_) | Adjust::Mapped(..) | Adjust::Keep => Cow::Borrowed(attrs),
            };
            format!("{prefix}{new_type}({final_attrs});")
        }
    };
    if let Some(dropped) = dropped {
        *dropped += lost;
    }
    Ok(out)
}

/// True when `to` names IFC2X3, the one target whose `OwnerHistory` is mandatory.
pub(crate) fn targets_ifc2x3(to: &str) -> bool {
    SchemaFamily::from_label(to) == Some(SchemaFamily::Ifc2x3)
}

/// True when converting between these schemas changes entity types/attributes.
pub fn needs_conversion(from: &str, to: &str) -> bool {
    canon(from) != canon(to)
}

#[cfg(test)]
#[path = "schema_convert_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "schema_registry_tests.rs"]
mod registry_tests;
