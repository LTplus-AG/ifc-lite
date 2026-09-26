// SPDX-License-Identifier: MPL-2.0
//! Georeferencing edits (`step-georeferencing.ts`, `step-map-unit.ts`): an
//! existing `IfcProjectedCRS` / `IfcMapConversion` takes the edits as named
//! attribute edits on its own line; a missing one is created (after the
//! generated sets, before the created entities), with `MapUnit` resolved to
//! a project length unit or a new one.
//!
//! IFC2X3 has neither entity. The TypeScript exporter refuses a georeferencing
//! edit for an IFC2X3 output, and so does this one; an IFC2X3 model carries its
//! georeferencing as `ePSet_MapConversion` / `ePSet_ProjectedCRS` property
//! sets, which are ordinary property edits in the log.

use serde_json::{Map, Value};

use crate::step_text::escape;

use super::jsval::{js_to_number, json_to_js_string, to_step_real, JsVal};
use super::pass::Pass;
use super::units::{find_length_unit_reference, normalize_map_unit_name};
use super::wire::GeorefMutations;

const WITHOUT_CONTEXT: &str = "Cannot create IfcMapConversion: no IfcGeometricRepresentationContext is available to reference as SourceCRS. The IfcProjectedCRS is unaffected.";
const WITHOUT_CRS: &str = "Cannot create IfcMapConversion: no IfcProjectedCRS was requested and none exists in the file to reference as TargetCRS. Nothing was written.";

/// The error the TypeScript exporter throws for an IFC2X3 output.
pub(crate) const IFC2X3_REFUSAL: &str = "Georeferencing creation and editing requires IFC4 or newer. IFC2X3 does not support IfcProjectedCRS or IfcMapConversion.";

fn unit_warning(name: &str) -> String {
    format!(
        "Cannot express map unit {} as an IfcNamedUnit: only metres (with any SI prefix), FOOT and US SURVEY FOOT are supported. IfcProjectedCRS.MapUnit was left unset rather than declared as metres.",
        Value::String(name.to_string())
    )
}

/// JavaScript truthiness of a JSON value.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        _ => super::jsval::json_number(v).is_none_or(|f| f != 0.0 && !f.is_nan()),
    }
}

/// Whether the edits ask for anything (`Object.keys(...).length > 0` on either).
pub(crate) fn requests_anything(g: &GeorefMutations) -> bool {
    g.projected_crs.as_ref().is_some_and(|m| !m.is_empty()) || g.map_conversion.as_ref().is_some_and(|m| !m.is_empty())
}

/// `resolveMapUnitReference`: a project length unit, else a new one.
fn map_unit(pass: &mut Pass<'_, '_>, name: &str) -> Option<u32> {
    let normalized = normalize_map_unit_name(name);
    if let Some(existing) = find_length_unit_reference(&normalized, pass.src, &|id| pass.is_deleted(id)) {
        return Some(existing);
    }
    let prefix = if normalized == "METRE" {
        Some(None)
    } else {
        ["FEMTO", "MICRO", "HECTO", "CENTI", "MILLI", "EXA", "PETA", "TERA", "GIGA", "MEGA", "KILO", "DECA", "DECI", "NANO", "PICO", "ATTO"]
            .iter()
            .find(|p| normalized == format!("{p}METRE"))
            .map(|p| Some(*p))
    };
    if let Some(prefix) = prefix {
        let id = pass.allocate();
        let token = prefix.map_or("$".to_string(), |p| format!(".{p}."));
        pass.georef_lines.push(format!("#{id}=IFCSIUNIT(*,.LENGTHUNIT.,{token},.METRE.);"));
        return Some(id);
    }
    if normalized == "FOOT" || normalized == "US SURVEY FOOT" {
        let (dim, si, measure, unit) = (pass.allocate(), pass.allocate(), pass.allocate(), pass.allocate());
        let factor = if normalized == "US SURVEY FOOT" { 1200.0 / 3937.0 } else { 0.3048 };
        pass.georef_lines.push(format!("#{dim}=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);"));
        pass.georef_lines.push(format!("#{si}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);"));
        pass.georef_lines.push(format!("#{measure}=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE({}),#{si});", to_step_real(factor)));
        pass.georef_lines.push(format!("#{unit}=IFCCONVERSIONBASEDUNIT(#{dim},.LENGTHUNIT.,'{normalized}',#{measure});"));
        return Some(unit);
    }
    None
}

/// `findPreferredGeometricRepresentationContextId`.
fn preferred_context(pass: &Pass<'_, '_>) -> Option<u32> {
    let ids: Vec<u32> =
        pass.of_type("IFCGEOMETRICREPRESENTATIONCONTEXT").into_iter().filter(|&id| pass.src.has(id)).collect();
    let mut first_3d = None;
    for &id in &ids {
        let Some((_, attrs)) = pass.src.entity(id) else { continue };
        let context_type = attrs.get(1).and_then(JsVal::as_str).map(|s| s.trim().to_uppercase()).unwrap_or_default();
        let dimension = attrs.get(2).and_then(JsVal::as_num);
        if dimension == Some(3.0) && first_3d.is_none() {
            first_3d = Some(id);
        }
        if context_type == "MODEL" && dimension == Some(3.0) {
            return Some(id);
        }
    }
    first_3d.or_else(|| ids.first().copied())
}

fn real_or_zero(v: Option<&Value>) -> String {
    let n = v.map_or(f64::NAN, js_to_number);
    to_step_real(if n.is_nan() || n == 0.0 { 0.0 } else { n })
}

fn real_or_unset(v: Option<&Value>) -> String {
    v.map_or("$".to_string(), |v| to_step_real(js_to_number(v)))
}

fn map_conversion_line(id: u32, context: u32, crs: u32, mc: &Map<String, Value>) -> String {
    format!(
        "#{id}=IFCMAPCONVERSION(#{context},#{crs},{},{},{},{},{},{});",
        real_or_zero(mc.get("eastings")),
        real_or_zero(mc.get("northings")),
        real_or_zero(mc.get("orthogonalHeight")),
        real_or_unset(mc.get("xAxisAbscissa")),
        real_or_unset(mc.get("xAxisOrdinate")),
        real_or_unset(mc.get("scale")),
    )
}

/// Queue edits on an existing record and nominate it as the TypeScript side does.
fn edit_existing(pass: &mut Pass<'_, '_>, id: u32, edits: Vec<(String, String)>) {
    let changed = !edits.is_empty();
    pass.queue_attributes(id, &edits);
    if changed && pass.has_emittable_host_bytes(id) {
        pass.nominees.georeferencing.insert(id);
    }
}

/// `applyGeoreferencingMutations`.
pub(crate) fn apply(pass: &mut Pass<'_, '_>, g: &GeorefMutations) {
    let crs_ids = pass.of_type("IFCPROJECTEDCRS");
    let mut mc_ids = pass.of_type("IFCMAPCONVERSION");
    mc_ids.extend(pass.of_type("IFCMAPCONVERSIONSCALED"));

    if let (Some(crs), Some(&id)) = (&g.projected_crs, crs_ids.first()) {
        let mut edits = Vec::new();
        for (key, attr) in [
            ("name", "Name"),
            ("description", "Description"),
            ("geodeticDatum", "GeodeticDatum"),
            ("verticalDatum", "VerticalDatum"),
            ("mapProjection", "MapProjection"),
            ("mapZone", "MapZone"),
        ] {
            if let Some(v) = crs.get(key) {
                edits.push((attr.to_string(), json_to_js_string(v)));
            }
        }
        if let Some(unit) = crs.get("mapUnit") {
            let name = json_to_js_string(unit);
            let value = match map_unit(pass, &name) {
                Some(unit_id) => format!("#{unit_id}"),
                None => {
                    pass.warnings.push(unit_warning(&name));
                    "$".to_string()
                }
            };
            edits.push(("MapUnit".to_string(), value));
        }
        edit_existing(pass, id, edits);
    }

    if let (Some(mc), Some(&id)) = (&g.map_conversion, mc_ids.first()) {
        let mut edits = Vec::new();
        for (key, attr) in [
            ("eastings", "Eastings"),
            ("northings", "Northings"),
            ("orthogonalHeight", "OrthogonalHeight"),
            ("xAxisAbscissa", "XAxisAbscissa"),
            ("xAxisOrdinate", "XAxisOrdinate"),
            ("scale", "Scale"),
        ] {
            if let Some(v) = mc.get(key) {
                edits.push((attr.to_string(), json_to_js_string(v)));
            }
        }
        edit_existing(pass, id, edits);
    }

    let empty = Map::new();
    if let (Some(crs), true) = (&g.projected_crs, crs_ids.is_empty()) {
        let crs_id = pass.allocate();
        let text = |key: &str| match crs.get(key).filter(|v| truthy(v)) {
            Some(v) => format!("'{}'", escape(&json_to_js_string(v))),
            None => "$".to_string(),
        };
        let fields = ["name", "description", "geodeticDatum", "verticalDatum", "mapProjection", "mapZone"].map(text);
        let mut unit_ref = "$".to_string();
        if let Some(unit) = crs.get("mapUnit") {
            let name = json_to_js_string(unit);
            match map_unit(pass, &name) {
                Some(unit_id) => unit_ref = format!("#{unit_id}"),
                None => pass.warnings.push(unit_warning(&name)),
            }
        }
        pass.georef_lines.push(format!("#{crs_id}=IFCPROJECTEDCRS({},{unit_ref});", fields.join(",")));
        pass.new_entity_count += 1;
        match preferred_context(pass) {
            Some(context) => {
                let mc_id = pass.allocate();
                let mc = g.map_conversion.as_ref().unwrap_or(&empty);
                pass.georef_lines.push(map_conversion_line(mc_id, context, crs_id, mc));
                pass.new_entity_count += 1;
            }
            None => pass.warnings.push(WITHOUT_CONTEXT.to_string()),
        }
    } else if let (Some(mc), true, Some(&crs_id)) = (&g.map_conversion, mc_ids.is_empty(), crs_ids.first()) {
        match preferred_context(pass) {
            Some(context) => {
                let mc_id = pass.allocate();
                pass.georef_lines.push(map_conversion_line(mc_id, context, crs_id, mc));
                pass.new_entity_count += 1;
            }
            None => pass.warnings.push(WITHOUT_CONTEXT.to_string()),
        }
    } else if g.map_conversion.is_some() && mc_ids.is_empty() && crs_ids.is_empty() {
        pass.warnings.push(WITHOUT_CRS.to_string());
    }
}
