// SPDX-License-Identifier: MPL-2.0
//! Entities whose attributes IFC4 INSERTED, REORDERED or RETYPED mid-list
//! relative to IFC2X3 (#10763), reconciled by a reviewed per-type map.
//!
//! The trim and pad of `schema_plan::plan_for` are only safe when one list is
//! a strict name prefix of the other (`schema_renames`). These types fail that
//! test, so before #10763 both writers kept the source layout: an IFC2X3
//! `IfcApproval` upgraded to IFC4 put its `Description` in `Identifier` and
//! stayed two slots short. Each map below was decided from the IFC4 change
//! notes (quoted in `tests/fixtures/schema_attribute_maps.json`). A target
//! slot takes the source value of the same or the listed renamed attribute;
//! every other target slot is `$`, and every other source value is counted as
//! dropped. IFC4X3 declares the same lists as IFC4 for every mapped type
//! (pinned in the tests), so one map serves both.
//!
//! Twin of `packages/export/src/schema-converter-attr-maps.ts`; both are held
//! to `tests/fixtures/schema_attribute_maps.json`, and their conversions to
//! `tests/fixtures/schema_upconvert_sweep.json`.

use crate::schema_convert::holds_value;

/// One reviewed IFC2X3 <-> IFC4 attribute map. A same-named attribute in both
/// lists is carried unless listed in `retyped` or, on a downgrade, `up_only`.
#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(test, derive(serde::Serialize), serde(rename_all = "camelCase"))]
pub(crate) struct AttrMap {
    /// The IFC2X3 type.
    pub(crate) ifc2x3: &'static str,
    /// The IFC4 (and IFC4X3) type.
    pub(crate) ifc4: &'static str,
    /// `(IFC2X3 name, IFC4 name)`: one concept and one STEP value type.
    pub(crate) renamed: &'static [(&'static str, &'static str)],
    /// Same name, but a value of one type is not valid in the other.
    pub(crate) retyped: &'static [&'static str],
    /// Same name; IFC4 widened the reference type, so only an upgrade carries it.
    pub(crate) up_only: &'static [&'static str],
    /// `(IFC2X3 single reference, IFC4 SET of them)`.
    pub(crate) set_of_one: Option<(&'static str, &'static str)>,
}

const fn map(ifc2x3: &'static str, ifc4: &'static str) -> AttrMap {
    AttrMap { ifc2x3, ifc4, renamed: &[], retyped: &[], up_only: &[], set_of_one: None }
}

/// The same map for one name in both schemas.
const fn same(ty: &'static str) -> AttrMap {
    map(ty, ty)
}

/// IFC4 promoted `ResourceIdentifier` to IfcResource as `Identification` and
/// renamed `ResourceGroup` to `LongDescription`; `BaseQuantity` went from an
/// IfcMeasureWithUnit to an IfcPhysicalQuantity.
const fn resource(ty: &'static str) -> AttrMap {
    AttrMap {
        renamed: &[("ResourceIdentifier", "Identification"), ("ResourceGroup", "LongDescription")],
        retyped: &["BaseQuantity"],
        ..same(ty)
    }
}

/// Every reviewed map; the fixture's `why` gives the change note behind each.
pub(crate) const ATTR_MAPS: &[AttrMap] = &[
    AttrMap {
        renamed: &[("ApprovalStatus", "Status"), ("ApprovalLevel", "Level"), ("ApprovalQualifier", "Qualifier")],
        ..same("IFCAPPROVAL")
    },
    AttrMap { set_of_one: Some(("RelatedApproval", "RelatedApprovals")), ..same("IFCAPPROVALRELATIONSHIP") },
    // IFC4 replaced IfcSurfaceTexture's `TextureType` enum with a `Mode` string
    // of another meaning, so neither carries into the other.
    AttrMap { retyped: &["RasterCode"], ..same("IFCBLOBTEXTURE") },
    AttrMap { renamed: &[("UrlReference", "URLReference")], ..same("IFCIMAGETEXTURE") },
    same("IFCPIXELTEXTURE"),
    AttrMap { retyped: &["Parameter"], ..same("IFCTEXTURECOORDINATEGENERATOR") },
    same("IFCTEXTUREMAP"),
    resource("IFCCONSTRUCTIONEQUIPMENTRESOURCE"),
    resource("IFCCONSTRUCTIONMATERIALRESOURCE"),
    resource("IFCCONSTRUCTIONPRODUCTRESOURCE"),
    resource("IFCCREWRESOURCE"),
    resource("IFCLABORRESOURCE"),
    resource("IFCSUBCONTRACTRESOURCE"),
    AttrMap { renamed: &[("ID", "Identification")], retyped: &["SubmittedOn", "UpdateDate"], ..same("IFCCOSTSCHEDULE") },
    AttrMap { retyped: &["RateDateTime"], ..same("IFCCURRENCYRELATIONSHIP") },
    same("IFCDOCUMENTINFORMATIONRELATIONSHIP"),
    AttrMap { retyped: &["VersionDate"], up_only: &["Publisher"], ..same("IFCLIBRARYINFORMATION") },
    // IFC4 deleted these IFC2X3 subtypes and made the abstract supertype
    // concrete in their place, so a downgrade writes the deleted subtype
    // (`schema_convert::map_4_to_2x3`). Downgrade only: nothing renames the
    // IFC2X3 subtypes on an upgrade.
    AttrMap {
        renamed: &[("ExtendedProperties", "Properties")],
        ..map("IFCEXTENDEDMATERIALPROPERTIES", "IFCMATERIALPROPERTIES")
    },
    map("IFCGENERALPROFILEPROPERTIES", "IFCPROFILEPROPERTIES"),
    same("IFCPERFORMANCEHISTORY"),
    AttrMap { renamed: &[("TaskId", "Identification")], ..same("IFCTASK") },
    same("IFCPROPERTYDEPENDENCYRELATIONSHIP"),
];

/// The map for writing `entity_type` as `new_type` from `cfrom` to `cto`, and
/// whether it runs upward (IFC2X3 source).
pub(crate) fn attr_map(entity_type: &str, new_type: &str, cfrom: &str, cto: &str) -> Option<(&'static AttrMap, bool)> {
    let ifc4_like = |s: &str| matches!(s, "IFC4" | "IFC4X3");
    let up = match (cfrom, cto) {
        ("IFC2X3", to) if ifc4_like(to) => true,
        (from, "IFC2X3") if ifc4_like(from) => false,
        _ => return None,
    };
    let (src, tgt) = if up { (entity_type, new_type) } else { (new_type, entity_type) };
    ATTR_MAPS.iter().find(|m| m.ifc2x3 == src && m.ifc4 == tgt).map(|m| (m, up))
}

/// True when an IFC4 `line` upgraded from IFC2X3 gets its required slots
/// counted: a structural record, or one a map wrote, which can leave a
/// required slot with no source value (#10763). The type is read from the
/// record head. Twin of the TypeScript `upgradeCountsIfc4Slots`.
pub(crate) fn upgrade_counts_ifc4_slots(line: &str) -> bool {
    let ty = crate::step_record_frame::record_head(line).map_or("", |head| head.type_name(line));
    ty.starts_with("IFCSTRUCTURAL") || ATTR_MAPS.iter().any(|m| m.ifc4 == ty)
}

/// How a target slot is filled from its source value.
#[derive(Clone, Copy)]
enum How {
    Value,
    Wrap,
    Unwrap,
}

impl AttrMap {
    /// The source attribute (as named in the source list `src`) that fills the
    /// target attribute `name`, and how.
    fn source_of(&self, up: bool, name: &str, src: &[&'static str]) -> Option<(&'static str, How)> {
        // A pair read from the target's side: (target name, source name).
        let from_target = |&(older, newer): &(&'static str, &'static str)| if up { (newer, older) } else { (older, newer) };
        if let Some((_, source)) = self.renamed.iter().map(from_target).find(|(target, _)| *target == name) {
            return Some((source, How::Value));
        }
        if let Some((_, source)) = self.set_of_one.as_ref().map(from_target).filter(|(target, _)| *target == name) {
            return Some((source, if up { How::Wrap } else { How::Unwrap }));
        }
        let carried = !self.retyped.contains(&name) && (up || !self.up_only.contains(&name));
        src.iter().copied().find(|s| *s == name).filter(|_| carried).map(|s| (s, How::Value))
    }
}

/// `values` (in the source layout `src`) written in the target layout `tgt`
/// under `map`, adding to `lost` every source value with no target slot.
/// Positions follow `src`, as `remap_attrs_by_name` does.
pub(crate) fn remap(map: &AttrMap, up: bool, values: &[String], src: &[&'static str], tgt: &[&'static str], lost: &mut usize) -> String {
    let mut used = vec![false; values.len()];
    let out: Vec<String> = tgt
        .iter()
        .map(|name| {
            let Some((source, how)) = map.source_of(up, name, src) else { return "$".to_owned() };
            let Some(i) = src.iter().position(|s| *s == source).filter(|&i| i < values.len()) else {
                return "$".to_owned();
            };
            used[i] = true;
            let value = values[i].as_str();
            if let How::Value = how {
                return if holds_value(value) { value.to_owned() } else { "$".to_owned() };
            }
            // A SET is rebuilt, so comments around it or its members go.
            let bare = without_comments(value);
            if !holds_value(&bare) {
                return "$".to_owned();
            }
            if let How::Unwrap = how {
                let (first, extra) = first_member(&bare);
                *lost += extra;
                return first;
            }
            if bare.starts_with('(') { bare } else { format!("({bare})") }
        })
        .collect();
    *lost += values.iter().zip(&used).filter(|(v, used)| !**used && holds_value(v)).count();
    out.join(",")
}

/// The first member of a STEP list `value`, and how many more members hold a
/// value. A value that is not a list is its own first member.
fn first_member(value: &str) -> (String, usize) {
    let Some(members) = crate::schema_ifc2x3_records::list(Some(value)) else { return (value.to_owned(), 0) };
    let mut held = members.into_iter().filter(|m| holds_value(m));
    match held.next() {
        Some(first) => (first.trim().to_owned(), held.count()),
        None => ("$".to_owned(), 0),
    }
}

/// `value` without its `/* ... */` comments (none is read inside a string),
/// trimmed. An unclosed comment runs to the end.
fn without_comments(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    let mut in_string = false;
    while let Some(c) = rest.chars().next() {
        if !in_string && rest.starts_with("/*") {
            rest = rest[2..].find("*/").map_or("", |end| &rest[end + 4..]);
            continue;
        }
        in_string ^= c == '\'';
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out.trim().to_owned()
}

#[cfg(test)]
#[path = "schema_attr_maps_tests.rs"]
mod tests;
