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
//! the file as an aspect of the action's representation. IFC4 -> IFC2X3 is the
//! inverse for an action whose representation has exactly one IfcShapeAspect;
//! the configuration it consumed is dropped. Both read the source, so only an
//! unedited full export arms them. Twin of
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
    /// What the IFC2X3 supertype's WR61 admits as AppliedLoad.
    first: [&'static str; 2],
    /// The size of VaryingAppliedLoads: LIST [2:?] linear, [3:?] planar.
    min: usize,
}

const KINDS: [Kind; 2] = [
    Kind { ifc2x3: "IFCSTRUCTURALLINEARACTIONVARYING", ifc4: "IFCSTRUCTURALCURVEACTION", first: ["IFCSTRUCTURALLOADLINEARFORCE", "IFCSTRUCTURALLOADTEMPERATURE"], min: 2 },
    Kind { ifc2x3: "IFCSTRUCTURALPLANARACTIONVARYING", ifc4: "IFCSTRUCTURALSURFACEACTION", first: ["IFCSTRUCTURALLOADPLANARFORCE", "IFCSTRUCTURALLOADTEMPERATURE"], min: 3 },
];

const FROM_IFC2X3: &str = "an IFC2X3 varying action is written as an IFC4 curve or surface action with PredefinedType NOTDEFINED and an IfcStructuralLoadConfiguration holding its loads without Locations; its VaryingAppliedLoadLocation remains an IfcShapeAspect of the action representation";
const TO_IFC2X3: &str = "an IFC4 curve or surface action with an IfcStructuralLoadConfiguration is written as an IFC2X3 varying action, its locations taken from the one IfcShapeAspect of its representation; the configuration Name, Locations and the action PredefinedType have no slot in IFC2X3";

#[derive(Default)]
pub(crate) struct StructuralVarying {
    /// IFC2X3 -> IFC4: varying action id -> the id allocated for its configuration.
    config_ids: HashMap<u32, u32>,
    pending: Vec<String>,
    /// IFC4 -> IFC2X3: action id -> (kind, load values, shape aspect).
    actions: HashMap<u32, (&'static Kind, Vec<u32>, u32)>,
    consumed: HashSet<u32>,
}

/// The record's top-level arguments, framed by the shared record reader.
fn record(content: &[u8], start: usize, end: usize) -> Option<Vec<String>> {
    let text = String::from_utf8_lossy(&content[start..end]);
    split_top_level_args(record_frame(&text)?.args(&text))
}

/// A list of references, or None when any item is not one.
fn refs(token: &str) -> Option<Vec<u32>> {
    list_items(token)?.iter().map(|item| ref_id(Some(item))).collect()
}

impl StructuralVarying {
    /// IFC2X3 -> IFC4: one configuration id per varying action, from the writer's allocator.
    pub(crate) fn scan_ifc2x3(content: &[u8], kept: impl Fn(u32, usize) -> bool, mut allocate: impl FnMut() -> Option<u32>) -> Self {
        let mut result = Self::default();
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        while let Some((id, ty, start, _)) = scanner.next_entity() {
            if !KINDS.iter().any(|k| ty.eq_ignore_ascii_case(k.ifc2x3)) || !kept(id, start) { continue; }
            let Some(config) = allocate() else { break };
            result.config_ids.insert(id, config);
        }
        result
    }

    /// IFC4 -> IFC2X3: the actions that become varying actions and the configurations they consume.
    pub(crate) fn scan_ifc4(content: &[u8], kept: impl Fn(u32, usize) -> bool) -> Self {
        let mut aspects: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut configs: HashMap<u32, Vec<u32>> = HashMap::new();
        // Types of the loads IFC2X3 also has, the only values a varying action can hold.
        let mut loads: HashMap<u32, String> = HashMap::new();
        // (action id, kind, representation, applied load), and every activity's applied load.
        let mut candidates = Vec::new();
        let mut referrers: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut activity: HashMap<String, bool> = HashMap::new();
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        while let Some((id, ty, start, end)) = scanner.next_entity() {
            // Every structural record but the shape aspect starts so; the prefix keeps the rest of the file cheap.
            let shape = ty.eq_ignore_ascii_case("IFCSHAPEASPECT");
            if !shape && !ty.get(..13).is_some_and(|p| p.eq_ignore_ascii_case("IFCSTRUCTURAL")) { continue; }
            if !kept(id, start) { continue; }
            let ty = ty.to_ascii_uppercase();
            if ifc_lite_core::SchemaVersion::Ifc2x3.is_subtype_of(&ty, "IfcStructuralLoad") { loads.insert(id, ty); continue; }
            let is_activity = *activity.entry(ty.clone()).or_insert_with_key(|t| ifc_lite_core::SchemaVersion::Ifc4.is_subtype_of(t, "IfcStructuralActivity"));
            let config = ty == "IFCSTRUCTURALLOADCONFIGURATION";
            if !(shape || config || is_activity) { continue; }
            let Some(args) = record(content, start, end) else { continue };
            if shape {
                if let Some(of) = ref_id(args.get(4).map(String::as_str)) { aspects.entry(of).or_default().push(id); }
            } else if config {
                if let Some(values) = args.get(1).and_then(|v| refs(v)).filter(|v| !v.is_empty()) { configs.insert(id, values); }
            } else if let Some(load) = ref_id(args.get(7).map(String::as_str)) {
                referrers.entry(load).or_default().push(id);
                let kind = KINDS.iter().find(|k| k.ifc4 == ty);
                if let Some(kind) = kind.filter(|_| args.len() == 12 && !args[11].trim().eq_ignore_ascii_case(".CONST.")) {
                    candidates.push((id, kind, ref_id(Some(&args[6])), load));
                }
            }
        }
        let mut result = Self::default();
        for (id, kind, representation, load) in candidates {
            let Some(values) = configs.get(&load) else { continue };
            let aspect = match representation.and_then(|r| aspects.get(&r)).map(Vec::as_slice) { Some([only]) => *only, _ => continue };
            let first = loads.get(&values[0]).is_some_and(|t| kind.first.contains(&t.as_str()));
            if values.len() >= kind.min && first && values.iter().all(|v| loads.contains_key(v)) {
                result.actions.insert(id, (kind, values.clone(), aspect));
            }
        }
        result.consumed = referrers.into_iter()
            .filter(|(config, by)| configs.contains_key(config) && by.iter().all(|a| result.actions.contains_key(a)))
            .map(|(config, _)| config).collect();
        result
    }

    /// The target record body for a varying action of either schema, and what the change loses.
    pub(crate) fn rewrite(&mut self, id: u32, entity: &str, args: &[String]) -> Option<(String, Vec<String>)> {
        if let Some(&config) = self.config_ids.get(&id) {
            let kind = KINDS.iter().find(|k| k.ifc2x3 == entity).filter(|_| args.len() == 14)?;
            let mut loads = vec![ref_id(Some(&args[7]))?];
            loads.extend(refs(&args[13])?);
            if loads.len() < kind.min { return None; }
            let values = loads.iter().map(|l| format!("#{l}")).collect::<Vec<_>>().join(",");
            self.pending.push(format!("#{config}=IFCSTRUCTURALLOADCONFIGURATION($,({values}),$);"));
            let mut losses = vec![FROM_IFC2X3.to_string()];
            if args[10].trim() != "$" { losses.push(format!("{entity}.CausedBy has no slot in IFC4; its value is omitted")); }
            let body = [&args[..7], &[format!("#{config}"), args[8].clone(), args[9].clone(), args[11].clone(), ".NOTDEFINED.".into()]].concat();
            return Some((format!("{}({})", kind.ifc4, body.join(",")), losses));
        }
        let (kind, values, aspect) = self.actions.get(&id).filter(|(k, ..)| k.ifc4 == entity && args.len() == 12)?;
        let rest = values[1..].iter().map(|v| format!("#{v}")).collect::<Vec<_>>().join(",");
        let tail = [format!("#{}", values[0]), args[8].clone(), args[9].clone(), "$".into(), args[10].clone(), format!("#{aspect}"), format!("({rest})")];
        Some((format!("{}({})", kind.ifc2x3, [&args[..7], &tail].concat().join(",")), vec![TO_IFC2X3.to_string()]))
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
    fn an_ifc4_action_without_its_shape_aspect_is_not_rewritten_9668() {
        // No IfcShapeAspect names the action's representation, so IFC2X3 has no
        // location for the values: the configuration still has no IFC2X3 form.
        let source = model("IFC4", "#25=IFCSTRUCTURALLOADCONFIGURATION($,(#20,#21),((0.),(4.)));\n#30=IFCSTRUCTURALCURVEACTION('0d2HL$ILbNDhwyUI0qw12$',$,'Line',$,$,$,$,#25,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.LINEAR.);");
        assert!(export_step_with_stats(source.as_bytes(), &to("IFC2X3")).is_err());
    }
}
