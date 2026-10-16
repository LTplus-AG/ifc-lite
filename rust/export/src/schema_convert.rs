// SPDX-License-Identifier: MPL-2.0
//! IFC **schema conversion** for STEP export (Phase 2 P2). Ports
//! `packages/export/src/schema-converter.ts`: entity-type renames between
//! IFC2X3 / IFC4 / IFC4X3 / IFC5 (with multi-step chaining), trimming or padding
//! the attribute list wherever one schema only appended to the other (attribute
//! names from core's EXPRESS registry, #7683), and a proxy fallback for types
//! with no target representation.

use std::borrow::Cow;

use crate::schema_ifc2x3_slots::Ifc2x3SlotFill;
use crate::schema_enum::ConversionChecks;
use crate::schema_plan::{plan_for, Adjust, Plan};
use crate::schema_unrepresented::{product_proxy, resolve_unrepresented_entity, UnrepresentedEntityError};
use crate::step_slot::split_top_level_args;

/// Canonicalize a FILE_SCHEMA label to one of the four families we convert between.
pub(crate) fn canon(s: &str) -> &'static str {
    let u = s.to_uppercase();
    if u.starts_with("IFC2X3") {
        "IFC2X3"
    } else if u.starts_with("IFC4X3") {
        "IFC4X3"
    } else if u.starts_with("IFC4") {
        "IFC4"
    } else if u.starts_with("IFC5") || u.starts_with("IFCX") {
        "IFC5"
    } else {
        "IFC4"
    }
}

fn map_2x3_to_4(t: &str) -> Option<&'static str> {
    Some(match t {
        "IFCELECTRICDISTRIBUTIONPOINT" => "IFCELECTRICDISTRIBUTIONBOARD",
        "IFCGASTERMINALTYPE" => "IFCBURNERTYPE",
        "IFCEQUIPMENTELEMENT" => "IFCBUILDINGELEMENTPROXY",
        _ => return None,
    })
}

fn map_4_to_2x3(t: &str) -> Option<&'static str> {
    Some(match t {
        "IFCELECTRICDISTRIBUTIONBOARD" => "IFCELECTRICDISTRIBUTIONPOINT",
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
/// The `trim` below has no twin, and that is a real divergence rather than a
/// compensation: NEITHER splitter trims its tokens (measured:
/// `splitTopLevelStepArguments("'a' ,  $  , #3 ")` returns
/// `["'a' ", "  $  ", " #3 "]`). So a source slot written `  $  ` is
/// normalised to `$` here and passed through verbatim there. It predates
/// #4714, it is whitespace-only, and the four mandatory slots this doc is
/// about are overwritten by the fill either way; left as found rather than
/// changed on the way past.
fn remap_attrs_by_name(values: &[String], src_names: &[&str], tgt_names: &[&str]) -> String {
    let mut by_name: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    for (name, value) in src_names.iter().zip(values.iter()) {
        by_name.insert(*name, value.as_str());
    }
    tgt_names
        .iter()
        .map(|name| {
            let given = by_name.get(name).copied().filter(|v| v.trim() != "$");
            given.unwrap_or("$")
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// Source values a by-name remap has no same-named target slot for.
fn values_without_a_name(values: &[String], src_names: &[&str], tgt_names: &[&str]) -> usize {
    src_names.iter().zip(values).filter(|(name, v)| !tgt_names.contains(name) && holds_value(v)).count()
}

/// A slot that carries information: not `$`, `*` or empty.
fn holds_value(slot: &str) -> bool {
    !matches!(slot.trim(), "" | "$" | "*")
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

/// IFC4X3 alignment and positioning types with no representation in IFC2X3 or
/// IFC4, replaced by [`product_proxy`]. The positioning types used to be
/// RENAMED to `IFCPROXY` instead, which kept their own attributes under the
/// new name: `IFCALIGNMENT(…,.ROAD.)` became an 8-attribute `IFCPROXY` with an
/// alignment enum in `ProxyType`, where IfcProxy takes 9 (EXPORT-MERGE-8, #7683).
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

/// True when `shorter` is a STRICT prefix of `longer` by attribute name: the
/// longer list only APPENDED attributes. Padding (`shorter` is the source)
/// and trimming (`shorter` is the target) are only safe then; many entities
/// insert or reorder attributes mid-list (IfcMaterialProperties, IfcApproval),
/// where either would shift values into the wrong slots. Twin of the
/// TypeScript `isStrictAttrPrefix`.
pub(crate) fn is_strict_attr_prefix(shorter: &[&str], longer: &[&str]) -> bool {
    shorter.len() < longer.len() && longer.starts_with(shorter)
}

/// Convert an entity type name between schemas (with multi-step chaining).
/// The export path asks [`rename_type`] through `schema_plan`; this owned form
/// is what the tests pin.
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
    const A: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
    let mut n = id as u64 + 0x1000_0000;
    let mut s = [b'0'; 22];
    let mut i = 22;
    while i > 0 && n > 0 {
        i -= 1;
        s[i] = A[(n % 64) as usize];
        n /= 64;
    }
    String::from_utf8(s.to_vec()).unwrap()
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
    if let Some(checks) = checks {
        converted = checks.enums.apply(converted, cto);
        let ifc4_downgrade = cto == "IFC4" && (cfrom == "IFC4X3" || cfrom == "IFC5");
        ifc4_downgrade.then(|| checks.ifc4_slots.count(&converted));
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
    checks: Option<&mut ConversionChecks>,
) -> Result<String, UnrepresentedEntityError> {
    // Parse #ID=TYPE(attrs); (multi-line tolerant: rfind ')').
    let trimmed = line.trim_end();
    let body = trimmed.strip_suffix(';').unwrap_or(trimmed);
    let eq = match body.find('=') {
        Some(e) => e,
        None => return Ok(line.to_string()),
    };
    let prefix = &body[..=eq]; // "#123="
    let after = &body[eq + 1..];
    let popen = match after.find('(') {
        Some(p) => p,
        None => return Ok(line.to_string()),
    };
    let aclose = match after.rfind(')') {
        Some(c) if c > popen => c,
        _ => return Ok(line.to_string()),
    };
    let raw_type = after[..popen].trim();
    // Writers emit uppercase type names; only allocate for one that is not.
    let entity_type: Cow<'_, str> = if raw_type.bytes().any(|b| b.is_ascii_lowercase() || !b.is_ascii()) {
        Cow::Owned(raw_type.to_uppercase())
    } else {
        Cow::Borrowed(raw_type)
    };
    let attrs = &after[popen + 1..aclose];

    // Validate before choosing any conversion branch. Otherwise a malformed
    // slot list can still receive a type rename, proxy replacement, trim, or
    // padding and become a partially converted record (#4200). The one split
    // is then reused by every branch below.
    let Some(args) = split_top_level_args(attrs) else {
        return Ok(line.to_string());
    };

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
        Plan::Write { renamed, adjust } => {
            let new_type = renamed.unwrap_or(&entity_type);
            let final_attrs: Cow<'_, str> = match adjust {
                Adjust::Trim(n) if !args.is_empty() => {
                    let keep = n.min(args.len());
                    lost = args[keep..].iter().filter(|v| holds_value(v)).count();
                    Cow::Owned(args[..keep].join(","))
                }
                // An attribute-less record is left alone rather than fabricated
                // from nothing, matching the TypeScript twin's `currentCount > 0`.
                Adjust::Pad(n) if !args.is_empty() && n > args.len() => {
                    Cow::Owned(format!("{attrs}{}", ",$".repeat(n - args.len())))
                }
                Adjust::ByName(src, tgt) => {
                    lost = values_without_a_name(&args, src, tgt);
                    Cow::Owned(remap_attrs_by_name(&args, src, tgt))
                }
                Adjust::Trim(_) | Adjust::Pad(_) | Adjust::Keep => Cow::Borrowed(attrs),
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
    canon(to) == "IFC2X3"
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
