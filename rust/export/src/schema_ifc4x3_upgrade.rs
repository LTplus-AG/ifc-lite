// SPDX-License-Identifier: MPL-2.0

use crate::schema_convert::holds_value;

pub(crate) fn style_target(ty: &str) -> Option<&'static str> {
    match ty {
        "IFCDOORSTYLE" => Some("IFCDOORTYPE"),
        "IFCWINDOWSTYLE" => Some("IFCWINDOWTYPE"),
        _ => None,
    }
}

pub(crate) fn rename(ty: &str) -> Option<&'static str> {
    Some(match ty {
        "IFCBEAMSTANDARDCASE" => "IFCBEAM",
        "IFCBUILDINGELEMENT" => "IFCBUILTELEMENT",
        "IFCBUILDINGELEMENTTYPE" => "IFCBUILTELEMENTTYPE",
        "IFCCOLUMNSTANDARDCASE" => "IFCCOLUMN",
        "IFCDOORSTANDARDCASE" => "IFCDOOR",
        "IFCMEMBERSTANDARDCASE" => "IFCMEMBER",
        "IFCOPENINGSTANDARDCASE" => "IFCOPENINGELEMENT",
        "IFCPLATESTANDARDCASE" => "IFCPLATE",
        "IFCSLABELEMENTEDCASE" | "IFCSLABSTANDARDCASE" => "IFCSLAB",
        "IFCWALLELEMENTEDCASE" => "IFCWALL",
        "IFCWINDOWSTANDARDCASE" => "IFCWINDOW",
        "IFCELECTRICDISTRIBUTIONPOINT" => "IFCDISTRIBUTIONBOARD",
        "IFCPROXY" => "IFCBUILDINGELEMENTPROXY",
        _ => return style_target(ty),
    })
}

pub(crate) fn needs_slot_map(ty: &str, from: &str, to: &str) -> bool {
    if to == "IFC4X3" {
        return style_target(ty).is_some() || ty == "IFCPROXY";
    }
    from == "IFC2X3" && to == "IFC4" && style_target(ty).is_some()
}

fn source_name<'a>(ty: &str, target: &'a str) -> &'a str {
    if ty == "IFCWINDOWSTYLE" && target == "PartitioningType" { "OperationType" } else { target }
}

/// Copy common attributes by name. The source window's OperationType fills
/// the target PartitioningType.
pub(crate) fn remap(ty: &str, src: &[&str], tgt: &[&str], args: &[String], lost: &mut usize) -> String {
    let used: Vec<&str> = tgt.iter().map(|name| source_name(ty, name)).collect();
    *lost += src.iter().zip(args).filter(|(name, slot)| !used.contains(name) && holds_value(slot)).count();
    tgt.iter().zip(used).map(|(target, from)| {
        if *target == "PredefinedType" {
            ".NOTDEFINED."
        } else {
            src.iter().position(|name| *name == from)
                .and_then(|index| args.get(index)).map_or("$", String::as_str)
        }
    }).collect::<Vec<_>>().join(",")
}
