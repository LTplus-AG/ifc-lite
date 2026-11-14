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
use std::collections::{HashMap, HashSet};
use crate::schema_ifc2x3_records::ref_id;
use crate::schema_structural_axes::list_items;
use crate::step_record_frame::record_frame;
use crate::step_slot::split_top_level_args;

/// One IFC2X3 varying action and the IFC4 action it becomes.
struct Kind {
    ifc2x3: &'static str,
    ifc4: &'static str,
    /// What the IFC2X3 supertype's WR61 admits as AppliedLoad; both
    /// directions take only loads that all share one of these types.
    first: [&'static str; 2],
    /// The size of VaryingAppliedLoads: LIST [2:?] linear, [3:?] planar.
    min: usize,
}

const KINDS: [Kind; 2] = [
    Kind { ifc2x3: "IFCSTRUCTURALLINEARACTIONVARYING", ifc4: "IFCSTRUCTURALCURVEACTION", first: ["IFCSTRUCTURALLOADLINEARFORCE", "IFCSTRUCTURALLOADTEMPERATURE"], min: 2 },
    Kind { ifc2x3: "IFCSTRUCTURALPLANARACTIONVARYING", ifc4: "IFCSTRUCTURALSURFACEACTION", first: ["IFCSTRUCTURALLOADPLANARFORCE", "IFCSTRUCTURALLOADTEMPERATURE"], min: 3 },
];

const FROM_IFC2X3: &str = "an IFC2X3 varying action is written as an IFC4 curve or surface action with PredefinedType NOTDEFINED and an IfcStructuralLoadConfiguration holding its loads without Locations; the IfcShapeAspect of its representation keeps the locations";
const TO_IFC2X3: &str = "an IFC4 curve or surface action with an IfcStructuralLoadConfiguration is written as an IFC2X3 varying action, its locations taken from the one IfcShapeAspect of its representation; the configuration Name, Locations and the action PredefinedType have no slot in IFC2X3";

#[derive(Default)]
pub(crate) struct StructuralVarying {
    /// IFC2X3 -> IFC4: varying action id -> (kind, loads, the id allocated for its configuration).
    upgrades: HashMap<u32, (&'static Kind, Vec<u32>, u32)>,
    pending: Vec<String>,
    /// IFC4 -> IFC2X3: action id -> (kind, configuration values, shape aspect).
    downgrades: HashMap<u32, (&'static Kind, Vec<u32>, u32)>,
    consumed: HashSet<u32>,
}

/// What one pass over the source collects for either direction.
#[derive(Default)]
struct Source {
    /// IfcProductDefinitionShape id -> the IfcShapeAspects naming it as PartOfProductDefinitionShape.
    aspects: HashMap<u32, Vec<u32>>,
    /// Types of the loads IFC2X3 also has, the only values a varying action can hold.
    loads: HashMap<u32, String>,
    /// IFC4 IfcStructuralLoadConfiguration id -> its values.
    configs: HashMap<u32, Vec<u32>>,
    /// The actions this direction converts from, with their arguments.
    actions: Vec<(u32, &'static Kind, Vec<String>)>,
    /// Load id -> the activities naming it as AppliedLoad.
    referrers: HashMap<u32, Vec<u32>>,
}

/// The record's top-level arguments, framed by the shared record reader.
fn record(content: &[u8], start: usize, end: usize) -> Option<Vec<String>> {
    let text = String::from_utf8_lossy(&content[start..end]);
    split_top_level_args(record_frame(&text)?.args(&text))
}

/// AppliedLoad then SubsequentAppliedLoads of an IFC2X3 varying action, or None.
fn varying_loads(kind: &Kind, args: &[String]) -> Option<Vec<u32>> {
    if args.len() != 14 { return None; }
    let mut loads = vec![ref_id(Some(&args[7]))?];
    loads.extend(refs(&args[13])?);
    (loads.len() >= kind.min).then_some(loads)
}

/// A list of references, or None when any item is not one.
fn refs(token: &str) -> Option<Vec<u32>> {
    list_items(token)?.iter().map(|item| ref_id(Some(item))).collect()
}

impl Source {
    fn scan(content: &[u8], kept: impl Fn(u32, usize) -> bool, upgrade: bool) -> Self {
        let mut source = Self::default();
        let mut activity: HashMap<String, bool> = HashMap::new();
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
            let is_activity = !upgrade && *activity.entry(ty).or_insert_with_key(|t| ifc_lite_core::SchemaVersion::Ifc4.is_subtype_of(t, "IfcStructuralActivity"));
            if !(shape || kind.is_some() || config || is_activity) { continue; }
            let Some(args) = record(content, start, end) else { continue };
            if shape {
                if let Some(of) = ref_id(args.get(4).map(String::as_str)) { source.aspects.entry(of).or_default().push(id); }
            } else if config {
                if let Some(values) = args.get(1).and_then(|v| refs(v)).filter(|v| !v.is_empty()) { source.configs.insert(id, values); }
            } else {
                if let Some(load) = ref_id(args.get(7).map(String::as_str)).filter(|_| is_activity) { source.referrers.entry(load).or_default().push(id); }
                if let Some(kind) = kind { source.actions.push((id, kind, args)); }
            }
        }
        source
    }

    /// The shape aspect locating `loads` when both schemas hold the action: the
    /// one aspect of its representation (and `location`, when IFC2X3 names
    /// one), enough loads, all of one type that the IFC2X3 WR61 admits.
    fn convertible(&self, kind: &Kind, representation: &str, loads: &[u32], location: Option<u32>) -> Option<u32> {
        let aspect = match ref_id(Some(representation)).and_then(|r| self.aspects.get(&r)).map(Vec::as_slice) { Some([only]) => *only, _ => return None };
        if location.is_some_and(|l| l != aspect) || loads.len() < kind.min { return None; }
        let first = self.loads.get(&loads[0]).filter(|t| kind.first.contains(&t.as_str()))?;
        loads.iter().all(|l| self.loads.get(l) == Some(first)).then_some(aspect)
    }
}

impl StructuralVarying {
    /// IFC2X3 -> IFC4: one configuration id per convertible varying action, in
    /// id order (the TypeScript twin's write order), from the writer's allocator.
    pub(crate) fn scan_ifc2x3(content: &[u8], kept: impl Fn(u32, usize) -> bool, mut allocate: impl FnMut() -> Option<u32>) -> Self {
        let source = Source::scan(content, kept, true);
        let mut convertible: Vec<_> = source.actions.iter().filter_map(|(id, kind, args)| {
            let loads = varying_loads(kind, args)?;
            source.convertible(kind, &args[6], &loads, Some(ref_id(Some(&args[12]))?))?;
            Some((*id, *kind, loads))
        }).collect();
        convertible.sort_unstable_by_key(|c| c.0);
        let mut result = Self::default();
        for (id, kind, loads) in convertible {
            let Some(config) = allocate() else { break };
            result.upgrades.insert(id, (kind, loads, config));
        }
        result
    }

    /// IFC4 -> IFC2X3: the actions that become varying actions and the configurations they consume.
    pub(crate) fn scan_ifc4(content: &[u8], kept: impl Fn(u32, usize) -> bool) -> Self {
        let source = Source::scan(content, kept, false);
        let names_config = |token: &String| {
            let mut found = Vec::new();
            crate::step_text::refs_in_line(token.as_bytes(), &mut found);
            found.iter().any(|r| source.configs.contains_key(r))
        };
        let mut result = Self::default();
        for (id, kind, args) in &source.actions {
            if args.len() != 12 || args[11].trim().eq_ignore_ascii_case(".CONST.") { continue; }
            let Some(values) = ref_id(Some(&args[7])).and_then(|c| source.configs.get(&c)) else { continue };
            // A configuration named outside AppliedLoad would dangle once it is dropped.
            if args.iter().enumerate().any(|(i, a)| i != 7 && names_config(a)) { continue; }
            if let Some(aspect) = source.convertible(kind, &args[6], values, None) {
                result.downgrades.insert(*id, (*kind, values.clone(), aspect));
            }
        }
        result.consumed = source.referrers.into_iter()
            .filter(|(config, by)| source.configs.contains_key(config) && by.iter().all(|a| result.downgrades.contains_key(a)))
            .map(|(config, _)| config).collect();
        result
    }

    /// The target record body for a varying action of either schema, and what the change loses.
    pub(crate) fn rewrite(&mut self, id: u32, entity: &str, args: &[String]) -> Option<(String, Vec<String>)> {
        if let Some((kind, loads, config)) = self.upgrades.get(&id).filter(|(k, ..)| k.ifc2x3 == entity && args.len() == 14) {
            let values = loads.iter().map(|l| format!("#{l}")).collect::<Vec<_>>().join(",");
            self.pending.push(format!("#{config}=IFCSTRUCTURALLOADCONFIGURATION($,({values}),$);"));
            let mut losses = vec![FROM_IFC2X3.to_string()];
            if args[10].trim() != "$" { losses.push(format!("{entity}.CausedBy has no slot in IFC4; its value is omitted")); }
            let body = [&args[..7], &[format!("#{config}"), args[8].clone(), args[9].clone(), args[11].clone(), ".NOTDEFINED.".into()]].concat();
            return Some((format!("{}({})", kind.ifc4, body.join(",")), losses));
        }
        let (kind, values, aspect) = self.downgrades.get(&id).filter(|(k, ..)| k.ifc4 == entity && args.len() == 12)?;
        let rest = values[1..].iter().map(|v| format!("#{v}")).collect::<Vec<_>>().join(",");
        let tail = [format!("#{}", values[0]), args[8].clone(), args[9].clone(), "$".into(), args[10].clone(), format!("#{aspect}"), format!("({rest})")];
        let mut losses = vec![TO_IFC2X3.to_string()];
        // `inspect` reports this for the records it sees; a rewritten one skips it.
        if args[9].trim() == "$" { losses.push(crate::schema_structural::destabilizing_unknown(entity)); }
        Some((format!("{}({})", kind.ifc2x3, [&args[..7], &tail].concat().join(",")), losses))
    }

    /// Whether the record is a configuration every referrer of which became a varying action.
    pub(crate) fn drops(&self, id: u32) -> bool { self.consumed.contains(&id) }

    /// The configurations written so far, to append after the source records.
    pub(crate) fn added(&mut self) -> Vec<String> { std::mem::take(&mut self.pending) }
}

#[cfg(test)]
mod tests {
    use crate::step::{export_step_with_diagnostics, export_step_with_stats, StepOptions};

    // Each action's IfcShapeAspect names the action's own IfcProductDefinitionShape, as in
    // structural/ifc_structuralanalysisview/steel-joint-modelled-with-shellelements--Axis-Struc.ifc.
    const SHARED: &str = "#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,$,$);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#4,$);
#3=IFCCARTESIANPOINT((0.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#3,$,$);
#5=IFCVERTEXPOINT(#3);
#6=IFCTOPOLOGYREPRESENTATION(#2,'Reference','Vertex',(#5));
#7=IFCTOPOLOGYREPRESENTATION(#2,'Reference','Vertex',(#5));
#10=IFCPRODUCTDEFINITIONSHAPE($,$,(#6));
#11=IFCSHAPEASPECT((#7),$,$,.U.,#10);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#6));
#13=IFCSHAPEASPECT((#7),$,$,.U.,#12);
#20=IFCSTRUCTURALLOADLINEARFORCE('start',0.,0.,-5.,0.,0.,0.);
#21=IFCSTRUCTURALLOADLINEARFORCE('end',0.,0.,-9.,0.,0.,0.);
#22=IFCSTRUCTURALLOADPLANARFORCE('a',0.,0.,-1.);
#23=IFCSTRUCTURALLOADPLANARFORCE('b',0.,0.,-2.);
#24=IFCSTRUCTURALLOADPLANARFORCE('c',0.,0.,-3.);";
    const LINE: &str = "#30=IFCSTRUCTURALLINEARACTIONVARYING('3AqvQc$eTFwQAT_AXxIZSF',$,'Line',$,$,$,#10,#20,.GLOBAL_COORDS.,.F.,$,.PROJECTED_LENGTH.,#11,(#21));";
    const AREA: &str = "#31=IFCSTRUCTURALPLANARACTIONVARYING('1uiQrU6X9TmxEpF_G_jsDX',$,'Area',$,$,$,#12,#22,.GLOBAL_COORDS.,.T.,$,.TRUE_LENGTH.,#13,(#23,#24));";

    fn model(schema: &str, data: &str) -> String {
        format!("ISO-10303-21;HEADER;FILE_SCHEMA(('{schema}'));ENDSEC;DATA;\n{SHARED}\n{data}\nENDSEC;END-ISO-10303-21;")
    }
    fn to(schema: &str) -> StepOptions { StepOptions { schema: Some(schema.into()), ..StepOptions::default() } }
    fn record(out: &str, id: &str) -> String { out.lines().find(|l| l.starts_with(id)).unwrap_or_default().to_string() }
    fn configs(out: &str) -> Vec<&str> { out.lines().filter(|l| l.contains("=IFCSTRUCTURALLOADCONFIGURATION(")).collect() }

    #[test]
    fn varying_actions_round_trip_through_ifc4_9668() {
        let source = model("IFC2X3", &format!("{LINE}\n{AREA}"));
        let (ifc4, _, warnings) = export_step_with_diagnostics(source.as_bytes(), &to("IFC4")).unwrap();
        // The ids after the source's highest, #31, in source order.
        assert_eq!(record(&ifc4, "#30="), "#30=IFCSTRUCTURALCURVEACTION('3AqvQc$eTFwQAT_AXxIZSF',$,'Line',$,$,$,#10,#32,.GLOBAL_COORDS.,.F.,.PROJECTED_LENGTH.,.NOTDEFINED.);");
        assert_eq!(record(&ifc4, "#31="), "#31=IFCSTRUCTURALSURFACEACTION('1uiQrU6X9TmxEpF_G_jsDX',$,'Area',$,$,$,#12,#33,.GLOBAL_COORDS.,.T.,.TRUE_LENGTH.,.NOTDEFINED.);");
        assert_eq!(configs(&ifc4), ["#32=IFCSTRUCTURALLOADCONFIGURATION($,(#20,#21),$);", "#33=IFCSTRUCTURALLOADCONFIGURATION($,(#22,#23,#24),$);"]);
        assert!(warnings.iter().any(|w| w.starts_with("2 structural conversion record(s): an IFC2X3 varying action is written")), "{warnings:?}");
        let log = crate::step_log::MutationLog::from_json("{}").unwrap();
        let (logged, _) = crate::step_log::export_step_with_log(source.as_bytes(), &to("IFC4"), &log).unwrap();
        assert_eq!(configs(&logged), configs(&ifc4));

        let (back, _, warnings) = export_step_with_diagnostics(ifc4.as_bytes(), &to("IFC2X3")).unwrap();
        assert_eq!(record(&back, "#30="), LINE);
        assert_eq!(record(&back, "#31="), AREA);
        assert!(configs(&back).is_empty(), "{back}");
        assert!(warnings.iter().any(|w| w.starts_with("2 structural conversion record(s): an IFC4 curve or surface action")), "{warnings:?}");
        let (logged, _) = crate::step_log::export_step_with_log(ifc4.as_bytes(), &to("IFC2X3"), &log).unwrap();
        assert_eq!((record(&logged, "#30="), record(&logged, "#31="), configs(&logged).len()), (LINE.to_string(), AREA.to_string(), 0));
    }

    #[test]
    fn caused_by_is_reported_9668() {
        let line = LINE.replace(",.F.,$,", ",.F.,#40,");
        let source = model("IFC2X3", &format!("#40=IFCSTRUCTURALPOINTREACTION('2wmGMbnLPTYekiqaYJVorK',$,$,$,$,$,$,#20,.GLOBAL_COORDS.);\n{line}"));
        let (_, _, warnings) = export_step_with_diagnostics(source.as_bytes(), &to("IFC4")).unwrap();
        assert!(warnings.iter().any(|w| w.contains("IFCSTRUCTURALLINEARACTIONVARYING.CausedBy has no slot in IFC4")), "{warnings:?}");
    }

    #[test]
    fn a_subset_keeps_the_varying_action_unconverted_9668() {
        let source = model("IFC2X3", LINE);
        let (out, _) = export_step_with_stats(source.as_bytes(), &StepOptions { included: Some(vec![1, 10, 11, 20, 21, 30]), ..to("IFC4") }).unwrap();
        assert!(record(&out, "#30=").starts_with("#30=IFCSTRUCTURALLINEARACTIONVARYING("), "{out}");
        assert!(configs(&out).is_empty(), "{out}");
    }

    #[test]
    fn unknown_destabilizing_load_is_reported_and_mixed_loads_refused_9668() {
        // ProjectedOrTrue has no IFC2X3 default, so it stays `$` and the slot fill reports it.
        let line = "#30=IFCSTRUCTURALCURVEACTION('0d2HL$ILbNDhwyUI0qw12$',$,'Line',$,$,$,#10,#25,.GLOBAL_COORDS.,$,$,.LINEAR.);";
        let source = model("IFC4", &format!("#25=IFCSTRUCTURALLOADCONFIGURATION($,(#20,#21),$);\n{line}"));
        let (out, _, warnings) = export_step_with_diagnostics(source.as_bytes(), &to("IFC2X3")).unwrap();
        assert_eq!(record(&out, "#30="), "#30=IFCSTRUCTURALLINEARACTIONVARYING('0d2HL$ILbNDhwyUI0qw12$',$,'Line',$,$,$,#10,#20,.GLOBAL_COORDS.,.F.,$,$,#11,(#21));");
        assert!(warnings.iter().any(|w| w.contains("IFCSTRUCTURALCURVEACTION.DestabilizingLoad is unknown")), "{warnings:?}");
        // A planar load among the values: not a varying linear action, so the configuration stays and has no IFC2X3 form.
        let mixed = source.replace("(#20,#21)", "(#20,#22)");
        assert!(export_step_with_stats(mixed.as_bytes(), &to("IFC2X3")).is_err());
    }

    #[test]
    fn converts_only_what_converts_back_9668() {
        // #13 places #12, not #10, so a downgrade could not find #30's locations again.
        let source = model("IFC2X3", &format!("{}\n{AREA}", LINE.replace(",#11,(#21));", ",#13,(#21));")));
        let (out, _) = export_step_with_stats(source.as_bytes(), &to("IFC4")).unwrap();
        assert!(record(&out, "#30=").starts_with("#30=IFCSTRUCTURALLINEARACTIONVARYING("), "{out}");
        assert_eq!(configs(&out), ["#32=IFCSTRUCTURALLOADCONFIGURATION($,(#22,#23,#24),$);"]);
    }

    #[test]
    fn a_configuration_named_outside_applied_load_is_kept_9668() {
        // An illegal ObjectPlacement naming the configuration: dropping it would leave #30 dangling.
        let (ifc4, _) = export_step_with_stats(model("IFC2X3", LINE).as_bytes(), &to("IFC4")).unwrap();
        assert!(ifc4.contains("'Line',$,$,$,#10,#31,"), "{ifc4}");
        let ifc4 = ifc4.replace("'Line',$,$,$,#10,#31,", "'Line',$,$,#31,#10,#31,");
        let result = export_step_with_stats(ifc4.as_bytes(), &to("IFC2X3"));
        assert!(result.as_ref().map_or(true, |(out, _)| !record(out, "#30=").starts_with("#30=IFCSTRUCTURALLINEARACTIONVARYING(")));
        assert!(result.is_err(), "the kept configuration has no IFC2X3 form");
    }

    #[test]
    fn an_ifc4_action_without_its_shape_aspect_is_not_rewritten_9668() {
        // No IfcShapeAspect names the action's representation, so IFC2X3 has no
        // location for the values: the configuration still has no IFC2X3 form.
        let source = model("IFC4", "#25=IFCSTRUCTURALLOADCONFIGURATION($,(#20,#21),((0.),(4.)));\n#30=IFCSTRUCTURALCURVEACTION('0d2HL$ILbNDhwyUI0qw12$',$,'Line',$,$,$,$,#25,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.LINEAR.);");
        assert!(export_step_with_stats(source.as_bytes(), &to("IFC2X3")).is_err());
    }
}
