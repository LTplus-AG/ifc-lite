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

use crate::step_text::quoted;

use super::jsval::{js_to_number, json_to_js_string, to_step_real, JsVal};
use super::pass::Pass;
use super::units::normalize_map_unit_name;
use super::values::Unwritable;
use super::wire::GeorefMutations;

const WITHOUT_CONTEXT: &str = "Cannot create IfcMapConversion: no IfcGeometricRepresentationContext is available to reference as SourceCRS. The IfcProjectedCRS is unaffected.";
const WITHOUT_CRS: &str = "Cannot create IfcMapConversion: no IfcProjectedCRS was requested and none exists in the file to reference as TargetCRS. Nothing was written.";
const UNPLANNED_REFUSAL: &str = "Georeferencing was not exported:";
const INCOMPLETE_MAP_CONVERSION: &str = "Cannot create IfcMapConversion from a partial edit: Eastings, Northings and OrthogonalHeight are all required.";
const PARTIAL_FACTORS: &str = "Cannot write IfcMapConversionScaled: FactorX, FactorY and FactorZ are all mandatory and must be finite numbers, and the triple given was not. The factors were not written.";
const FACTORS_ON_UNSCALED: &str = "Cannot write FactorX/FactorY/FactorZ onto an existing IfcMapConversion: they exist only on IfcMapConversionScaled, and this edit does not change the class. The factors were not written.";

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

/// `resolveMapUnitReference`: always a new unit, never an existing entity (one the generic API may have edited).
fn map_unit(pass: &mut Pass<'_, '_>, name: &str) -> Result<Option<u32>, Unwritable> {
    let normalized = normalize_map_unit_name(name);
    let prefix = if normalized == "METRE" {
        Some(None)
    } else {
        ifc_lite_core::SI_PREFIXES
            .iter()
            .find(|p| normalized == format!("{}METRE", p.name))
            .map(|p| Some(p.name))
    };
    if let Some(prefix) = prefix {
        let id = pass.allocate()?;
        let token = prefix.map_or("$".to_string(), |p| format!(".{p}."));
        pass.georef_lines.push((id, format!("#{id}=IFCSIUNIT(*,.LENGTHUNIT.,{token},.METRE.);")));
        return Ok(Some(id));
    }
    if normalized == "FOOT" || normalized == "US SURVEY FOOT" {
        let (dim, si, measure, unit) = (pass.allocate()?, pass.allocate()?, pass.allocate()?, pass.allocate()?);
        let factor = if normalized == "US SURVEY FOOT" { ifc_lite_core::US_SURVEY_FOOT_M } else { 0.3048 };
        pass.georef_lines.push((dim, format!("#{dim}=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);")));
        pass.georef_lines.push((si, format!("#{si}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);")));
        pass.georef_lines.push((measure, format!("#{measure}=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE({}),#{si});", to_step_real(factor)?)));
        pass.georef_lines.push((unit, format!("#{unit}=IFCCONVERSIONBASEDUNIT(#{dim},.LENGTHUNIT.,'{normalized}',#{measure});")));
        return Ok(Some(unit));
    }
    Ok(None)
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

fn real_or_unset(v: Option<&Value>) -> Result<String, Unwritable> {
    v.map_or(Ok("$".to_string()), |v| to_step_real(js_to_number(v)))
}

/// `declaresMapConversionScaled`: FILE_SCHEMA identifiers whose schema
/// declares `IfcMapConversionScaled`. Of the bundled schemas only
/// `IFC4X3.exp` (`IFC4X3_DEV_923b0514`, what was released as IFC4X3_ADD2)
/// does; `IFC4X3` is the bare family identifier. RC identifiers fail closed.
fn declares_map_conversion_scaled(file_schema: &str) -> bool {
    let token = file_schema.trim();
    token.eq_ignore_ascii_case("IFC4X3") || token.eq_ignore_ascii_case("IFC4X3_ADD2")
}

/// `scaledUndeclaredWarning`, verbatim.
fn scaled_undeclared_warning(file_schema: &str) -> String {
    format!("Cannot write IfcMapConversionScaled into a file declaring FILE_SCHEMA {file_schema}: that schema does not declare it (only IFC4X3 / IFC4X3_ADD2 do). FactorX/FactorY/FactorZ were not written, and the IfcMapConversion was written without them.")
}

/// `requestedFactors`: the FactorX/Y/Z triple, `None` when none was asked
/// for. A partial triple is reported and treated as none (all three are
/// mandatory on `IfcMapConversionScaled`; 1.0 for a gap would be a guess).
fn requested_factors<'a>(mc: &'a Map<String, Value>, warnings: &mut Vec<String>) -> Option<[&'a Value; 3]> {
    // A null is a factor nobody gave, as in the TypeScript writer.
    match ["factorX", "factorY", "factorZ"].map(|k| mc.get(k).filter(|v| !v.is_null())) {
        [Some(x), Some(y), Some(z)] if [x, y, z].iter().all(|v| js_to_number(v).is_finite()) => Some([x, y, z]),
        [None, None, None] => None,
        _ => {
            warnings.push(PARTIAL_FACTORS.to_string());
            None
        }
    }
}

/// `mapConversionLine`: `IFCMAPCONVERSIONSCALED` when all three factors
/// were requested and the schema declares it, else `IFCMAPCONVERSION`. The
/// scaled entity is the plain one plus FactorX/Y/Z, so one line serves both.
fn map_conversion_line(
    id: u32,
    context: u32,
    crs: u32,
    mc: &Map<String, Value>,
    [eastings, northings, height]: [f64; 3],
    warnings: &mut Vec<String>,
    file_schema: &str,
) -> Result<String, Unwritable> {
    let mut factors = requested_factors(mc, warnings);
    if factors.is_some() && !declares_map_conversion_scaled(file_schema) {
        warnings.push(scaled_undeclared_warning(file_schema));
        factors = None;
    }
    let mut line = format!(
        "#{id}=IFCMAPCONVERSION{}(#{context},#{crs},{},{},{},{},{},{}",
        if factors.is_some() { "SCALED" } else { "" },
        to_step_real(eastings + 0.0)?,
        to_step_real(northings + 0.0)?,
        to_step_real(height + 0.0)?,
        real_or_unset(mc.get("xAxisAbscissa"))?,
        real_or_unset(mc.get("xAxisOrdinate"))?,
        real_or_unset(mc.get("scale"))?,
    );
    for f in factors.into_iter().flatten() {
        line.push(',');
        line.push_str(&to_step_real(js_to_number(f))?);
    }
    line.push_str(");");
    Ok(line)
}

/// Queue edits on an existing record and nominate it as the TypeScript side does.
fn edit_existing(pass: &mut Pass<'_, '_>, id: u32, edits: Vec<(String, String)>) {
    let changed = !edits.is_empty();
    pass.queue_attributes(id, &edits);
    if changed && pass.has_emittable_host_bytes(id) {
        pass.nominees.georeferencing.insert(id);
    }
}

/// Named attribute edits for the keys `mc` or `crs` carries, in `pairs` order.
fn named_edits(m: &Map<String, Value>, pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs.iter().filter_map(|&(key, attr)| m.get(key).map(|v| (attr.to_string(), json_to_js_string(v)))).collect()
}

/// `MapUnit` as a reference token: the resolved or created unit, else `$`
/// with the unsupported-unit warning.
fn map_unit_token(pass: &mut Pass<'_, '_>, unit: &Value) -> Result<String, Unwritable> {
    let name = json_to_js_string(unit);
    Ok(match map_unit(pass, &name)? {
        Some(unit_id) => format!("#{unit_id}"),
        None => {
            pass.warnings.push(unit_warning(&name));
            "$".to_string()
        }
    })
}

/// Create the `IfcMapConversion` from the preferred context to `crs_id`, or
/// report that no context exists.
fn create_map_conversion(pass: &mut Pass<'_, '_>, crs_id: u32, mc: &Map<String, Value>, source_crs: &[u32], file_schema: &str) -> Result<(), Unwritable> {
    // A create needs the whole position (`+ 0.0` below folds -0 to 0): a partial edit whose record was deleted is refused, never written as 0.
    let pos = ["eastings", "northings", "orthogonalHeight"].map(|k| mc.get(k).filter(|v| !v.is_null()).map_or(f64::NAN, js_to_number));
    if pos.iter().any(|n| n.is_nan()) {
        // An unplanned caller (the viewer) never reads warnings: it gets a refusal, not a 0-filled or dropped position.
        if source_crs.is_empty() {
            return Err(Unwritable(format!("{UNPLANNED_REFUSAL} {INCOMPLETE_MAP_CONVERSION}")));
        }
        pass.warnings.push(INCOMPLETE_MAP_CONVERSION.to_string());
        return Ok(());
    }
    // The planner names the SourceCRS; a host that does not plan leaves the choice to the file's own contexts.
    let context = if source_crs.is_empty() {
        preferred_context(pass)
    } else {
        let contexts = pass.of_type("IFCGEOMETRICREPRESENTATIONCONTEXT");
        source_crs.iter().copied().find(|id| contexts.contains(id))
    };
    match context {
        Some(context) => {
            let mc_id = pass.allocate()?;
            let line = map_conversion_line(mc_id, context, crs_id, mc, pos, &mut pass.warnings, file_schema)?;
            pass.georef_lines.push((mc_id, line));
            pass.new_entity_count += 1;
        }
        None => pass.warnings.push(WITHOUT_CONTEXT.to_string()),
    }
    Ok(())
}

/// `applyGeoreferencingMutations`.
pub(crate) fn apply(pass: &mut Pass<'_, '_>, g: &GeorefMutations, file_schema: &str) -> Result<(), Unwritable> {
    let crs_ids = pass.of_type("IFCPROJECTEDCRS");
    let mut mc_ids = pass.of_type("IFCMAPCONVERSION");
    // The edited record is `mc_ids[0]`: an IfcMapConversionScaled exactly
    // when the file has no plain IfcMapConversion (the lists are disjoint).
    let first_is_scaled = mc_ids.is_empty();
    mc_ids.extend(pass.of_type("IFCMAPCONVERSIONSCALED"));

    if let (Some(crs), Some(&id)) = (&g.projected_crs, crs_ids.first()) {
        // Text is text (`$`, `*`, `#12` stay strings, as on the create path); only an empty value clears the slot.
        let raw = named_edits(
            crs,
            &[
                ("name", "Name"),
                ("description", "Description"),
                ("geodeticDatum", "GeodeticDatum"),
                ("verticalDatum", "VerticalDatum"),
                ("mapProjection", "MapProjection"),
                ("mapZone", "MapZone"),
            ],
        );
        // The text is text whatever it looks like: only an EMPTY value is the `$` token, a text that spells `$` is quoted.
        let text_attrs: Vec<String> = raw.iter().filter(|(_, text)| !text.is_empty()).map(|(attr, _)| attr.clone()).collect();
        let mut edits: Vec<(String, String)> = raw.into_iter().map(|(attr, text)| if text.is_empty() { (attr, "$".to_string()) } else { (attr, text) }).collect();
        if let Some(unit) = crs.get("mapUnit") {
            let value = map_unit_token(pass, unit)?;
            edits.push(("MapUnit".to_string(), value));
        }
        edit_existing(pass, id, edits);
        // Text is text (`$`, `*`, `#12` stay quoted strings): carried as a decision of this writer, not inside the value.
        for attr in text_attrs {
            pass.text_edits.insert((id, attr));
        }
    }

    if let (Some(mc), Some(&id)) = (&g.map_conversion, mc_ids.first()) {
        let mut edits = named_edits(
            mc,
            &[
                ("eastings", "Eastings"),
                ("northings", "Northings"),
                ("orthogonalHeight", "OrthogonalHeight"),
                ("xAxisAbscissa", "XAxisAbscissa"),
                ("xAxisOrdinate", "XAxisOrdinate"),
                ("scale", "Scale"),
            ],
        );
        if requested_factors(mc, &mut pass.warnings).is_some() {
            if first_is_scaled {
                edits.extend(named_edits(mc, &[("factorX", "FactorX"), ("factorY", "FactorY"), ("factorZ", "FactorZ")]));
            } else {
                pass.warnings.push(FACTORS_ON_UNSCALED.to_string());
            }
        }
        edit_existing(pass, id, edits);
    }

    if let (Some(crs), true) = (&g.projected_crs, crs_ids.is_empty()) {
        let crs_id = pass.allocate()?;
        let text = |key: &str| match crs.get(key).filter(|v| truthy(v)) {
            Some(v) => quoted(&json_to_js_string(v)),
            None => "$".to_string(),
        };
        let fields = ["name", "description", "geodeticDatum", "verticalDatum", "mapProjection", "mapZone"].map(text);
        let unit_ref = match crs.get("mapUnit") {
            Some(unit) => map_unit_token(pass, unit)?,
            None => "$".to_string(),
        };
        pass.georef_lines.push((crs_id, format!("#{crs_id}=IFCPROJECTEDCRS({},{unit_ref});", fields.join(","))));
        pass.new_entity_count += 1;
        if let Some(mc) = &g.map_conversion {
            create_map_conversion(pass, crs_id, mc, &g.source_crs, file_schema)?;
        } else if mc_ids.is_empty() && g.source_crs.is_empty() {
            return Err(Unwritable(format!("{UNPLANNED_REFUSAL} no position was given for the new IfcProjectedCRS.")));
        }
    } else if let (Some(mc), true, Some(&crs_id)) = (&g.map_conversion, mc_ids.is_empty(), crs_ids.first()) {
        create_map_conversion(pass, crs_id, mc, &g.source_crs, file_schema)?;
    } else if g.map_conversion.is_some() && mc_ids.is_empty() && crs_ids.is_empty() {
        pass.warnings.push(WITHOUT_CRS.to_string());
    }
    Ok(())
}
