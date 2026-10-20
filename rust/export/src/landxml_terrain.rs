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

use std::collections::{BTreeMap, HashSet};
use std::fmt::{self, Write as _};

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::GeometryRouter;
use serde::Serialize;

use crate::xml_text::escape;

const LANDXML_NAMESPACE: &str = "http://www.landxml.org/schema/LandXML-1.2";

/// The length unit the document is written in (#7618). Coordinates are
/// computed in metres and converted once, at write time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LandXmlLinearUnit {
    #[default]
    Metre,
    /// 0.3048 m exactly.
    InternationalFoot,
    /// 1200/3937 m exactly. LandXML 1.2's `elevationType` has no US survey
    /// foot, so elevations are then written in international feet, declared
    /// as `elevationUnit="feet"`: both units are explicit and exact.
    UsSurveyFoot,
}

impl LandXmlLinearUnit {
    /// Metres per horizontal unit.
    fn horizontal_metres(self) -> f64 {
        match self {
            Self::Metre => 1.0,
            Self::InternationalFoot => 0.3048,
            Self::UsSurveyFoot => ifc_lite_core::US_SURVEY_FOOT_M,
        }
    }

    /// Metres per elevation unit (see [`Self::UsSurveyFoot`]).
    fn elevation_metres(self) -> f64 {
        match self {
            Self::Metre => 1.0,
            Self::InternationalFoot | Self::UsSurveyFoot => 0.3048,
        }
    }

    /// The `<Units>` child declaring this unit, with the XSD's other required
    /// attributes in the same system.
    fn units_element(self) -> &'static str {
        match self {
            Self::Metre => "<Metric linearUnit=\"meter\" areaUnit=\"squareMeter\" volumeUnit=\"cubicMeter\" temperatureUnit=\"celsius\" pressureUnit=\"milliBars\" angularUnit=\"decimal degrees\" directionUnit=\"decimal degrees\" elevationUnit=\"meter\"/>",
            Self::InternationalFoot => "<Imperial linearUnit=\"foot\" areaUnit=\"squareFoot\" volumeUnit=\"cubicFeet\" temperatureUnit=\"fahrenheit\" pressureUnit=\"inchHG\" angularUnit=\"decimal degrees\" directionUnit=\"decimal degrees\" elevationUnit=\"feet\"/>",
            Self::UsSurveyFoot => "<Imperial linearUnit=\"USSurveyFoot\" areaUnit=\"squareFoot\" volumeUnit=\"cubicFeet\" temperatureUnit=\"fahrenheit\" pressureUnit=\"inchHG\" angularUnit=\"decimal degrees\" directionUnit=\"decimal degrees\" elevationUnit=\"feet\"/>",
        }
    }
}

/// How the document is written. `#[non_exhaustive]`: build it with
/// [`LandXmlTerrainOptions::new`] and set the fields you need, so a later
/// option is not a breaking change.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct LandXmlTerrainOptions {
    /// `YYYY-MM-DD`, the required `LandXML@date`. The caller owns the clock:
    /// the wasm build has none, and a fixed stamp keeps tests byte-stable.
    pub date: String,
    /// `HH:MM:SS`, the required `LandXML@time`.
    pub time: String,
    /// Default metres.
    pub linear_unit: LandXmlLinearUnit,
    /// Decimal places in the written unit, 0 to 9. Default 6 (a micrometre in
    /// metres, far below survey precision); 3 is millimetres in metres. A
    /// precision that collapses a face onto a line or point is refused.
    pub decimals: u8,
    /// `Surface@name` per product express id. A blank or absent entry keeps
    /// the product's IFC name; duplicates are still made unique.
    pub surface_names: BTreeMap<u32, String>,
}

impl LandXmlTerrainOptions {
    pub fn new(date: impl Into<String>, time: impl Into<String>) -> Self {
        Self {
            date: date.into(),
            time: time.into(),
            linear_unit: LandXmlLinearUnit::default(),
            decimals: 6,
            surface_names: BTreeMap::new(),
        }
    }
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
    if options.decimals > 9 {
        return Err(format!("precision of {} decimals is outside 0 to 9", options.decimals));
    }
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
    let mut validator = ifc_lite_geometry::placement::ChainValidator::new(&mut decoder, crate::step_map_transform::preflight::CHAIN_POLICY);
    let terrains = ids.iter()
        .map(|id| tin::read_terrain(*id, &facts, &router, &mut validator))
        .collect::<Result<Vec<_>, _>>()?;
    let crs = terrains[0].crs.clone();
    if let Some(other) = terrains.iter().find(|terrain| terrain.crs != crs) {
        return Err(format!("#{} is in {} while #{} is in {}; one LandXML file carries one coordinate system", other.product_id, other.crs.name, terrains[0].product_id, crs.name));
    }

    let names = unique_names(terrains.iter().map(|terrain| {
        options.surface_names.get(&terrain.product_id).map(|name| name.trim())
            .filter(|name| !name.is_empty())
            .unwrap_or(terrain.name.as_str())
    }));
    let mut xml = String::new();
    let _ = write!(xml, "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<LandXML xmlns=\"{LANDXML_NAMESPACE}\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xsi:schemaLocation=\"{LANDXML_NAMESPACE} {LANDXML_NAMESPACE}/LandXML-1.2.xsd\" version=\"1.2\" date=\"{}\" time=\"{}\">\n", options.date, options.time);
    let _ = write!(xml, "  <Units>\n    {}\n  </Units>\n", options.linear_unit.units_element());
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
        write_surface(&mut xml, terrain, name, options)?;
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

fn write_surface(xml: &mut String, terrain: &tin::Terrain, name: &str, options: &LandXmlTerrainOptions) -> Result<(), String> {
    let (horizontal, vertical) = (options.linear_unit.horizontal_metres(), options.linear_unit.elevation_metres());
    let text = |value: f64, unit: f64| number(value / unit, options.decimals);
    // Each point as written, and that text read back in metres: the precision
    // must not collapse a face the source authored (checked again below).
    let written: Vec<[String; 3]> = terrain.points.iter()
        .map(|[n, e, z]| [text(*n, horizontal), text(*e, horizontal), text(*z, vertical)])
        .collect();
    let read_back = |point: &[String; 3]| -> [f64; 3] {
        let value = |text: &String| text.parse::<f64>().unwrap_or(f64::NAN);
        [value(&point[0]) * horizontal, value(&point[1]) * horizontal, value(&point[2]) * vertical]
    };
    for (number, face) in terrain.faces.iter().enumerate() {
        if degenerate(face.map(|index| read_back(&written[index - 1]))) {
            return Err(format!(
                "face {} of #{} collapses onto a line or point at {} decimal places; choose more decimal places",
                number + 1, terrain.product_id, options.decimals,
            ));
        }
    }
    let _ = write!(xml, "    <Surface name=\"{}\"", escape(name));
    if let Some(global_id) = &terrain.global_id {
        let _ = write!(xml, " OID=\"{}\"", escape(global_id));
    }
    let (min, max) = terrain.points.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(min, max), point| (min.min(point[2]), max.max(point[2])));
    let _ = write!(xml, ">\n      <Definition surfType=\"TIN\" elevMax=\"{}\" elevMin=\"{}\">\n        <Pnts>\n", text(max, vertical), text(min, vertical));
    for (index, [n, e, z]) in written.iter().enumerate() {
        let _ = writeln!(xml, "          <P id=\"{}\">{n} {e} {z}</P>", index + 1);
    }
    xml.push_str("        </Pnts>\n        <Faces>\n");
    for [a, b, c] in &terrain.faces {
        let _ = writeln!(xml, "          <F>{a} {b} {c}</F>");
    }
    xml.push_str("        </Faces>\n      </Definition>\n    </Surface>\n");
    Ok(())
}

/// A triangle with no area: its edge vectors' cross product is exactly zero.
/// Shared by the source check and the as-written check.
fn degenerate([a, b, c]: [[f64; 3]; 3]) -> bool {
    let (u, v) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
    let cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    cross.iter().all(|value| *value == 0.0)
}

/// `decimals` places, trailing zeros trimmed. The default six (a micrometre
/// in metres) is three orders below survey precision: composing placement and
/// map offsets in `f64` leaves noise such as `5516087.398800001` (#844's
/// terrain), and a fixed resolution drops it without touching an authored
/// digit. Never an exponent, never `-0`.
fn number(value: f64, decimals: u8) -> String {
    let text = format!("{value:.*}", usize::from(decimals));
    if !text.contains('.') {
        return if text == "-0" { "0".into() } else { text };
    }
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
