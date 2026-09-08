// SPDX-License-Identifier: MPL-2.0
//! IFC **schema conversion** for STEP export (Phase 2 P2). Ports
//! `packages/export/src/schema-converter.ts`: entity-type renames between
//! IFC2X3 / IFC4 / IFC4X3 / IFC5 (with multi-step chaining), IFC2X3 attribute-count
//! trimming on downgrade, padding of the attributes a newer target schema appended
//! (`schema_pad`), and a proxy fallback for types with no target representation.

/// Canonicalize a FILE_SCHEMA label to one of the four families we convert between.
fn canon(s: &str) -> &'static str {
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
        _ => return None,
    })
}

/// Source (IFC4) and target (IFC2X3) EXPRESS attribute names for the two
/// door/window-type renames above, in the order STEP encodes them. Neither
/// list is a positional prefix of the other (IFC4 inserted `ElementType`/
/// `PredefinedType` ahead of the attributes it kept), so
/// `convert_step_line` reconciles them by NAME rather than trimming a
/// positional suffix like every other IFC2X3-downgrade rename.
fn by_name_attr_remap_names(entity_type: &str) -> Option<(&'static [&'static str], &'static [&'static str])> {
    match entity_type {
        "IFCDOORTYPE" => Some((
            &[
                "GlobalId", "OwnerHistory", "Name", "Description", "ApplicableOccurrence",
                "HasPropertySets", "RepresentationMaps", "Tag", "ElementType", "PredefinedType",
                "OperationType", "ParameterTakesPrecedence", "UserDefinedOperationType",
            ],
            &[
                "GlobalId", "OwnerHistory", "Name", "Description", "ApplicableOccurrence",
                "HasPropertySets", "RepresentationMaps", "Tag", "OperationType", "ConstructionType",
                "ParameterTakesPrecedence", "Sizeable",
            ],
        )),
        "IFCWINDOWTYPE" => Some((
            &[
                "GlobalId", "OwnerHistory", "Name", "Description", "ApplicableOccurrence",
                "HasPropertySets", "RepresentationMaps", "Tag", "ElementType", "PredefinedType",
                "PartitioningType", "ParameterTakesPrecedence", "UserDefinedPartitioningType",
            ],
            &[
                "GlobalId", "OwnerHistory", "Name", "Description", "ApplicableOccurrence",
                "HasPropertySets", "RepresentationMaps", "Tag", "ConstructionType", "OperationType",
                "ParameterTakesPrecedence", "Sizeable",
            ],
        )),
        _ => None,
    }
}

/// Reconcile a renamed entity's attribute list by matching attribute NAMES
/// between the source and target schema tables, rather than by position.
/// A target attribute with no same-named source attribute becomes `$`
/// (unknown); a source attribute with no same-named target slot is dropped.
/// Mirrors TS `schema-converter-attr-remap.ts`'s `remapRenamedAttributesByName`.
fn remap_attrs_by_name(attrs: &str, src_names: &[&str], tgt_names: &[&str]) -> String {
    let values = split_top_level(attrs);
    let mut by_name: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    for (name, value) in src_names.iter().zip(values.iter()) {
        by_name.insert(*name, value.as_str());
    }
    tgt_names
        .iter()
        .map(|name| by_name.get(name).copied().unwrap_or("$"))
        .collect::<Vec<_>>()
        .join(",")
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
        "IFCLINEARPOSITIONINGELEMENT" | "IFCPOSITIONINGELEMENT" | "IFCREFERENT" | "IFCALIGNMENT"
        | "IFCLINEARELEMENT" => "IFCPROXY",
        "IFCCONVEYORSEGMENT" => "IFCFLOWSEGMENT",
        "IFCLIQUIDTERMINAL" => "IFCFLOWTERMINAL",
        "IFCMOBILETELECOMMUNICATIONSAPPLIANCE" => "IFCCOMMUNICATIONSAPPLIANCE",
        "IFCDISTRIBUTIONBOARD" => "IFCELECTRICDISTRIBUTIONBOARD",
        "IFCELECTRICFLOWTREATMENTDEVICE" => "IFCFLOWTREATMENTDEVICE",
        _ => return None,
    })
}

/// Max positional attributes an entity may carry in IFC2X3 (for downgrade trimming).
fn ifc2x3_attr_count(t: &str) -> Option<usize> {
    Some(match t {
        "IFCWALL" | "IFCBEAM" | "IFCCOLUMN" | "IFCMEMBER" | "IFCPLATE" | "IFCOPENINGELEMENT"
        | "IFCFURNISHINGELEMENT" | "IFCCURTAINWALL" | "IFCFLOWSEGMENT" | "IFCFLOWTERMINAL"
        | "IFCFLOWCONTROLLER" | "IFCFLOWFITTING" | "IFCFLOWMOVINGDEVICE" | "IFCFLOWSTORAGEDEVICE"
        | "IFCFLOWTREATMENTDEVICE" | "IFCENERGYCONVERSIONDEVICE" | "IFCDISTRIBUTIONELEMENT"
        | "IFCDISTRIBUTIONFLOWELEMENT" | "IFCDISTRIBUTIONCONTROLELEMENT"
        | "IFCDISTRIBUTIONCHAMBERELEMENT" => 8,
        "IFCROOF" | "IFCSTAIR" | "IFCRAMP" | "IFCRAILING" | "IFCFOOTING" | "IFCCOVERING"
        | "IFCBUILDINGELEMENTPROXY" => 9,
        "IFCPILE" => 11,
        "IFCDOOR" | "IFCWINDOW" => 10,
        _ => return None,
    })
}

/// Alignment types with no representation in IFC2X3/IFC4 (replaced by a proxy).
fn should_skip_entity(t: &str, to: &str) -> bool {
    if to == "IFC4X3" || to == "IFC5" {
        return false;
    }
    matches!(
        t,
        "IFCALIGNMENTCANT" | "IFCALIGNMENTHORIZONTAL" | "IFCALIGNMENTVERTICAL" | "IFCALIGNMENTSEGMENT"
    )
}

/// Convert an entity type name between schemas (with multi-step chaining).
pub fn convert_entity_type(entity_type: &str, from: &str, to: &str) -> String {
    let (from, to) = (canon(from), canon(to));
    if from == to {
        return entity_type.to_string();
    }
    let u = entity_type.to_uppercase();
    match (from, to) {
        ("IFC2X3", "IFC4") | ("IFC2X3", "IFC4X3") | ("IFC2X3", "IFC5") => {
            // 2X3 → 4 (then 4 → 4X3 is a no-op rename-wise)
            map_2x3_to_4(&u).unwrap_or(&u).to_string()
        }
        ("IFC4", "IFC2X3") => map_4_to_2x3(&u).unwrap_or(&u).to_string(),
        ("IFC4X3", "IFC4") | ("IFC5", "IFC4") => map_4x3_to_4(&u).unwrap_or(&u).to_string(),
        ("IFC4X3", "IFC2X3") | ("IFC5", "IFC2X3") => {
            let s1 = map_4x3_to_4(&u).unwrap_or(&u);
            map_4_to_2x3(s1).unwrap_or(s1).to_string()
        }
        // 4 ↔ 4X3 / 5 carry no entity renames in this table.
        _ => u,
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

/// Split a raw STEP attribute list into its top-level (comma-separated)
/// value strings, respecting nested parentheses and single-quoted strings.
/// Empty list -> `[]`. Shared by `trim_attributes` (positional truncation)
/// and `remap_attrs_by_name` (by-name reconciliation).
fn split_top_level(attrs: &str) -> Vec<String> {
    if attrs.trim().is_empty() {
        return Vec::new();
    }
    let bytes = attrs.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut current = String::new();
    let mut i = 0;
    while i < bytes.len() {
        let ch = bytes[i] as char;
        if ch == '\'' && !in_string {
            in_string = true;
            current.push(ch);
        } else if ch == '\'' && in_string {
            if i + 1 < bytes.len() && bytes[i + 1] == b'\'' {
                current.push_str("''");
                i += 2;
                continue;
            }
            in_string = false;
            current.push(ch);
        } else if in_string {
            current.push(ch);
        } else if ch == '(' {
            depth += 1;
            current.push(ch);
        } else if ch == ')' {
            depth -= 1;
            current.push(ch);
        } else if ch == ',' && depth == 0 {
            out.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
        i += 1;
    }
    out.push(current);
    out
}

/// Trim a STEP attribute list to `max_count` top-level attributes (STEP-nesting aware).
fn trim_attributes(attrs: &str, max_count: usize) -> String {
    if attrs.trim().is_empty() {
        return attrs.to_string();
    }
    let out = split_top_level(attrs);
    if out.len() > max_count {
        out[..max_count].join(",")
    } else {
        out.join(",")
    }
}

/// Convert one STEP entity line `#id=TYPE(attrs);` from `from` to `to`.
/// Returns the line unchanged when it isn't a parseable entity line.
pub fn convert_step_line(line: &str, from: &str, to: &str, express_id: u32) -> String {
    let (cfrom, cto) = (canon(from), canon(to));
    if cfrom == cto {
        return line.to_string();
    }
    // Parse #ID=TYPE(attrs); (multi-line tolerant: rfind ')').
    let trimmed = line.trim_end();
    let body = trimmed.strip_suffix(';').unwrap_or(trimmed);
    let eq = match body.find('=') {
        Some(e) => e,
        None => return line.to_string(),
    };
    let prefix = &body[..=eq]; // "#123="
    let after = &body[eq + 1..];
    let popen = match after.find('(') {
        Some(p) => p,
        None => return line.to_string(),
    };
    let aclose = match after.rfind(')') {
        Some(c) if c > popen => c,
        _ => return line.to_string(),
    };
    let entity_type = after[..popen].trim().to_uppercase();
    let attrs = &after[popen + 1..aclose];

    let new_type = convert_entity_type(&entity_type, cfrom, cto);

    if should_skip_entity(&new_type, cto) {
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
        return format!(
            "{prefix}IFCPROXY('{}',$,'{}',$,$,$,$,.NOTDEFINED.,$);",
            placeholder_guid(express_id),
            entity_type
        );
    }

    // IFCDOORTYPE/IFCWINDOWTYPE -> IFCDOORSTYLE/IFCWINDOWSTYLE: neither
    // attribute list is a positional prefix of the other (IFC4 inserted
    // ElementType/PredefinedType mid-list), so reconcile by name instead of
    // the generic positional trim below.
    let mut final_attrs = if new_type != entity_type {
        if let Some((src_names, tgt_names)) = by_name_attr_remap_names(&entity_type) {
            remap_attrs_by_name(attrs, src_names, tgt_names)
        } else if cto == "IFC2X3" {
            match ifc2x3_attr_count(&new_type) {
                Some(max) => trim_attributes(attrs, max),
                None => attrs.to_string(),
            }
        } else {
            attrs.to_string()
        }
    } else if cto == "IFC2X3" {
        match ifc2x3_attr_count(&new_type) {
            Some(max) => trim_attributes(attrs, max),
            None => attrs.to_string(),
        }
    } else {
        attrs.to_string()
    };

    // Pad the trailing optional attributes a newer target schema APPENDED
    // (#1416). Keyed on the ORIGINAL type, because the source schema is what
    // decides how many attributes the line already has; the table's target
    // count already accounts for the rename. Only types whose source
    // attribute NAME list is a strict prefix of the target's are in it, so
    // this can never shift a value into a reordered slot -- see
    // `schema_pad`. An attribute-less line is left alone rather than
    // fabricated from nothing, matching the TypeScript twin's
    // `currentCount > 0` guard.
    if let Some(target_count) = crate::schema_pad::padded_attr_count(cfrom, cto, &entity_type) {
        let current = crate::schema_pad::count_top_level_attributes(&final_attrs);
        if current > 0 && current < target_count {
            for _ in current..target_count {
                final_attrs.push_str(",$");
            }
        }
    }

    format!("{prefix}{new_type}({final_attrs});")
}

/// True when converting between these schemas changes entity types/attributes.
pub fn needs_conversion(from: &str, to: &str) -> bool {
    canon(from) != canon(to)
}

#[cfg(test)]
#[path = "schema_convert_tests.rs"]
mod tests;
