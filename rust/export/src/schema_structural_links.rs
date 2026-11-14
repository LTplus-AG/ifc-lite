// SPDX-License-Identifier: MPL-2.0
//! IFC4 -> IFC2X3: the physical-to-analytical link back to its IFC2X3 entity (#9668).
//! IFC2X3 links an element to its analytical member with
//! IfcRelConnectsStructuralElement (RelatingElement : IfcElement,
//! RelatedStructuralMember : IfcStructuralMember; IFC2X3_TC1.exp:6613). IFC4 has
//! no such entity, and the upgrade writes the link as IfcRelAssignsToProduct
//! (`schema_structural::attributes`). This is its inverse, for exactly that
//! shape: one related object that becomes an IFC2X3 IfcStructuralMember, no
//! RelatedObjectsType, and a relating product that becomes an IFC2X3
//! IfcElement. Anything else stays an IfcRelAssignsToProduct. Types come from
//! the source, so only an unedited full export arms it.
use std::collections::{HashMap, HashSet};
use crate::schema_ifc2x3_records::ref_id;
use crate::schema_structural_axes::list_items;
use crate::step_slot::split_top_level_args;

#[derive(Default)]
pub(crate) struct StructuralLinks {
    elements: HashSet<u32>,
    members: HashSet<u32>,
}

/// Whether IFC4 `entity` (uppercase) converts to an IFC2X3 subtype of `parent`.
fn becomes(entity: &str, parent: &str) -> bool {
    let target = crate::schema_convert::rename_type(entity, "IFC4", "IFC2X3").unwrap_or(entity);
    ifc_lite_core::SchemaVersion::Ifc2x3.is_subtype_of(target, parent)
}

/// (member, element) of an `IFCRELASSIGNSTOPRODUCT` record of the shape the upgrade writes.
fn endpoints(args: &[String]) -> Option<(u32, u32)> {
    if args.len() != 7 || args[5].trim() != "$" { return None; }
    let member = match list_items(&args[4])?.as_slice() { [only] => ref_id(Some(only))?, _ => return None };
    Some((member, ref_id(Some(&args[6]))?))
}

impl StructuralLinks {
    /// Classifies only the records candidate links reference: a cheap pass over
    /// the assignments, then one over their endpoints, memoized per type.
    pub(crate) fn scan(content: &[u8], kept: impl Fn(u32, usize) -> bool) -> Self {
        let mut result = Self::default();
        let mut wanted = HashSet::new();
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        while let Some((id, ty, start, end)) = scanner.next_entity() {
            if !ty.eq_ignore_ascii_case("IFCRELASSIGNSTOPRODUCT") || !kept(id, start) { continue; }
            let text = String::from_utf8_lossy(&content[start..end]);
            let (Some(open), Some(close)) = (text.find('('), text.rfind(')')) else { continue };
            if close <= open { continue; }
            if let Some((member, element)) = split_top_level_args(&text[open + 1..close]).as_deref().and_then(endpoints) {
                wanted.extend([member, element]);
            }
        }
        if wanted.is_empty() { return result; }
        let mut kinds: HashMap<String, (bool, bool)> = HashMap::new();
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        while let Some((id, ty, start, _)) = scanner.next_entity() {
            if !wanted.contains(&id) || !kept(id, start) { continue; }
            let ty = ty.to_ascii_uppercase();
            let (member, element) = *kinds.entry(ty).or_insert_with_key(|ty| (becomes(ty, "IfcStructuralMember"), becomes(ty, "IfcElement")));
            if member { result.members.insert(id); } else if element { result.elements.insert(id); }
        }
        result
    }

    /// The IfcRelConnectsStructuralElement attributes for an IFC4 `IFCRELASSIGNSTOPRODUCT` record of that shape.
    pub(crate) fn link(&self, entity: &str, args: &[String]) -> Option<String> {
        if entity != "IFCRELASSIGNSTOPRODUCT" { return None; }
        let (member, element) = endpoints(args)?;
        (self.members.contains(&member) && self.elements.contains(&element))
            .then(|| format!("{},#{element},#{member}", args[..4].join(",")))
    }
}

#[cfg(test)]
mod tests {
    use crate::step::{export_step_with_stats, StepOptions};

    fn model(schema: &str, data: &str) -> String {
        format!("ISO-10303-21;HEADER;FILE_SCHEMA(('{schema}'));ENDSEC;DATA;\n{data}\nENDSEC;END-ISO-10303-21;")
    }
    fn export(source: &str, options: StepOptions) -> String { export_step_with_stats(source.as_bytes(), &options).unwrap().0 }
    fn to(schema: &str) -> StepOptions { StepOptions { schema: Some(schema.into()), ..StepOptions::default() } }
    fn record(out: &str, id: &str) -> String { out.lines().find(|l| l.starts_with(id)).unwrap_or_default().to_string() }

    #[test]
    fn link_round_trips_through_ifc4_9668() {
        let source = model("IFC2X3", "#10=IFCBEAM('2O2Fr$t4X7Zf8NOew3FLOH',$,'Beam',$,$,$,$,$);\n#20=IFCSTRUCTURALCURVEMEMBER('1kTvXnbbzCWw8lcMd1dR4o',$,'Member',$,$,$,$,.RIGID_JOINED_MEMBER.);\n#30=IFCRELCONNECTSSTRUCTURALELEMENT('3KIbrf6nfOzPbzsemNGvi0',$,$,$,#10,#20);");
        let ifc4 = export(&source, to("IFC4"));
        assert_eq!(record(&ifc4, "#30="), "#30=IFCRELASSIGNSTOPRODUCT('3KIbrf6nfOzPbzsemNGvi0',$,$,$,(#20),$,#10);");
        let (back, _, warnings) = crate::step::export_step_with_diagnostics(ifc4.as_bytes(), &to("IFC2X3")).unwrap();
        assert_eq!(record(&back, "#30="), "#30=IFCRELCONNECTSSTRUCTURALELEMENT('3KIbrf6nfOzPbzsemNGvi0',$,$,$,#10,#20);");
        assert!(warnings.iter().any(|w| w.contains("written as IfcRelConnectsStructuralElement")), "{warnings:?}");
        let log = crate::step_log::MutationLog::from_json("{}").unwrap();
        let (logged, _) = crate::step_log::export_step_with_log(ifc4.as_bytes(), &to("IFC2X3"), &log).unwrap();
        assert_eq!(record(&logged, "#30="), record(&back, "#30="));
        // A subset has no source types to read, so the link stays an assignment.
        let subset = export(&ifc4, StepOptions { included: Some(vec![10, 20, 30]), ..to("IFC2X3") });
        assert!(record(&subset, "#30=").starts_with("#30=IFCRELASSIGNSTOPRODUCT("), "{subset}");
    }

    #[test]
    fn other_assignments_stay_assignments_9668() {
        let source = model("IFC4", "#10=IFCBEAM('2O2Fr$t4X7Zf8NOew3FLOH',$,'Beam',$,$,$,$,$,$);\n#11=IFCBEAM('0xW3zI5Kj4Ch4Yx2s8P4ma',$,'Beam 2',$,$,$,$,$,$);\n#20=IFCSTRUCTURALCURVEMEMBER('1kTvXnbbzCWw8lcMd1dR4o',$,'Member',$,$,$,$,.RIGID_JOINED_MEMBER.,$);\n#21=IFCSTRUCTURALCURVEMEMBER('2kTvXnbbzCWw8lcMd1dR4o',$,'Member 2',$,$,$,$,.RIGID_JOINED_MEMBER.,$);\n#31=IFCRELASSIGNSTOPRODUCT('1aaaaaaaaaaaaaaaaaaaaa',$,$,$,(#20,#21),$,#10);\n#32=IFCRELASSIGNSTOPRODUCT('1bbbbbbbbbbbbbbbbbbbbb',$,$,$,(#20),.PRODUCT.,#10);\n#33=IFCRELASSIGNSTOPRODUCT('1ccccccccccccccccccccc',$,$,$,(#11),$,#10);\n#34=IFCRELASSIGNSTOPRODUCT('1ddddddddddddddddddddd',$,$,$,(#20),$,#21);");
        let out = export(&source, to("IFC2X3"));
        assert!(!out.contains("IFCRELCONNECTSSTRUCTURALELEMENT"), "{out}");
        assert_eq!(out.lines().filter(|l| l.starts_with("#3") && l.contains("=IFCRELASSIGNSTOPRODUCT(")).count(), 4);
    }
}
