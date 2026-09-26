// SPDX-License-Identifier: MPL-2.0
//! The property and quantity sets an entity has BEFORE the session's edits,
//! read from the source the way the viewer's mutation view reads them.
//!
//! The TypeScript exporter regenerates a touched set from
//! `MutablePropertyView.getForEntity`, which merges the overlay over a BASE the
//! host wired in. The parity target is the viewer's wiring
//! (`configureMutationView`): a type object's base is
//! `extractTypeEntityOwnProperties`, everything else's is
//! `extractPropertiesOnDemand`, and quantities come from
//! `extractQuantitiesOnDemand`. Those read through `extractPsetsFromIds` /
//! `readQuantitySet` and `parsePropertyValue`, which are ported here with
//! their lossy edges intact: a regenerated set is written from THESE values,
//! so an enumerated, bounded or list property comes back as the single value
//! the extractor collapsed it to, exactly as it does from the TypeScript path.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::jsval::JsVal;
use super::property_value::parse_property_value;
use super::source::Source;

/// `PropertyValueType`.
pub(crate) mod pvt {
    pub(crate) const STRING: u8 = 0;
    pub(crate) const REAL: u8 = 1;
    pub(crate) const INTEGER: u8 = 2;
    pub(crate) const BOOLEAN: u8 = 3;
    pub(crate) const LOGICAL: u8 = 4;
    pub(crate) const LABEL: u8 = 5;
    pub(crate) const IDENTIFIER: u8 = 6;
    pub(crate) const TEXT: u8 = 7;
    pub(crate) const ENUM: u8 = 8;
    pub(crate) const LIST: u8 = 10;
}

/// `QuantityType`.
pub(crate) mod qty {
    pub(crate) const LENGTH: u8 = 0;
    pub(crate) const AREA: u8 = 1;
    pub(crate) const VOLUME: u8 = 2;
    pub(crate) const COUNT: u8 = 3;
    pub(crate) const WEIGHT: u8 = 4;
    pub(crate) const TIME: u8 = 5;
    pub(crate) const NUMBER: u8 = 6;
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Prop {
    pub(crate) name: String,
    pub(crate) ty: u8,
    /// `PropertyValue`: string, number, boolean, null or a list of those.
    pub(crate) value: Value,
    pub(crate) unit: Option<String>,
    pub(crate) data_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PSet {
    pub(crate) name: String,
    pub(crate) global_id: String,
    pub(crate) properties: Vec<Prop>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Quantity {
    pub(crate) name: String,
    pub(crate) ty: u8,
    pub(crate) value: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct QSet {
    pub(crate) name: String,
    pub(crate) quantities: Vec<Quantity>,
}

/// The two on-demand maps the parser builds from `IfcRelDefinesByProperties`
/// (entity -> property-set ids / quantity-set ids), restricted to the
/// entities the log touches so a large file does not pay for every element.
pub(crate) struct BaseSets<'s, 'a> {
    src: &'s Source<'a>,
    psets_of: HashMap<u32, Vec<u32>>,
    qsets_of: HashMap<u32, Vec<u32>>,
    cache_p: HashMap<u32, Vec<PSet>>,
    cache_q: HashMap<u32, Vec<QSet>>,
}

impl<'s, 'a> BaseSets<'s, 'a> {
    pub(crate) fn new(src: &'s Source<'a>, wanted: &HashSet<u32>) -> Self {
        let pset_ids: HashSet<u32> = src.of_type("IFCPROPERTYSET").iter().copied().collect();
        let qset_ids: HashSet<u32> = src.of_type("IFCELEMENTQUANTITY").iter().copied().collect();
        let mut psets_of: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut qsets_of: HashMap<u32, Vec<u32>> = HashMap::new();
        for &rel in src.of_type("IFCRELDEFINESBYPROPERTIES") {
            let Some((_, attrs)) = src.entity(rel) else { continue };
            let related = refs(attrs.get(4));
            let defs = refs(attrs.get(5));
            if related.is_empty() || defs.is_empty() {
                continue;
            }
            for def in defs {
                let target = if pset_ids.contains(&def) {
                    &mut psets_of
                } else if qset_ids.contains(&def) {
                    &mut qsets_of
                } else {
                    continue;
                };
                for &obj in &related {
                    if !wanted.contains(&obj) {
                        continue;
                    }
                    let list = target.entry(obj).or_default();
                    if !list.contains(&def) {
                        list.push(def);
                    }
                }
            }
        }
        BaseSets { src, psets_of, qsets_of, cache_p: HashMap::new(), cache_q: HashMap::new() }
    }

    /// The viewer's property base for `id`.
    pub(crate) fn psets(&mut self, id: u32) -> Vec<PSet> {
        if let Some(hit) = self.cache_p.get(&id) {
            return hit.clone();
        }
        let is_type_object = self.src.type_of(id).is_some_and(|t| t.ends_with("TYPE"));
        let sets = if is_type_object { self.type_own_psets(id) } else { self.occurrence_psets(id) };
        self.cache_p.insert(id, sets.clone());
        sets
    }

    /// `extractQuantitiesOnDemand`.
    pub(crate) fn qsets(&mut self, id: u32) -> Vec<QSet> {
        if let Some(hit) = self.cache_q.get(&id) {
            return hit.clone();
        }
        let ids = self.qsets_of.get(&id).cloned().unwrap_or_default();
        let sets: Vec<QSet> = ids.iter().filter_map(|&q| self.read_qset(q)).collect();
        self.cache_q.insert(id, sets.clone());
        sets
    }

    fn occurrence_psets(&self, id: u32) -> Vec<PSet> {
        let ids = self.psets_of.get(&id).cloned().unwrap_or_default();
        self.psets_from_ids(&ids)
    }

    /// `extractTypeEntityOwnProperties`: `HasPropertySets` first, then the sets
    /// related through `IfcRelDefinesByProperties` that are not already there
    /// by id or by `(name, globalId)` identity.
    fn type_own_psets(&self, id: u32) -> Vec<PSet> {
        let Some((_, attrs)) = self.src.entity(id) else { return Vec::new() };
        let mut all = Vec::new();
        let mut seen_keys: HashSet<(String, String)> = HashSet::new();
        let mut own: Vec<u32> = Vec::new();
        if let Some(JsVal::Arr(items)) = attrs.get(5) {
            for item in items {
                if let JsVal::Num(n) = item {
                    let pid = *n as u32;
                    if !own.contains(&pid) {
                        own.push(pid);
                    }
                }
            }
            for set in self.psets_from_ids(&own) {
                seen_keys.insert((set.name.clone(), set.global_id.clone()));
                all.push(set);
            }
        }
        let related = self.psets_of.get(&id).cloned().unwrap_or_default();
        let fresh: Vec<u32> = related.into_iter().filter(|p| !own.contains(p)).collect();
        if !fresh.is_empty() {
            let mut accepted: HashSet<(String, String)> = HashSet::new();
            for set in self.psets_from_ids(&fresh) {
                if !set.name.is_empty() || !set.global_id.is_empty() {
                    let key = (set.name.clone(), set.global_id.clone());
                    if seen_keys.contains(&key) || !accepted.insert(key) {
                        continue;
                    }
                }
                all.push(set);
            }
        }
        all
    }

    /// `extractPsetsFromIds`.
    fn psets_from_ids(&self, ids: &[u32]) -> Vec<PSet> {
        let mut out = Vec::new();
        for &pid in ids {
            let Some((ty, attrs)) = self.src.entity(pid) else { continue };
            if ty != "IFCPROPERTYSET" {
                continue;
            }
            let global_id = attrs.first().and_then(JsVal::as_str).unwrap_or("").to_string();
            let name = attrs.get(2).and_then(JsVal::as_str).unwrap_or("").to_string();
            let mut properties = Vec::new();
            if let Some(JsVal::Arr(items)) = attrs.get(4) {
                for item in items {
                    let JsVal::Num(n) = item else { continue };
                    let Some((pty, pattrs)) = self.src.entity(*n as u32) else { continue };
                    let pname = pattrs.first().and_then(JsVal::as_str).unwrap_or("");
                    if pname.is_empty() {
                        continue;
                    }
                    let (ty, value, data_type) = if pty == "IFCCOMPLEXPROPERTY" {
                        self.complex_value(&pattrs, 0, &mut COMPLEX_MEMBER_BUDGET.clone())
                    } else {
                        parse_property_value(&pty, &pattrs)
                    };
                    let unit = explicit_unit(self.src, &pty, &pattrs);
                    properties.push(Prop { name: pname.to_string(), ty, value, unit, data_type });
                }
            }
            if !properties.is_empty() {
                out.push(PSet { name, global_id, properties });
            }
        }
        out
    }

    /// `resolveComplexPropertyValue`: a display string only.
    ///
    /// The TypeScript walk is bounded by depth alone, which bounds a path but
    /// not fan-out: members that share a nested complex property are walked
    /// once per path. `budget` caps the member visits for one property, so a
    /// file built to explode that costs a truncated display string rather than
    /// a hang. Real complex properties are a handful of members deep and wide,
    /// far inside it, so the output is unchanged for them.
    fn complex_value(&self, attrs: &[JsVal], depth: usize, budget: &mut usize) -> (u8, Value, Option<String>) {
        let usage = attrs.get(2).and_then(JsVal::as_str).unwrap_or("").to_string();
        let empty_usage = || if usage.is_empty() { Value::Null } else { Value::String(usage.clone()) };
        let Some(JsVal::Arr(members)) = attrs.get(3) else { return (pvt::STRING, empty_usage(), None) };
        if members.is_empty() {
            return (pvt::STRING, empty_usage(), None);
        }
        if depth >= 8 {
            let marker = "(truncated: nesting deeper than 8 levels)";
            let text = if usage.is_empty() { marker.to_string() } else { format!("{usage} {marker}") };
            return (pvt::STRING, Value::String(text), None);
        }
        let mut parts = Vec::new();
        for member in members {
            let JsVal::Num(n) = member else { continue };
            if *budget == 0 {
                break;
            }
            *budget -= 1;
            let Some((mty, mattrs)) = self.src.entity(*n as u32) else { continue };
            let mname = mattrs.first().and_then(JsVal::as_str).unwrap_or("").to_string();
            let (_, v, _) = if mty == "IFCCOMPLEXPROPERTY" {
                self.complex_value(&mattrs, depth + 1, budget)
            } else {
                parse_property_value(&mty, &mattrs)
            };
            let display = if v.is_null() { String::new() } else { super::jsval::json_to_js_string(&v) };
            if display.is_empty() {
                continue;
            }
            parts.push(if mname.is_empty() { display } else { format!("{mname}: {display}") });
        }
        let value = if parts.is_empty() { empty_usage() } else { Value::String(parts.join(", ")) };
        (pvt::STRING, value, None)
    }

    /// `readQuantitySet`, with `collectQuantitiesFromRefs`.
    fn read_qset(&self, qid: u32) -> Option<QSet> {
        let (_, attrs) = self.src.entity(qid)?;
        let name = attrs.get(2).and_then(JsVal::as_str).unwrap_or("").to_string();
        let mut quantities = Vec::new();
        if let Some(JsVal::Arr(items)) = attrs.get(5) {
            for item in items {
                let JsVal::Num(n) = item else { continue };
                let Some((qty_type, qattrs)) = self.src.entity(*n as u32) else { continue };
                if qty_type == "IFCPHYSICALCOMPLEXQUANTITY" {
                    continue;
                }
                let qname = qattrs.first().and_then(JsVal::as_str).unwrap_or("");
                if qname.is_empty() {
                    continue;
                }
                let value = qattrs.get(3).and_then(JsVal::as_num).unwrap_or(0.0);
                quantities.push(Quantity { name: qname.to_string(), ty: quantity_type_of(&qty_type), value });
            }
        }
        (!quantities.is_empty()).then_some(QSet { name, quantities })
    }
}

/// Member visits one complex property may cost (see `complex_value`).
const COMPLEX_MEMBER_BUDGET: usize = 10_000;

/// `QUANTITY_TYPE_MAP`, defaulting to Count.
pub(crate) fn quantity_type_of(upper: &str) -> u8 {
    match upper {
        "IFCQUANTITYLENGTH" => qty::LENGTH,
        "IFCQUANTITYAREA" => qty::AREA,
        "IFCQUANTITYVOLUME" => qty::VOLUME,
        "IFCQUANTITYCOUNT" => qty::COUNT,
        "IFCQUANTITYWEIGHT" => qty::WEIGHT,
        "IFCQUANTITYTIME" => qty::TIME,
        "IFCQUANTITYNUMBER" => qty::NUMBER,
        _ => qty::COUNT,
    }
}

/// Reference ids in one attribute: a single `#id` or a list of them.
pub(crate) fn refs(v: Option<&JsVal>) -> Vec<u32> {
    match v {
        Some(JsVal::Num(n)) if *n >= 1.0 => vec![*n as u32],
        Some(JsVal::Arr(items)) => items
            .iter()
            .filter_map(|i| match i {
                JsVal::Num(n) if *n >= 1.0 => Some(*n as u32),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// The unit symbol `resolvePropertyUnit` reports for an explicit `Unit`.
///
/// Only its ability to name a project LENGTH unit reaches the file (the
/// regenerated line writes `findUnitId(symbol)` or `$`), and no SI, derived or
/// monetary symbol normalises to a length-unit NAME. A conversion-based unit's
/// symbol can: an uncommon name passes through `conversionUnitSymbol`
/// unchanged. So SI and derived units report a symbol that cannot match, and
/// conversion-based ones report their name's symbol.
fn explicit_unit(src: &Source<'_>, ty: &str, attrs: &[JsVal]) -> Option<String> {
    let slot = match ty {
        "IFCPROPERTYBOUNDEDVALUE" => 4,
        "IFCPROPERTYSINGLEVALUE" | "IFCPROPERTYLISTVALUE" => 3,
        _ => return None,
    };
    let unit_ref = attrs.get(slot)?.as_num()? as u32;
    match src.entity(unit_ref) {
        Some((uty, uattrs)) if uty == "IFCCONVERSIONBASEDUNIT" => {
            let name = uattrs.get(2).and_then(JsVal::as_str).unwrap_or("");
            Some(super::units::conversion_unit_symbol(name))
        }
        _ => Some(format!("#{unit_ref}")),
    }
}
