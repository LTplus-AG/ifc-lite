// SPDX-License-Identifier: MPL-2.0
//! IFC terrain → LandXML 1.2 surface export (#7600).
//!
//! A terrain-TIN producer, not a generic geometry converter: each selected
//! `IfcGeographicElement` (or `IfcSite`) whose body is one
//! `IfcTriangulatedFaceSet` becomes one `<Surface>`, its `CoordIndex` copied to
//! `<Faces>` without re-triangulation. Coordinates are the product placement
//! composed with the representation context's `IfcMapConversion`, written as
//! LandXML's `N E Z` in metres. Missing or ambiguous georeferencing refuses
//! the export instead of guessing a CRS, a unit or a scale; the contract
//! follows openBIM-surveyor's `IFC_TERRAIN_TO_LANDXML.md`.

#[cfg(test)]
#[path = "landxml_terrain_tests.rs"]
mod tests;

#[path = "landxml_terrain_georef.rs"]
mod georef;
#[path = "landxml_terrain_tin.rs"]
mod tin;

use std::collections::HashSet;
use std::fmt::{self, Write as _};

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::GeometryRouter;
use serde::Serialize;

use crate::xml_text::escape;

const LANDXML_NAMESPACE: &str = "http://www.landxml.org/schema/LandXML-1.2";

/// Header values the caller owns: the wasm build has no clock of its own, and
/// a fixed stamp keeps tests byte-stable.
#[derive(Debug, Clone)]
pub struct LandXmlTerrainOptions {
    /// `YYYY-MM-DD`, the required `LandXML@date`.
    pub date: String,
    /// `HH:MM:SS`, the required `LandXML@time`.
    pub time: String,
}

/// One written `<Surface>`, for the caller to report.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LandXmlTerrainSurface {
    pub product_id: u32,
    pub global_id: Option<String>,
    pub name: String,
    pub points: usize,
    pub faces: usize,
}

/// The LandXML document plus what it contains.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LandXmlTerrainExport {
    pub xml: String,
    pub crs_name: String,
    pub surfaces: Vec<LandXmlTerrainSurface>,
}

/// The selection is not an authored triangulated terrain, or its
/// georeferencing (map conversion, CRS, units) is missing or ambiguous. The
/// reason names the product or attribute, so a caller can show it verbatim.
///
/// Its own type rather than an [`crate::ExportError`] variant: that enum is
/// exhaustive, so a new variant would be a breaking change for every `match`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LandXmlTerrainRefusal {
    pub reason: String,
}

impl LandXmlTerrainRefusal {
    /// Stable machine-readable code, the prefix of the `Display` text that
    /// crosses the wasm boundary (`@ifc-lite/geometry`'s `TERRAIN_REFUSED`).
    pub const CODE: &'static str = "TERRAIN_REFUSED";
}

impl fmt::Display for LandXmlTerrainRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", Self::CODE, self.reason)
    }
}

impl std::error::Error for LandXmlTerrainRefusal {}

/// Export the selected terrain products of `content` (IFC STEP bytes) as one
/// LandXML 1.2 document, one `<Surface>` per product in selection order.
///
/// Fails closed with a [`LandXmlTerrainRefusal`] naming the first product or
/// attribute that does not meet the contract; nothing partial is returned.
pub fn try_export_landxml_terrain(
    content: &[u8],
    product_ids: &[u32],
    options: &LandXmlTerrainOptions,
) -> Result<LandXmlTerrainExport, LandXmlTerrainRefusal> {
    export(content, product_ids, options).map_err(|reason| LandXmlTerrainRefusal { reason })
}

fn export(content: &[u8], product_ids: &[u32], options: &LandXmlTerrainOptions) -> Result<LandXmlTerrainExport, String> {
    check_stamp(&options.date, "YYYY-MM-DD", b'-')?;
    check_stamp(&options.time, "HH:MM:SS", b':')?;
    let mut seen = HashSet::new();
    let ids: Vec<u32> = product_ids.iter().copied().filter(|id| seen.insert(*id)).collect();
    if ids.is_empty() {
        return Err("no terrain is selected".into());
    }
    let mut decoder = EntityDecoder::new(content);
    let facts = georef::ModelFacts::scan(content, &mut decoder)?;
    // The default router keeps placements in project units, which is what
    // `IfcMapConversion` consumes.
    let router = GeometryRouter::new();
    let mut validated = HashSet::new();
    let terrains = ids.iter()
        .map(|id| tin::read_terrain(*id, &facts, &router, &mut validated, &mut decoder))
        .collect::<Result<Vec<_>, _>>()?;
    let crs = terrains[0].crs.clone();
    if let Some(other) = terrains.iter().find(|terrain| terrain.crs != crs) {
        return Err(format!("#{} is in {} while #{} is in {}; one LandXML file carries one coordinate system", other.product_id, other.crs.name, terrains[0].product_id, crs.name));
    }

    let names = unique_names(terrains.iter().map(|terrain| terrain.name.as_str()));
    let mut xml = String::new();
    let _ = write!(xml, "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<LandXML xmlns=\"{LANDXML_NAMESPACE}\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xsi:schemaLocation=\"{LANDXML_NAMESPACE} {LANDXML_NAMESPACE}/LandXML-1.2.xsd\" version=\"1.2\" date=\"{}\" time=\"{}\">\n", options.date, options.time);
    xml.push_str("  <Units>\n    <Metric linearUnit=\"meter\" areaUnit=\"squareMeter\" volumeUnit=\"cubicMeter\" temperatureUnit=\"celsius\" pressureUnit=\"milliBars\" angularUnit=\"decimal degrees\" directionUnit=\"decimal degrees\" elevationUnit=\"meter\"/>\n  </Units>\n");
    let _ = write!(xml, "  <CoordinateSystem name=\"{}\"", escape(&crs.name));
    if let Some(code) = crs.name.strip_prefix("EPSG:").filter(|code| !code.is_empty() && code.bytes().all(|b| b.is_ascii_digit())) {
        let _ = write!(xml, " epsgCode=\"{code}\"");
    }
    for (attribute, value) in [("horizontalDatum", &crs.geodetic_datum), ("verticalDatum", &crs.vertical_datum)] {
        if let Some(value) = value {
            let _ = write!(xml, " {attribute}=\"{}\"", escape(value));
        }
    }
    xml.push_str("/>\n");
    let project = facts.project_name.as_deref().unwrap_or("IFC terrain");
    let _ = writeln!(xml, "  <Project name=\"{}\"/>", escape(project));
    let _ = writeln!(xml, "  <Application name=\"ifc-lite\" manufacturer=\"ifc-lite\" version=\"{}\"/>", env!("CARGO_PKG_VERSION"));
    xml.push_str("  <Surfaces>\n");
    for (terrain, name) in terrains.iter().zip(&names) {
        write_surface(&mut xml, terrain, name);
    }
    xml.push_str("  </Surfaces>\n</LandXML>\n");

    let surfaces = terrains.iter().zip(names).map(|(terrain, name)| LandXmlTerrainSurface {
        product_id: terrain.product_id,
        global_id: terrain.global_id.clone(),
        name,
        points: terrain.points.len(),
        faces: terrain.faces.len(),
    }).collect();
    Ok(LandXmlTerrainExport { xml, crs_name: crs.name, surfaces })
}

fn write_surface(xml: &mut String, terrain: &tin::Terrain, name: &str) {
    let _ = write!(xml, "    <Surface name=\"{}\"", escape(name));
    if let Some(global_id) = &terrain.global_id {
        let _ = write!(xml, " OID=\"{}\"", escape(global_id));
    }
    let (min, max) = terrain.points.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(min, max), point| (min.min(point[2]), max.max(point[2])));
    let _ = write!(xml, ">\n      <Definition surfType=\"TIN\" elevMax=\"{}\" elevMin=\"{}\">\n        <Pnts>\n", number(max), number(min));
    for (index, [n, e, z]) in terrain.points.iter().enumerate() {
        let _ = writeln!(xml, "          <P id=\"{}\">{} {} {}</P>", index + 1, number(*n), number(*e), number(*z));
    }
    xml.push_str("        </Pnts>\n        <Faces>\n");
    for [a, b, c] in &terrain.faces {
        let _ = writeln!(xml, "          <F>{a} {b} {c}</F>");
    }
    xml.push_str("        </Faces>\n      </Definition>\n    </Surface>\n");
}

/// Metres to six decimals, trailing zeros trimmed: a micrometre, three orders
/// below survey precision. Composing placement and map offsets in `f64` leaves
/// noise such as `5516087.398800001` (#844's terrain); a fixed resolution
/// drops it without touching an authored digit. Never an exponent, never `-0`.
fn number(value: f64) -> String {
    let text = format!("{value:.6}");
    match text.trim_end_matches('0').trim_end_matches('.') {
        "-0" => "0".into(),
        trimmed => trimmed.into(),
    }
}

/// `Surface@name` is unique within `<Surfaces>` (XSD `uSrfName`); a repeated
/// product name gets a ` (2)`, ` (3)` … suffix.
fn unique_names<'a>(names: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut taken = HashSet::new();
    let mut out = Vec::new();
    for name in names {
        let mut candidate = name.to_string();
        let mut suffix = 2;
        while !taken.insert(candidate.clone()) {
            candidate = format!("{name} ({suffix})");
            suffix += 1;
        }
        out.push(candidate);
    }
    out
}

fn check_stamp(value: &str, shape: &str, separator: u8) -> Result<(), String> {
    let ok = value.len() == shape.len()
        && value.bytes().zip(shape.bytes()).all(|(byte, slot)| if slot == separator { byte == separator } else { byte.is_ascii_digit() });
    if ok { Ok(()) } else { Err(format!("header stamp {value:?} is not {shape}")) }
}
