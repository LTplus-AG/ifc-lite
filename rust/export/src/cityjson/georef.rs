// SPDX-License-Identifier: MPL-2.0
//! The coordinate frame a CityJSON export is written in.
//!
//! Georeferenced output needs three things the model has to state, none of
//! which is guessed: one `IfcMapConversion` from the model's 3D context, a
//! target `IfcProjectedCRS` whose `Name` is an EPSG code, and length units
//! the conversion can be applied in exactly. The map conversion is resolved
//! by the same code the LandXML terrain export uses
//! (`landxml_terrain::georef::ModelFacts::frame`, which applies
//! `GeoReference::local_to_map` after the map-normalization preflight), so
//! the eastings, northings, orthogonal height, rotation, scale and IFC4X3
//! per-axis factors are applied by the one arithmetic the viewer and server
//! georeference with. Anything missing or ambiguous leaves the export in
//! local IFC coordinates without a `referenceSystem`, and says why.

use ifc_lite_core::{keyword_eq, slot, EntityDecoder, EntityScanner};

use crate::landxml_terrain::georef::{MapFrame, ModelFacts};

/// Where output coordinates come from.
pub(super) enum OutputFrame {
    /// IFC world coordinates in metres, Z up. No CRS is claimed.
    Local,
    /// Map coordinates of a projected CRS.
    Map {
        frame: Box<MapFrame>,
        /// Metres per project length unit: mesh metres back to the local
        /// coordinates the map conversion is defined on.
        project_metres: f64,
        /// Output units per map unit: `map_metres` when the map unit is a
        /// metre (written in metres, the unit of metric EPSG CRSs), else 1
        /// (written in the map unit itself).
        out_per_map: f64,
        epsg: u32,
    },
}

impl OutputFrame {
    /// An IFC world point (metres, Z up) in output coordinates.
    pub(super) fn apply(&self, p: [f64; 3]) -> [f64; 3] {
        match self {
            Self::Local => p,
            Self::Map { frame, project_metres, out_per_map, .. } => {
                let [e, n, h] = frame.to_map(p[0] / project_metres, p[1] / project_metres, p[2] / project_metres);
                [e * out_per_map, n * out_per_map, h * out_per_map]
            }
        }
    }

    /// A vertical length of `metres` IFC metres as a length in output units:
    /// the height difference it makes through [`Self::apply`], so a storey
    /// `Elevation` goes through the same unit conversion, map scale and
    /// IFC4X3 `FactorZ` as the coordinates and `measuredHeight`.
    /// Rounded to a nanounit: the difference of two map heights carries
    /// float noise far below any length IFC states.
    pub(super) fn vertical_length(&self, metres: f64) -> f64 {
        let d = self.apply([0.0, 0.0, metres])[2] - self.apply([0.0, 0.0, 0.0])[2];
        (d * 1e9).round() / 1e9
    }

    /// `metadata.referenceSystem`, when a CRS is claimed.
    pub(super) fn reference_system(&self) -> Option<String> {
        match self {
            Self::Local => None,
            Self::Map { epsg, .. } => Some(format!("https://www.opengis.net/def/crs/EPSG/0/{epsg}")),
        }
    }
}

/// Resolve the output frame, appending the reason to `warnings` whenever the
/// export falls back to local coordinates or makes an assumption.
pub(super) fn resolve(content: &[u8], warnings: &mut Vec<String>) -> OutputFrame {
    match try_resolve(content, warnings) {
        Ok(frame) => frame,
        Err(reason) => {
            warnings.push(format!(
                "not georeferenced: {reason}. Coordinates are local IFC world coordinates in metres and metadata.referenceSystem is omitted"
            ));
            OutputFrame::Local
        }
    }
}

fn try_resolve(content: &[u8], warnings: &mut Vec<String>) -> Result<OutputFrame, String> {
    let mut decoder = EntityDecoder::new(content);
    let facts = ModelFacts::scan(content, &mut decoder)?;
    if facts.conversion_sources().next().is_none() {
        return Err("the model has no IfcMapConversion".to_string());
    }
    let context = model_context(content, &mut decoder)?;
    let frame = facts.frame(context, &mut decoder).map_err(|reason| explain_scale(reason, &facts, context, &mut decoder))?;
    let epsg = epsg_code(&frame.crs.name).ok_or_else(|| {
        format!("the target IfcProjectedCRS is named '{}', which is not an EPSG code (EPSG:<code>)", frame.crs.name)
    })?;
    if frame.crs.name.contains('+') {
        warnings.push(format!(
            "the target CRS '{}' is compound; referenceSystem names its horizontal part EPSG:{epsg}, heights are as authored",
            frame.crs.name
        ));
    }
    let out_per_map = if is_metric(frame.map_metres()) {
        frame.map_metres()
    } else {
        warnings.push(format!(
            "the map unit of EPSG:{epsg} is not a metre; coordinates are written in that map unit, taken to be the CRS axis unit"
        ));
        1.0
    };
    Ok(OutputFrame::Map { project_metres: facts.project_metres(), out_per_map, epsg, frame: Box::new(frame) })
}

/// The resolver's omitted-Scale refusal, with the units named and the value to
/// set: a millimetre project with a metre map unit and no `Scale` is the most
/// common authoring error. Composed here from the same facts so the shared
/// LandXML resolver (linked into the default engine) keeps its short message;
/// the Scale is still never applied.
fn explain_scale(reason: String, facts: &ModelFacts, context: u32, decoder: &mut EntityDecoder) -> String {
    // The resolver's wording (pinned by the LandXML terrain tests).
    if !reason.contains("omits Scale") {
        return reason;
    }
    let Some(map_metres) = facts.map_unit_metres(context, decoder) else { return reason };
    let project_metres = facts.project_metres();
    format!(
        "{reason}. The project length unit ({}) and the map unit ({}) differ: if the map conversion is otherwise right, \
         set IfcMapConversion.Scale to {} (map units per project unit)",
        unit_label(project_metres),
        unit_label(map_metres),
        format_ratio(project_metres / map_metres),
    )
}

/// Whether a length unit of `metres` is a (prefixed) metre: a power of ten.
/// No conversion-based length unit IFC readers recognise (foot, inch, yard,
/// mile, US survey foot) is one, so this is the SI test for a map unit.
fn is_metric(metres: f64) -> bool {
    let l = metres.log10();
    l.is_finite() && (l - l.round()).abs() < 1e-9
}

/// A length unit for a message: its name when it is a common one, else its
/// size in metres.
fn unit_label(metres: f64) -> String {
    let named = [(1.0, "metre"), (0.001, "millimetre"), (0.01, "centimetre"), (0.1, "decimetre"), (1000.0, "kilometre"), (0.3048, "foot"), (0.0254, "inch"), (1200.0 / 3937.0, "US survey foot")];
    named.iter().find(|(m, _)| (m - metres).abs() <= 1e-12 * metres).map_or_else(|| format!("{metres} m"), |(_, name)| format!("{name}, {metres} m"))
}

/// A unit ratio without float noise (0.001, not 0.0010000000000000002).
fn format_ratio(ratio: f64) -> String {
    let s = format!("{ratio:.12}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "0" { format!("{ratio:e}") } else { s.to_string() }
}

/// The one 3D `IfcGeometricRepresentationContext` of type `Model`, whose
/// world coordinate system the meshes are expressed in.
fn model_context(content: &[u8], decoder: &mut EntityDecoder) -> Result<u32, String> {
    let mut scanner = EntityScanner::new(content);
    let mut found = Vec::new();
    while let Some((id, name, start, end)) = scanner.next_entity() {
        if !keyword_eq(name, "IFCGEOMETRICREPRESENTATIONCONTEXT") {
            continue;
        }
        let Ok(ctx) = decoder.decode_at_with_id(id, start, end) else { continue };
        let kind = ctx.string_at(slot::IfcGeometricRepresentationContext::CONTEXT_TYPE).unwrap_or_default();
        // A 2D 'Model' context beside the 3D one is not a candidate: the
        // meshes, and the map conversion the export applies, are 3D.
        let three_d = ctx.int_at(slot::IfcGeometricRepresentationContext::COORDINATE_SPACE_DIMENSION) == Some(3);
        if kind.eq_ignore_ascii_case("Model") && three_d {
            found.push(id);
        }
    }
    match found[..] {
        [only] => Ok(only),
        [] => Err("the model has no 3D IfcGeometricRepresentationContext of type 'Model'".to_string()),
        _ => Err(format!("the model has {} 'Model' representation contexts; the georeferenced one is ambiguous", found.len())),
    }
}

/// The EPSG code a CRS name spells: `EPSG:2056`, `EPSG: 2056`, an OGC URN
/// (`urn:ogc:def:crs:EPSG::2056`) or URL (`…/def/crs/EPSG/0/2056`). For a
/// compound `EPSG:2056+5728` the horizontal code is returned. The URN's
/// version segment, empty or not, is skipped.
pub(super) fn epsg_code(name: &str) -> Option<u32> {
    let s = name.trim();
    let lower = s.to_ascii_lowercase();
    let tail = if let Some(rest) = lower.strip_prefix("epsg:") {
        rest.trim_start()
    } else if let Some(at) = lower.find("crs:epsg:") {
        // `urn:ogc:def:crs:EPSG:<version>:<code>`: the version may be empty
        // (`EPSG::2056`) or given (`EPSG:0:2056`, `EPSG:9.9.1:2056`).
        let rest = &lower[at + "crs:epsg:".len()..];
        rest.rsplit_once(':').map_or(rest, |(_, code)| code)
    } else if let Some(at) = lower.find("/crs/epsg/") {
        let rest = &lower[at + "/crs/epsg/".len()..];
        rest.split_once('/').map(|(_, code)| code)?
    } else {
        return None;
    };
    let tail = tail.trim_start_matches(':');
    let digits: &str = tail.split(|c: char| !c.is_ascii_digit()).next()?;
    let rest = &tail[digits.len()..];
    if digits.is_empty() || !(rest.is_empty() || rest.starts_with('+')) {
        return None;
    }
    digits.parse().ok().filter(|code| *code > 0)
}
