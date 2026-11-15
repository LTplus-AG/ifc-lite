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
    let frame = facts.frame(context, &mut decoder)?;
    let epsg = epsg_code(&frame.crs.name).ok_or_else(|| {
        format!("the target IfcProjectedCRS is named '{}', which is not an EPSG code (EPSG:<code>)", frame.crs.name)
    })?;
    if frame.crs.name.contains('+') {
        warnings.push(format!(
            "the target CRS '{}' is compound; referenceSystem names its horizontal part EPSG:{epsg}, heights are as authored",
            frame.crs.name
        ));
    }
    let out_per_map = if frame.map_unit_si() {
        frame.map_metres()
    } else {
        warnings.push(format!(
            "the map unit of EPSG:{epsg} is not a metre; coordinates are written in that map unit, taken to be the CRS axis unit"
        ));
        1.0
    };
    Ok(OutputFrame::Map { project_metres: facts.project_metres(), out_per_map, epsg, frame: Box::new(frame) })
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
        if kind.eq_ignore_ascii_case("Model") {
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
/// compound `EPSG:2056+5728` the horizontal code is returned.
pub(super) fn epsg_code(name: &str) -> Option<u32> {
    let s = name.trim();
    let lower = s.to_ascii_lowercase();
    let tail = if let Some(rest) = lower.strip_prefix("epsg:") {
        rest.trim_start()
    } else if let Some(at) = lower.find("crs:epsg:") {
        &lower[at + "crs:epsg:".len()..]
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
