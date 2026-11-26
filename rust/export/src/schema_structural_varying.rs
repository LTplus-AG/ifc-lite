// SPDX-License-Identifier: MPL-2.0
//! Varying structural actions between IFC2X3 and IFC4 (#9668). IFC4 dropped
//! IfcStructuralLinearActionVarying and IfcStructuralPlanarActionVarying
//! (IFC2X3_TC1.exp:7312, :7427). It holds several load values as an
//! IfcStructuralCurveAction or IfcStructuralSurfaceAction whose AppliedLoad is
//! an IfcStructuralLoadConfiguration (IFC4_ADD2_TC1.exp:9399, :9625, :9470).
//!
//! IFC2X3 -> IFC4 writes the action with PredefinedType NOTDEFINED and a new
//! configuration holding AppliedLoad then SubsequentAppliedLoads, without
//! Locations: IFC2X3 places the values with an IfcShapeAspect, which stays in
//! the file as the aspect of the action's representation. IFC4 -> IFC2X3 is the
//! inverse, and drops the configuration it consumed. Only actions that convert
//! back are converted (`Source::convertible` decides both directions). Both
//! read the source, so only an unedited full export arms them. Twin of
//! `packages/export/src/schema-converter-structural-varying.ts`.
use std::collections::{BTreeMap, HashMap, HashSet};
use crate::schema_structural_links::slot_ref;
use crate::schema_structural_axes::list_items;
use crate::step_record_frame::record_frame;
use crate::step_slot::{slot_is, split_top_level_args};

/// One IFC2X3 varying action and the IFC4 action it becomes.
struct Kind {
    ifc2x3: &'static str,
    ifc4: &'static str,
    /// What the IFC2X3 supertype's WR61 admits as AppliedLoad; both
    /// directions take only loads that all share one of these types.
    first: [&'static str; 2],
    /// The size of VaryingAppliedLoads: LIST [2:?] linear, [3:?] planar.
    min: usize,
    /// The IFC4 PredefinedTypes a downgrade takes: values at locations, linear
    /// in between (IFC4_ADD2_TC1.exp:2308, :2330), which the IFC2X3 varying
    /// action holds. SINUS, PARABOLA, DISCRETE and the rest keep their handling.
    spread: &'static [&'static str],
}

// Slot positions in the STEP records this module reads as text (attribute order of the IFC4 entities).
/// `IfcShapeAspect.PartOfProductDefinitionShape`.
const ASPECT_OF_SHAPE: usize = 4;
/// `IfcStructuralLoadConfiguration.Values`.
const CONFIGURATION_VALUES: usize = 1;

const KINDS: [Kind; 2] = [
    Kind { ifc2x3: "IFCSTRUCTURALLINEARACTIONVARYING", ifc4: "IFCSTRUCTURALCURVEACTION", first: ["IFCSTRUCTURALLOADLINEARFORCE", "IFCSTRUCTURALLOADTEMPERATURE"], min: 2, spread: &[".NOTDEFINED.", ".LINEAR.", ".POLYGONAL."] },
    Kind { ifc2x3: "IFCSTRUCTURALPLANARACTIONVARYING", ifc4: "IFCSTRUCTURALSURFACEACTION", first: ["IFCSTRUCTURALLOADPLANARFORCE", "IFCSTRUCTURALLOADTEMPERATURE"], min: 3, spread: &[".NOTDEFINED.", ".BILINEAR."] },
];

const FROM_IFC2X3: &str = "an IFC2X3 varying action is written as an IFC4 curve or surface action with PredefinedType NOTDEFINED and an IfcStructuralLoadConfiguration holding its loads without Locations; the IfcShapeAspect of its representation keeps the locations";
const TO_IFC2X3: &str = "an IFC4 curve or surface action with an IfcStructuralLoadConfiguration is written as an IFC2X3 varying action, its locations taken from the one IfcShapeAspect of its representation; the configuration Name, Locations and the action PredefinedType have no slot in IFC2X3";

#[derive(Default)]
pub(crate) struct StructuralVarying {
    /// IFC2X3 -> IFC4: convertible varying action id -> (kind, loads), until [`Self::assign`] gives it a configuration id.
    planned: BTreeMap<u32, (&'static Kind, Vec<u32>)>,
    /// IFC2X3 -> IFC4: varying action id -> whether its AppliedLoad is a load, for the actions no configuration holds. They are written constant (#11354).
    constants: HashMap<u32, bool>,
    /// Armed for IFC2X3 -> IFC4.
    upgrading: bool,
    /// IFC2X3 -> IFC4: varying action id -> (kind, loads, the id allocated for its configuration).
    upgrades: HashMap<u32, (&'static Kind, Vec<u32>, u32)>,
    /// Configuration records written so far, by id.
    pending: BTreeMap<u32, String>,
    /// IFC4 -> IFC2X3: action id -> (kind, configuration values, shape aspect).
    downgrades: HashMap<u32, (&'static Kind, Vec<u32>, u32)>,
    consumed: HashSet<u32>,
}

/// What one pass over the source collects for either direction.
#[derive(Default)]
struct Source {
    /// IfcProductDefinitionShape id -> the IfcShapeAspects naming it as PartOfProductDefinitionShape.
    aspects: HashMap<u32, Vec<(u32, Option<usize>)>>,
    /// Types of the loads IFC2X3 also has, the only values a varying action can hold.
    loads: HashMap<u32, String>,
    /// IFC4 IfcStructuralLoadConfiguration id -> its values.
    configs: HashMap<u32, Vec<u32>>,
    /// The actions this direction converts from, with their arguments.
    actions: Vec<(u32, &'static Kind, Vec<String>)>,
}

/// The record's top-level arguments, framed by the shared record reader.
pub(crate) fn record(content: &[u8], start: usize, end: usize) -> Option<Vec<String>> {
    let text = String::from_utf8_lossy(&content[start..end]);
    split_top_level_args(record_frame(&text)?.args(&text))
}

/// AppliedLoad then SubsequentAppliedLoads of an IFC2X3 varying action, or None.
fn varying_loads(args: &[String]) -> Option<Vec<u32>> {
    if args.len() != 14 { return None; }
    // Comment-aware, as the constant fallback reads AppliedLoad: a commented reference must not fall back (#11354).
    let mut loads = vec![slot_ref(&args[7])?];
    loads.extend(refs(&args[13])?);
    Some(loads)
}

/// A list of references, or None when any item is not one.
fn refs(token: &str) -> Option<Vec<u32>> {
    list_items(token)?.iter().map(|item| slot_ref(item)).collect()
}

impl Source {
    fn scan(content: &[u8], kept: impl Fn(u32, usize) -> bool, upgrade: bool) -> Self {
        let mut source = Self::default();
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        while let Some((id, ty, start, end)) = scanner.next_entity() {
            // Every structural record but the shape aspect starts so; the prefix keeps the rest of the file cheap.
            let shape = ty.eq_ignore_ascii_case("IFCSHAPEASPECT");
            if !shape && !ty.get(..13).is_some_and(|p| p.eq_ignore_ascii_case("IFCSTRUCTURAL")) { continue; }
            if !kept(id, start) { continue; }
            let ty = ty.to_ascii_uppercase();
            if ifc_lite_core::SchemaVersion::Ifc2x3.is_subtype_of(&ty, "IfcStructuralLoad") { source.loads.insert(id, ty); continue; }
            let kind = KINDS.iter().find(|k| if upgrade { k.ifc2x3 == ty } else { k.ifc4 == ty });
            let config = !upgrade && ty == "IFCSTRUCTURALLOADCONFIGURATION";
            if !(shape || kind.is_some() || config) { continue; }
            let Some(args) = record(content, start, end) else { continue };
            if shape {
                if let Some(of) = args.get(ASPECT_OF_SHAPE).and_then(|a| slot_ref(a)) { source.aspects.entry(of).or_default().push((id, args.first().and_then(|a| list_items(a)).map(|r| r.len()))); }
            } else if config {
                if let Some(values) = args.get(CONFIGURATION_VALUES).and_then(|v| refs(v)).filter(|v| !v.is_empty()) { source.configs.insert(id, values); }
            } else if let Some(kind) = kind {
                source.actions.push((id, kind, args));
            }
        }
        source
    }

    /// The shape aspect locating `loads` when both schemas hold the action: the
    /// one aspect of its representation (and `location`, when IFC2X3 names
    /// one), enough loads, all of one type that the IFC2X3 WR61 admits.
    fn convertible(&self, kind: &Kind, representation: &str, loads: &[u32], location: Option<u32>) -> Option<u32> {
        let Some(&[(aspect, representations)]) = slot_ref(representation).and_then(|r| self.aspects.get(&r)).map(Vec::as_slice) else { return None };
        if location.is_some_and(|l| l != aspect) || loads.len() < kind.min || representations != Some(loads.len()) { return None; }
        let first = self.loads.get(&loads[0]).filter(|t| kind.first.contains(&t.as_str()))?;
        loads.iter().all(|l| self.loads.get(l) == Some(first)).then_some(aspect)
    }
}

impl StructuralVarying {
    /// IFC2X3 -> IFC4: the varying actions that convert, in id order, each still
    /// without a configuration id ([`Self::assign`]).
    pub(crate) fn scan_ifc2x3(content: &[u8], kept: impl Fn(u32, usize) -> bool) -> Self {
        let source = Source::scan(content, kept, true);
        let mut result = Self { upgrading: true, ..Self::default() };
        for (id, kind, args) in &source.actions {
            let Some(loads) = varying_loads(args) else { continue };
            let Some(location) = slot_ref(&args[12]) else { continue };
            if source.convertible(kind, &args[6], &loads, Some(location)).is_some() { result.planned.insert(*id, (*kind, loads)); }
        }
        // An incomplete action keeps its initial load only if it is a direct load its source kind admits (#11354).
        for (id, kind, args) in source.actions.iter().filter(|(id, _, args)| args.len() == 14 && !result.planned.contains_key(id)) {
            let load = slot_ref(&args[7]).and_then(|id| source.loads.get(&id))
                .is_some_and(|ty| kind.first.contains(&ty.as_str()));
            result.constants.insert(*id, load);
        }
        result
    }

    /// The varying actions that convert and still need a configuration id, in id order.
    pub(crate) fn needs_ids(&self) -> impl Iterator<Item = u32> + '_ { self.planned.keys().copied() }

    /// Whether `entity` is an IFC2X3 varying action.
    pub(crate) fn is_varying(entity: &str) -> bool { Self::target(entity).is_some() }

    pub(crate) fn target(entity: &str) -> Option<&'static str> {
        KINDS.iter().find(|kind| entity.eq_ignore_ascii_case(kind.ifc2x3)).map(|kind| kind.ifc4)
    }

    pub(crate) fn admits_direct_load(entity: &str, load: &str) -> bool {
        KINDS.iter().any(|kind| kind.ifc2x3.eq_ignore_ascii_case(entity)
            && kind.first.iter().any(|ty| ty.eq_ignore_ascii_case(load)))
    }

    /// Whether this varying action converts and still needs a configuration id.
    pub(crate) fn plans(&self, id: u32) -> bool { self.planned.contains_key(&id) }

    /// Write the configuration of `action` under `id`.
    pub(crate) fn assign(&mut self, action: u32, id: u32) {
        if let Some((kind, loads)) = self.planned.remove(&action) { self.upgrades.insert(action, (kind, loads, id)); }
    }

    /// Whether the upgrade writes this varying action as an IFC4 action: with a configuration, or constant.
    pub(crate) fn converts(&self, id: u32) -> bool { self.planned.contains_key(&id) || self.constants.contains_key(&id) }

    /// Whether this is an IFC2X3 varying action the upgrade leaves unconverted: only one without the 14 attributes IFC2X3 gives it.
    pub(crate) fn stays_unconverted(&self, id: u32, entity: &str) -> bool {
        self.upgrading && Self::is_varying(entity) && !self.upgrades.contains_key(&id) && !self.constants.contains_key(&id)
    }

    /// IFC4 -> IFC2X3: the actions that become varying actions and the configurations they consume.
    pub(crate) fn scan_ifc4(content: &[u8], kept: impl Fn(u32, usize) -> bool) -> Self {
        let source = Source::scan(content, &kept, false);
        let names_config = |token: &String| crate::step_text::ref_spans(token.as_bytes()).filter_map(|r| r.id).any(|r| source.configs.contains_key(&r));
        let mut result = Self::default();
        for (id, kind, args) in &source.actions {
            if args.len() != 12 || !kind.spread.iter().any(|s| args[11].trim().eq_ignore_ascii_case(s)) { continue; }
            let Some((config, values)) = slot_ref(&args[7]).and_then(|c| source.configs.get_key_value(&c)) else { continue };
            // A configuration named outside AppliedLoad would dangle once it is dropped.
            if args.iter().enumerate().any(|(i, a)| i != 7 && names_config(a)) { continue; }
            if let Some(aspect) = source.convertible(kind, &args[6], values, None) {
                result.downgrades.insert(*id, (*kind, values.clone(), aspect));
                result.consumed.insert(*config);
            }
        }
        if !result.consumed.is_empty() {
            // Any other record naming a consumed configuration (an action that does not
            // convert, or a slot the schema does not allow) keeps it, so nothing dangles.
            let mut scanner = ifc_lite_core::EntityScanner::new(content);
            while let Some((id, _, start, end)) = scanner.next_entity() {
                if result.downgrades.contains_key(&id) || !kept(id, start) { continue; }
                for r in crate::step_text::ref_spans(&content[start..end]).filter_map(|r| r.id) {
                    if r != id { result.consumed.remove(&r); }
                }
            }
        }
        result
    }

    /// The target body, loss warnings, and the attribute values the rewrite dropped.
    /// `cause_carried`: a 'Causes' relationship holds the action's CausedBy, so it is not lost.
    pub(crate) fn rewrite(&mut self, id: u32, entity: &str, args: &[String], cause_carried: bool) -> Option<(String, Vec<String>, usize)> {
        if let Some((kind, loads, config)) = self.upgrades.get(&id).filter(|(k, ..)| k.ifc2x3 == entity && args.len() == 14) {
            let values = loads.iter().map(|l| format!("#{l}")).collect::<Vec<_>>().join(",");
            self.pending.insert(*config, format!("#{config}=IFCSTRUCTURALLOADCONFIGURATION($,({values}),$);"));
            let mut losses = vec![FROM_IFC2X3.to_string()];
            let cause = &args[crate::schema_structural_carriers::CAUSED_BY];
            // One predicate for the warning and the count (#10779), as in the TypeScript rewrite.
            let cause_dropped = !cause_carried && crate::schema_convert::holds_value(cause);
            if cause_dropped { losses.push(format!("{entity}.CausedBy has no slot in IFC4; its value is omitted")); }
            let body = [&args[..7], &[format!("#{config}"), args[8].clone(), args[9].clone(), args[11].clone(), ".NOTDEFINED.".into()]].concat();
            return Some((format!("{}({})", kind.ifc4, body.join(",")), losses, usize::from(cause_dropped)));
        }
        if let Some(&load) = self.constants.get(&id).filter(|_| args.len() == 14) {
            let target = Self::target(entity)?;
            let constant = crate::schema_structural_varying_constant::constant_action(target, entity, args, load, cause_carried);
            return Some((constant.body, constant.warnings, constant.dropped));
        }
        let (kind, values, aspect) = self.downgrades.get(&id).filter(|(k, ..)| k.ifc4 == entity && args.len() == 12)?;
        let rest = values[1..].iter().map(|v| format!("#{v}")).collect::<Vec<_>>().join(",");
        let tail = [format!("#{}", values[0]), args[8].clone(), args[9].clone(), "$".into(), args[10].clone(), format!("#{aspect}"), format!("({rest})")];
        let mut losses = vec![TO_IFC2X3.to_string()];
        // `inspect` reports this for the records it sees; a rewritten one skips it.
        if slot_is(&args[9], "$") { losses.push(crate::schema_structural::destabilizing_unknown(entity)); }
        Some((format!("{}({})", kind.ifc2x3, [&args[..7], &tail].concat().join(",")), losses, 0))
    }

    /// Whether the record is a configuration every referrer of which became a varying action.
    pub(crate) fn drops(&self, id: u32) -> bool { self.consumed.contains(&id) }

    /// The configurations written so far, in id order (the TypeScript twin's), to append after the source records.
    pub(crate) fn added(&mut self) -> Vec<String> { std::mem::take(&mut self.pending).into_values().collect() }
}

#[cfg(test)]
#[path = "schema_structural_varying_tests.rs"]
mod tests;
