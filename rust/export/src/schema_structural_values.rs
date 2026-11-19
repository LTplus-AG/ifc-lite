// SPDX-License-Identifier: MPL-2.0
//! Source-derived property carriers and shared placements for IFC2X3 / IFC4.
use std::collections::{BTreeMap, HashMap, HashSet};

use crate::schema_structural_axes::{list_items, reference, unset};

const OBJECT_PLACEMENT: usize = ifc_lite_core::slot::IfcProduct::OBJECT_PLACEMENT.index();
const RELATED_OBJECTS: usize = ifc_lite_core::slot::IfcRelAssignsToGroup::RELATED_OBJECTS.index();
const RELATING_GROUP: usize = ifc_lite_core::slot::IfcRelAssignsToGroup::RELATING_GROUP.index();
const DEFINED_OBJECTS: usize = ifc_lite_core::slot::IfcRelDefinesByProperties::RELATED_OBJECTS.index();
const DEFINING_SET: usize = ifc_lite_core::slot::IfcRelDefinesByProperties::RELATING_PROPERTY_DEFINITION.index();
const SET_NAME: usize = ifc_lite_core::slot::IfcPropertySet::NAME.index();
const HAS_PROPERTIES: usize = ifc_lite_core::slot::IfcPropertySet::HAS_PROPERTIES.index();
const REP_ITEMS: usize = 3;
const PROPERTY_VALUE: usize = 2;

const LOAD_CASE: &str = "IFCSTRUCTURALLOADCASE";
const LOAD_GROUP: &str = "IFCSTRUCTURALLOADGROUP";
const ANALYSIS_MODEL: &str = "IFCSTRUCTURALANALYSISMODEL";
const VARYING_MEMBER: &str = "IFCSTRUCTURALSURFACEMEMBERVARYING";
const LOAD_CASE_PSET: &str = "'IFC4 IfcStructuralLoadCase'";
const THICKNESS_PSET: &str = "'Pset_StructuralSurfaceMemberVaryingThickness'";
const COEFFICIENTS: &str = "'SelfWeightCoefficients'";
const THICKNESSES: [&str; 3] = ["'Thickness1'", "'Thickness2'", "'Thickness3'"];

#[derive(Default)]
pub(crate) struct StructuralValues {
    rewrites: HashMap<u32, (String, &'static str)>,
    placements: HashMap<u32, u32>,
    consumed: HashSet<u32>,
    added: Vec<String>,
}

struct Source<'a> {
    content: &'a [u8],
    index: BTreeMap<u32, (&'a str, usize, usize)>,
}

impl Source<'_> {
    fn kind(&self, id: u32, kind: &str) -> bool {
        self.index.get(&id).is_some_and(|&(ty, _, _)| ty.eq_ignore_ascii_case(kind))
    }

    fn ids<'a>(&'a self, kind: &'a str) -> impl Iterator<Item = u32> + 'a {
        self.index.iter().filter_map(move |(&id, &(ty, _, _))| ty.eq_ignore_ascii_case(kind).then_some(id))
    }

    fn slots(&self, id: u32) -> Option<Vec<String>> {
        let &(_, start, end) = self.index.get(&id)?;
        let text = String::from_utf8_lossy(&self.content[start..end]);
        let frame = crate::step_record_frame::record_frame(&text)?;
        crate::step_slot::split_top_level_args(frame.args(&text))
    }

    fn uses(&self, mut counts: HashMap<u32, usize>) -> HashMap<u32, usize> {
        if counts.is_empty() { return counts; }
        let mut refs = Vec::new();
        for &(_, start, end) in self.index.values() {
            crate::merged::arg_refs(&self.content[start..end], &mut refs);
            refs.retain(|id| counts.contains_key(id));
            refs.sort_unstable();
            refs.dedup();
            for id in refs.drain(..) {
                if let Some(count) = counts.get_mut(&id) { *count += 1; }
            }
        }
        counts
    }

    /// Property name (with its quotes) -> id, or None when one cannot be read or two share a name.
    fn properties(&self, ids: &[u32]) -> Option<BTreeMap<String, u32>> {
        let mut properties = BTreeMap::new();
        for &id in ids {
            let name = step_string(self.slots(id)?.first()?)?.to_string();
            if properties.insert(name, id).is_some() { return None; }
        }
        Some(properties)
    }

    fn property_sets(&self, name: &str) -> Vec<PropertySet> {
        self.ids("IFCRELDEFINESBYPROPERTIES").filter_map(|rel| {
            // Both records are read at any arity, as the TypeScript twin does.
            let args = self.slots(rel)?;
            let set = reference(args.get(DEFINING_SET)?)?;
            if !self.kind(set, "IFCPROPERTYSET") { return None; }
            let slots = self.slots(set)?;
            if step_string(slots.get(SET_NAME)?) != Some(name) { return None; }
            // IfcPropertySet names its properties uniquely (IFC4 UniquePropertyNames, IFC2X3 WR32). A set that
            // does not, that lists a property it cannot read, or whose relationship lists a non-reference, still
            // counts as present for the objects it does name but gives no property.
            let listed = args.get(DEFINED_OBJECTS).and_then(|related| list_items(related)).unwrap_or_default();
            let members: Vec<u32> = listed.iter().filter_map(|item| reference(item)).collect();
            let ids = slots.get(HAS_PROPERTIES).and_then(|has| references(has)).unwrap_or_default();
            let properties = if members.len() == listed.len() { self.properties(&ids).unwrap_or_default() } else { BTreeMap::new() };
            Some(PropertySet { rel, set, members, ids, properties })
        }).collect()
    }
}

struct PropertySet {
    rel: u32,
    set: u32,
    members: Vec<u32>,
    ids: Vec<u32>,
    properties: BTreeMap<String, u32>,
}

/// One whole STEP string, STEP whitespace and comments around it allowed, as the TypeScript
/// `stepString` reads it; returned WITH its quotes, as the name constants here hold them.
/// Compared only with fixed names, so escapes are not decoded.
fn step_string(token: &str) -> Option<&str> {
    let bytes = token.as_bytes();
    let start = ifc_lite_core::parser::skip_step_trivia(bytes, 0)?;
    if bytes.get(start) != Some(&b'\'') { return None; }
    let end = ifc_lite_core::step_encoding::step_string_literal_end(bytes, start)?;
    (ifc_lite_core::parser::skip_step_trivia(bytes, end) == Some(bytes.len())).then(|| &token[start..end])
}

fn references(token: &str) -> Option<Vec<u32>> {
    list_items(token)?.iter().map(|item| reference(item)).collect()
}

fn bare_measure(token: &str, kind: &str) -> Option<(String, f64)> {
    let token = token.trim();
    let bare = if let Some((prefix, inner)) = token.split_once('(') {
        if !prefix.trim().eq_ignore_ascii_case(kind) { return None; }
        inner.strip_suffix(')')?.trim()
    } else { token };
    let value = crate::schema_ifc2x3_records::num(bare)?;
    Some((bare.to_string(), value))
}

fn coefficients(token: &str) -> Option<Vec<String>> {
    let values = list_items(token)?;
    if values.len() != 3 { return None; }
    values.iter().map(|value| bare_measure(value, "IFCRATIOMEASURE").map(|(bare, _)| bare)).collect()
}

impl StructuralValues {
    #[inline(never)]
    pub(crate) fn scan(content: &[u8], kept: &dyn Fn(u32, usize) -> bool, downgrade: bool, allocate: &mut dyn FnMut() -> Option<u32>) -> Self {
        let mut values = Self::default();
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        let mut needed = false;
        while let Some((_, kind, _, _)) = scanner.next_entity() {
            needed = kind.eq_ignore_ascii_case(VARYING_MEMBER) || if downgrade {
                kind.eq_ignore_ascii_case(LOAD_CASE)
            } else {
                kind.eq_ignore_ascii_case(ANALYSIS_MODEL) || kind.eq_ignore_ascii_case(LOAD_GROUP)
            };
            if needed { break; }
        }
        if !needed { return values; }

        let mut source = Source { content, index: BTreeMap::new() };
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        while let Some((id, kind, start, end)) = scanner.next_entity() {
            if kept(id, start) { source.index.insert(id, (kind, start, end)); }
        }
        if !downgrade { values.shared_placements(&source); }
        values.load_cases(&source, downgrade, allocate);
        values.varying_thickness(&source, downgrade, allocate);
        values
    }

    fn shared_placements(&mut self, source: &Source<'_>) {
        let mut grouped = BTreeMap::<u32, HashSet<u32>>::new();
        let mut owner = HashMap::new();
        let mut shared = HashSet::new();
        // A model one of whose groupings cannot be read in full is not known to share a placement.
        let mut unread = HashSet::new();
        for rel in source.ids("IFCRELASSIGNSTOGROUP") {
            let Some(args) = source.slots(rel) else { continue; };
            // Read at any arity, as the TypeScript twin does.
            let Some(model) = args.get(RELATING_GROUP).and_then(|group| reference(group)).filter(|&id| source.kind(id, ANALYSIS_MODEL)) else { continue; };
            let listed = args.get(RELATED_OBJECTS).and_then(|related| list_items(related));
            if listed.as_ref().is_none_or(|items| items.iter().any(|item| reference(item).is_none())) { unread.insert(model); }
            // The readable items of an unread grouping still count as grouped by this model.
            for item in listed.iter().flatten().filter_map(|item| reference(item)) {
                let Some(&(kind, _, _)) = source.index.get(&item) else { continue; };
                if !ifc_lite_core::SchemaVersion::Ifc2x3.is_subtype_of(kind, "IfcStructuralItem") { continue; }
                if owner.insert(item, model).is_some_and(|previous| previous != model) { shared.insert(item); }
                grouped.entry(model).or_default().insert(item);
            }
        }
        for (model, items) in grouped {
            if unread.contains(&model) || items.iter().any(|item| shared.contains(item)) { continue; }
            let Some(args) = source.slots(model).filter(|args| args.len() == 9) else { continue; };
            let Some(placements) = items.iter().map(|&item| {
                let slots = source.slots(item)?;
                let placement = reference(slots.get(OBJECT_PLACEMENT)?)?;
                source.kind(placement, "IFCLOCALPLACEMENT").then_some((item, placement))
            }).collect::<Option<Vec<_>>>() else { continue; };
            let Some(placement) = placements.iter().map(|&(_, id)| id).min() else { continue; };
            let Some(slots) = source.slots(placement).filter(|slots| slots.len() == 2) else { continue; };
            if !placements.iter().all(|&(_, id)| source.slots(id).is_some_and(|other| {
                slots.len() == other.len() && slots.iter().zip(other).all(|(a, b)| a.trim() == b.trim())
            })) { continue; }
            self.rewrites.insert(model, (
                format!("{ANALYSIS_MODEL}({},#{placement})", args.join(",")),
                "IfcStructuralAnalysisModel.SharedPlacement is written as the local placement all of its grouped structural items use or copy, and they are placed by it",
            ));
            self.placements.extend(placements.into_iter().filter_map(|(item, own)| (own != placement).then_some((item, placement))));
        }
    }

    #[inline(never)]
    fn load_cases(&mut self, source: &Source<'_>, downgrade: bool, allocate: &mut dyn FnMut() -> Option<u32>) {
        if downgrade {
            for id in source.ids(LOAD_CASE) {
                let Some(args) = source.slots(id).filter(|args| args.len() == 11) else { continue; };
                let property = if unset(&args[10]) {
                    format!("IFCPROPERTYSINGLEVALUE({COEFFICIENTS},$,$,$)")
                } else if let Some(values) = coefficients(&args[10]) {
                    let values = values.iter().map(|value| format!("IFCRATIOMEASURE({value})")).collect::<Vec<_>>().join(",");
                    format!("IFCPROPERTYLISTVALUE({COEFFICIENTS},$,({values}),$)")
                } else { continue; };
                let seed = format!("ifc4-load-case:{}", args[0].trim());
                if !self.add_set(allocate, &seed, &args[1], LOAD_CASE_PSET, id, &[property]) { continue; }
                self.rewrites.insert(id, (
                    format!("{LOAD_GROUP}({})", args[..10].join(",")),
                    "IfcStructuralLoadCase is written as an IfcStructuralLoadGroup with a 'IFC4 IfcStructuralLoadCase' property set holding SelfWeightCoefficients",
                ));
            }
            return;
        }

        let sets = source.property_sets(LOAD_CASE_PSET);
        let mut per_group = HashMap::new();
        for set in &sets {
            for &group in &set.members { *per_group.entry(group).or_insert(0) += 1; }
        }
        let uses = source.uses(sets.iter().flat_map(|set| [set.rel, set.set].into_iter().chain(set.ids.iter().copied())).map(|id| (id, 0)).collect());
        for set in sets {
            let [group] = set.members.as_slice() else { continue; };
            if per_group[group] != 1 || !source.kind(*group, LOAD_GROUP) || set.properties.len() != 1
                || uses[&set.rel] != 0 || uses[&set.set] != 1 || set.ids.iter().any(|id| uses[id] != 1) { continue; }
            let Some(&prop) = set.properties.get(COEFFICIENTS) else { continue; };
            let Some(group_args) = source.slots(*group).filter(|args| args.len() == 10 && args[5].eq_ignore_ascii_case(".LOAD_CASE.")) else { continue; };
            let Some(args) = source.slots(prop).filter(|args| args.len() == 4) else { continue; };
            let token = if source.kind(prop, "IFCPROPERTYSINGLEVALUE") && unset(&args[2]) { "$".to_string() }
                else if source.kind(prop, "IFCPROPERTYLISTVALUE") {
                    let Some(values) = coefficients(&args[2]) else { continue; };
                    format!("({})", values.join(","))
                } else { continue; };
            self.rewrites.insert(*group, (
                format!("{LOAD_CASE}({},{token})", group_args.join(",")),
                "an IfcStructuralLoadGroup with a 'IFC4 IfcStructuralLoadCase' property set is written as the IFC4 IfcStructuralLoadCase it came from",
            ));
            self.consumed.extend([set.rel, set.set, prop]);
        }
    }

    #[inline(never)]
    fn varying_thickness(&mut self, source: &Source<'_>, downgrade: bool, allocate: &mut dyn FnMut() -> Option<u32>) {
        let sets = source.property_sets(THICKNESS_PSET);
        let mut by_member = HashMap::<u32, Vec<&PropertySet>>::new();
        for set in &sets {
            for &member in &set.members { by_member.entry(member).or_default().push(set); }
        }
        let mut aspects = HashMap::<u32, Vec<(u32, bool)>>::new();
        for id in source.ids("IFCSHAPEASPECT") {
            let Some(args) = source.slots(id).filter(|args| args.len() == 5) else { continue; };
            let Some(shape) = reference(&args[4]) else { continue; };
            let point_aspect = references(&args[0]).is_some_and(|reps| !reps.is_empty() && reps.into_iter().all(|rep| {
                source.slots(rep).and_then(|args| references(args.get(REP_ITEMS)?)).is_some_and(|items| {
                    items.len() == 1 && (source.kind(items[0], "IFCCARTESIANPOINT") || source.kind(items[0], "IFCPOINTONSURFACE"))
                })
            }));
            aspects.entry(shape).or_default().push((id, point_aspect));
        }

        for id in source.ids(VARYING_MEMBER) {
            let Some(args) = source.slots(id).filter(|args| args.len() == if downgrade { 9 } else { 11 }) else { continue; };
            let Some(shape) = reference(&args[6]) else { continue; };
            let Some([(aspect, true)]) = aspects.get(&shape).map(Vec::as_slice) else { continue; };
            let existing = by_member.get(&id).map(Vec::as_slice).unwrap_or_default();
            let read = match existing {
                [set] if !set.properties.iter().any(|(name, &id)| has_location(source, name, id)) => {
                    THICKNESSES.iter().map(|name| {
                        let &prop = set.properties.get(*name)?;
                        let values = source.slots(prop)?;
                        let [_, _, nominal_value, unit] = values.as_slice() else { return None; };
                        if !source.kind(prop, "IFCPROPERTYSINGLEVALUE") || !unset(unit) { return None; }
                        positive_length(nominal_value)
                    }).collect::<Option<Vec<_>>>()
                }
                _ => None,
            };
            if downgrade {
                let Some(values) = read else { continue; };
                let own = positive_length(&args[8]);
                if own.as_ref().is_some_and(|(_, value)| *value != values[0].1) { continue; }
                let first = if own.is_some() { &args[8] } else { &values[0].0 };
                self.rewrites.insert(id, (
                    format!("{VARYING_MEMBER}({},{first},({},{}),#{aspect})", args[..8].join(","), values[1].0, values[2].0),
                    "Pset_StructuralSurfaceMemberVaryingThickness Thickness1 to Thickness3 are written as the IFC2X3 Thickness and SubsequentThickness, located by the one IfcShapeAspect of the member's representation",
                ));
                continue;
            }
            if reference(&args[10]) != Some(*aspect) { continue; }
            let Some(subsequent) = list_items(&args[9]).filter(|items| items.len() == 2) else { continue; };
            let Some(values) = std::iter::once(&args[8]).chain(subsequent.iter()).map(|token| positive_length(token)).collect::<Option<Vec<_>>>() else { continue; };
            if existing.is_empty() {
                let properties = THICKNESSES.iter().zip(&values).map(|(name, (token, _))| {
                    format!("IFCPROPERTYSINGLEVALUE({name},$,IFCPOSITIVELENGTHMEASURE({token}),$)")
                }).collect::<Vec<_>>();
                let seed = format!("ifc2x3-thickness:{}", args[0].trim());
                if !self.add_set(allocate, &seed, &args[1], THICKNESS_PSET, id, &properties) { continue; }
            } else if !read.is_some_and(|held| held.iter().zip(&values).all(|(a, b)| a.1 == b.1)) { continue; }
            self.rewrites.insert(id, (
                format!("{VARYING_MEMBER}({})", args[..9].join(",")),
                "IFC2X3 SubsequentThickness is held in IFC4 as Pset_StructuralSurfaceMemberVaryingThickness Thickness1 to Thickness3",
            ));
        }
    }

    fn add_set(&mut self, allocate: &mut dyn FnMut() -> Option<u32>, seed: &str, owner: &str, name: &str, member: u32, properties: &[String]) -> bool {
        let Some(ids) = (0..properties.len() + 2).map(|_| allocate()).collect::<Option<Vec<_>>>() else { return false; };
        let property_ids = &ids[..properties.len()];
        let set = ids[properties.len()];
        let rel = ids[properties.len() + 1];
        let guid = crate::merged::deterministic_global_id(&format!("{seed}:pset"));
        let rel_guid = crate::merged::deterministic_global_id(&format!("{seed}:rel"));
        let list = property_ids.iter().map(|id| format!("#{id}")).collect::<Vec<_>>().join(",");
        self.added.extend(property_ids.iter().zip(properties).map(|(id, body)| format!("#{id}={body};")));
        self.added.push(format!("#{set}=IFCPROPERTYSET('{guid}',{owner},{name},$,({list}));"));
        self.added.push(format!("#{rel}=IFCRELDEFINESBYPROPERTIES('{rel_guid}',{owner},$,$,(#{member}),#{set});"));
        true
    }

    pub(crate) fn rewrite(&mut self, id: u32) -> Option<(String, &'static str)> { self.rewrites.remove(&id) }
    pub(crate) fn placement(&self, id: u32) -> Option<u32> { self.placements.get(&id).copied() }
    pub(crate) fn drops(&self, id: u32) -> bool { self.consumed.contains(&id) }
    pub(crate) fn added(&mut self) -> Vec<String> { std::mem::take(&mut self.added) }
}

fn positive_length(token: &str) -> Option<(String, f64)> {
    bare_measure(token, "IFCPOSITIVELENGTHMEASURE").filter(|(_, value)| *value > 0.)
}

fn has_location(source: &Source<'_>, name: &str, id: u32) -> bool {
    if !matches!(name, "'Location1Local'" | "'Location2Local'" | "'Location3Local'" | "'Location1Global'" | "'Location2Global'" | "'Location3Global'") {
        return false;
    }
    let empty = (source.kind(id, "IFCPROPERTYSINGLEVALUE") || source.kind(id, "IFCPROPERTYLISTVALUE"))
        && source.slots(id).and_then(|args| args.get(PROPERTY_VALUE).cloned()).is_some_and(|token| {
            unset(&token) || list_items(&token).is_some_and(|values| values.is_empty())
        });
    !empty
}
