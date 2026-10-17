// SPDX-License-Identifier: MPL-2.0
//! Map coordinates for the LandXML terrain export: the `IfcMapConversion` of a
//! representation's own context, the project and map length units, and the
//! strict refusals that keep a guessed CRS or unit out of a survey hand-off.
//!
//! The arithmetic is `GeoReference::local_to_map`, the same conversion the
//! viewer and server georeference with; the numeric preflight is the one
//! map normalization already enforces (`step_map_transform::preflight`).

use ifc_lite_core::units::{get_conversion_based_unit_factor, try_si_prefix_multiplier};
use ifc_lite_core::{
    AttributeValue, DecodedEntity, EntityDecoder, EntityScanner, GeoRefExtractor,
    GeoReference, IfcType, MAX_CONTEXT_DEPTH,
};

use crate::step_map_transform::preflight;

/// The target CRS a terrain's coordinates are written in.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Crs {
    pub name: String,
    pub geodetic_datum: Option<String>,
    pub vertical_datum: Option<String>,
}

/// Local (project-unit) coordinates to map metres for one context.
pub(super) struct MapFrame {
    georef: GeoReference,
    /// Metres per map unit (`IfcProjectedCRS.MapUnit`, else the project unit).
    map_metres: f64,
    pub crs: Crs,
}

impl MapFrame {
    /// `(northing, easting, elevation)` in metres.
    pub fn to_map_metres(&self, x: f64, y: f64, z: f64) -> [f64; 3] {
        let (e, n, h) = self.georef.local_to_map(x, y, z);
        [n * self.map_metres, e * self.map_metres, h * self.map_metres]
    }
}

/// What a whole-file scan has to find once, whatever terrains are selected.
pub(super) struct ModelFacts {
    /// `(id, type, SourceCRS)` of every `IfcMapConversion` / `…Scaled`.
    conversions: Vec<(u32, IfcType, Option<u32>)>,
    project_metres: f64,
    pub project_name: Option<String>,
}

impl ModelFacts {
    pub fn scan(content: &[u8], decoder: &mut EntityDecoder) -> Result<Self, String> {
        let mut scanner = EntityScanner::new(content);
        let mut conversion_ids = Vec::new();
        let mut projects = Vec::new();
        while let Some((id, name, _, _)) = scanner.next_entity() {
            match IfcType::from_str(name) {
                kind @ (IfcType::IfcMapConversion | IfcType::IfcMapConversionScaled) => conversion_ids.push((id, kind)),
                IfcType::IfcProject => projects.push(id),
                _ => {}
            }
        }
        let [project_id] = projects[..] else {
            return Err(format!("the model has {} IfcProject entities; exactly one is required to resolve its length unit", projects.len()));
        };
        let project = decode(decoder, project_id)?;
        let project_metres = project_length_metres(&project, decoder)?;
        let project_name = text(&project, 2).or_else(|| text(&project, 5));
        let mut conversions = Vec::with_capacity(conversion_ids.len());
        for (id, kind) in conversion_ids {
            let source = decode(decoder, id)?.get_ref(0);
            conversions.push((id, kind, source));
        }
        Ok(Self { conversions, project_metres, project_name })
    }

    /// The map frame for a representation authored in `context`: the one
    /// conversion whose SourceCRS is that context or one of its parents.
    pub fn frame(&self, context: u32, decoder: &mut EntityDecoder) -> Result<MapFrame, String> {
        let mut matching = Vec::new();
        let mut current = Some(context);
        let mut seen = Vec::new();
        while let Some(id) = current {
            if seen.len() >= MAX_CONTEXT_DEPTH || seen.contains(&id) {
                return Err(format!("the ParentContext chain of context #{context} is cyclic or too deep"));
            }
            seen.push(id);
            matching.extend(self.conversions.iter().filter(|(_, _, source)| *source == Some(id)));
            let node = decode(decoder, id)?;
            current = match node.ifc_type {
                IfcType::IfcGeometricRepresentationSubContext => Some(node.get_ref(6).ok_or_else(|| format!("subcontext #{id} has no ParentContext"))?),
                _ => None,
            };
        }
        let (conversion_id, kind, source) = match matching[..] {
            [only] => only.clone(),
            [] => return Err(format!("context #{context} has no IfcMapConversion; a projected CRS and map conversion are required, and local coordinates are never assumed to be map coordinates")),
            _ => return Err(format!("context #{context} has {} IfcMapConversion operations; the target CRS is ambiguous", matching.len())),
        };
        let conversion = decode(decoder, conversion_id)?;
        preflight::operation(&conversion).map_err(|reason| format!("IfcMapConversion #{conversion_id}: {reason}"))?;
        // `local_to_map` reads the source context's own axes as the engineering
        // frame. A non-identity WorldCoordinateSystem would need composing once,
        // and composing it twice is the error map normalization refuses too.
        preflight::context_frame(source.unwrap_or(context), decoder)?;
        let crs_id = conversion.get_ref(1).ok_or_else(|| format!("IfcMapConversion #{conversion_id} has no TargetCRS"))?;
        let target = decode(decoder, crs_id)?;
        if target.ifc_type != IfcType::IfcProjectedCRS {
            return Err(format!("TargetCRS #{crs_id} is an {}, not an IfcProjectedCRS", target.ifc_type.name()));
        }
        let crs = Crs {
            name: text(&target, 0).ok_or_else(|| format!("IfcProjectedCRS #{crs_id} has no Name; the exporter will not guess a CRS"))?,
            geodetic_datum: text(&target, 2),
            vertical_datum: text(&target, 3),
        };
        // IFC: an omitted MapUnit is the project length unit.
        let map_metres = match target.get_ref(6) {
            Some(unit) => length_unit_metres(&decode(decoder, unit)?)?,
            None => self.project_metres,
        };
        // Scale is the combined local-to-map unit conversion. Defaulting it to
        // 1 across a unit change would misplace every vertex by that ratio.
        let scale_omitted = conversion.get(7).is_none_or(AttributeValue::is_null);
        if scale_omitted && (map_metres - self.project_metres).abs() > 1e-12 * map_metres.max(self.project_metres) {
            return Err(format!("IfcMapConversion #{conversion_id} omits Scale while the project and map length units differ; Scale is required, the exporter will not infer it"));
        }
        let georef = GeoRefExtractor::extract(decoder, &[(conversion_id, kind), (crs_id, IfcType::IfcProjectedCRS)])
            .map_err(|error| error.to_string())?
            .filter(|georef| georef.has_map_conversion)
            .ok_or_else(|| format!("IfcMapConversion #{conversion_id} cannot be resolved exactly"))?;
        Ok(MapFrame { georef, map_metres, crs })
    }
}

pub(super) fn decode(decoder: &mut EntityDecoder, id: u32) -> Result<DecodedEntity, String> {
    decoder.decode_by_id(id).map_err(|_| format!("entity #{id} does not exist"))
}

/// A non-blank IFC string attribute with its STEP escapes decoded.
pub(super) fn text(entity: &DecodedEntity, slot: usize) -> Option<String> {
    // `get_string` is already decoded; decoding again read an escaped backslash
    // as the escape it spells (CORE-16).
    let value = entity.get_string(slot)?.trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn project_length_metres(project: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<f64, String> {
    let assignment = project.get_ref(8).ok_or("IfcProject has no UnitsInContext; the exporter will not assume metres")?;
    let assignment = decode(decoder, assignment)?;
    let mut length_units = Vec::new();
    for id in assignment.get_refs(0).unwrap_or_default() {
        let unit = decode(decoder, id)?;
        if unit.get(1).and_then(AttributeValue::as_enum) == Some("LENGTHUNIT") {
            length_units.push(unit);
        }
    }
    match &length_units[..] {
        [unit] => length_unit_metres(unit),
        units => Err(format!("IfcProject.UnitsInContext defines {} length units; exactly one is required", units.len())),
    }
}

/// Metres per one `unit`, refusing anything that is not a known length unit.
fn length_unit_metres(unit: &DecodedEntity) -> Result<f64, String> {
    if unit.get(1).and_then(AttributeValue::as_enum) != Some("LENGTHUNIT") {
        return Err(format!("unit #{} is not a LENGTHUNIT", unit.id));
    }
    let metres = match unit.ifc_type {
        IfcType::IfcSIUnit if unit.get(3).and_then(AttributeValue::as_enum) == Some("METRE") => {
            match unit.get(2).filter(|prefix| !prefix.is_null()) {
                None => Some(1.0),
                Some(prefix) => prefix.as_enum().and_then(try_si_prefix_multiplier),
            }
        }
        IfcType::IfcConversionBasedUnit => text(unit, 2).as_deref().and_then(get_conversion_based_unit_factor),
        _ => None,
    };
    metres.filter(|metres: &f64| metres.is_finite() && *metres > 0.0)
        .ok_or_else(|| format!("length unit #{} ({}) is not one the exporter can convert to metres exactly", unit.id, unit.ifc_type.name()))
}

#[cfg(test)]
mod decode_once_tests {
    use super::*;

    /// CORE-16 (F4 M-export-b): `get_string` is already decoded, and `text`
    /// decoded it again, so a name spelling an escape (`\\` is one backslash)
    /// came back as the escaped character.
    #[test]
    fn text_is_decoded_once() {
        let content = br"#1=IFCPROJECT('g',$,'C:\\X2\\00E9\\X0\\ \X2\00FC\X0\',$,$,$,$,$,$);";
        let mut decoder = EntityDecoder::new(&content[..]);
        let project = decoder.decode_by_id(1).unwrap();
        assert_eq!(text(&project, 2).as_deref(), Some("C:\\X2\\00E9\\X0\\ \u{fc}"));
    }
}
