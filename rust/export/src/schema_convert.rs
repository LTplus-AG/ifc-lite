// SPDX-License-Identifier: MPL-2.0
//! IFC **schema conversion** for STEP export (Phase 2 P2). Ports
//! `packages/export/src/schema-converter.ts`: entity-type renames between
//! IFC2X3 / IFC4 / IFC4X3 / IFC5 (with multi-step chaining), IFC2X3 attribute-count
//! trimming on downgrade, and a proxy fallback for types with no target representation.

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
        _ => return None,
    })
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

/// Trim a STEP attribute list to `max_count` top-level attributes (STEP-nesting aware).
fn trim_attributes(attrs: &str, max_count: usize) -> String {
    if attrs.trim().is_empty() {
        return attrs.to_string();
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
            if out.len() >= max_count {
                return out.join(",");
            }
        } else {
            current.push(ch);
        }
        i += 1;
    }
    out.push(current);
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
        return format!(
            "{prefix}IFCPROXY('{}',$,'{}',$,$,$,$,.NOTDEFINED.,$);",
            placeholder_guid(express_id),
            entity_type
        );
    }

    let final_attrs = if cto == "IFC2X3" {
        match ifc2x3_attr_count(&new_type) {
            Some(max) => trim_attributes(attrs, max),
            None => attrs.to_string(),
        }
    } else {
        attrs.to_string()
    };

    format!("{prefix}{new_type}({final_attrs});")
}

/// True when converting between these schemas changes entity types/attributes.
pub fn needs_conversion(from: &str, to: &str) -> bool {
    canon(from) != canon(to)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entity_type_renames() {
        assert_eq!(convert_entity_type("IFCBURNERTYPE", "IFC4", "IFC2X3"), "IFCGASTERMINALTYPE");
        assert_eq!(convert_entity_type("IFCCHIMNEY", "IFC4", "IFC2X3"), "IFCBUILDINGELEMENTPROXY");
        assert_eq!(convert_entity_type("IFCWALL", "IFC2X3", "IFC4"), "IFCWALL"); // unchanged
        // chained 4X3 → 2X3 (via 4): IfcFacility → IfcBuilding
        assert_eq!(convert_entity_type("IFCFACILITY", "IFC4X3", "IFC2X3"), "IFCBUILDING");
    }

    #[test]
    fn downgrade_trims_attributes() {
        // IfcWall in IFC4 has 9 attrs (trailing PredefinedType); IFC2X3 keeps 8.
        let line = "#5=IFCWALL('guid',$,'W1',$,$,#6,#7,'tag',.STANDARD.);";
        let out = convert_step_line(line, "IFC4", "IFC2X3", 5);
        assert!(out.starts_with("#5=IFCWALL("), "type kept");
        assert!(!out.contains(".STANDARD."), "9th attr (PredefinedType) trimmed");
        // 8 top-level attrs remain → 7 commas.
        let inner = &out["#5=IFCWALL(".len()..out.len() - 2];
        assert_eq!(inner.split(',').count(), 8, "trimmed to 8 attrs");
    }

    #[test]
    fn nested_attrs_not_split_when_trimming() {
        // Commas inside a nested list must not count as top-level separators.
        let line = "#9=IFCWALL('g',$,$,$,$,(#1,#2,#3),#7,'t',.STANDARD.);";
        let out = convert_step_line(line, "IFC4", "IFC2X3", 9);
        assert!(out.contains("(#1,#2,#3)"), "nested list preserved intact");
        assert!(!out.contains(".STANDARD."), "trailing attr trimmed");
    }

    #[test]
    fn alignment_becomes_proxy_on_downgrade() {
        let line = "#3=IFCALIGNMENTHORIZONTAL('g',$,$,$,$,#4);";
        let out = convert_step_line(line, "IFC4X3", "IFC4", 3);
        assert!(out.starts_with("#3=IFCPROXY("), "alignment → proxy");
        assert!(out.contains("'IFCALIGNMENTHORIZONTAL'"), "original type recorded as name");
    }

    #[test]
    fn no_conversion_is_identity() {
        let line = "#1=IFCWALL('g',$,$);";
        assert_eq!(convert_step_line(line, "IFC4", "IFC4", 1), line);
        assert!(!needs_conversion("IFC4", "IFC4"));
        assert!(needs_conversion("IFC2X3", "IFC4"));
    }
}
