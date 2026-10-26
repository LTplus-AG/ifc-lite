// SPDX-License-Identifier: MPL-2.0
//! A new IFC4 file with nothing in it but its spatial root: the source a plan
//! of [`super::Disposition::Add`]s is executed against when there is no
//! existing file to add to.
//!
//! The file holds one `IfcProject` (SI units: metre, square metre, cubic
//! metre, radian), one 3D `Model` context with a `Body` subcontext, one
//! `IfcSite` and one `IfcBuilding` aggregated under it, and, when asked, the
//! map conversion that places the project's engineering frame in a projected
//! CRS. No owner history is written: IFC4 does not require one, and the
//! executor synthesizes its own for the records a plan adds.
//!
//! Every GlobalId is the caller's, and nothing reads a clock, so the same
//! [`Skeleton`] always produces the same bytes.

use crate::step_ids::IdAllocator;
use crate::step_text::quoted;

use super::add_types::GlobalId;
use super::identity::{Identity, Made};
use super::types::{ExportingApplication, ValidationFinding};
use super::placement::fmt;
use super::props_synth::ref_list;
use super::tessellation::Emit;

/// The schema a skeleton is written in.
pub const SKELETON_SCHEMA: &str = "IFC4";

/// One spatial root: its GlobalId and optional name.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct SkeletonRoot {
    pub global_id: GlobalId,
    pub name: Option<String>,
}

/// The length unit of a projected CRS's map coordinates.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum MapUnit {
    #[default]
    Metre,
    /// The international foot, 0.3048 m.
    Foot,
    /// The US survey foot, 1200/3937 m.
    UsSurveyFoot,
}

/// An `IfcMapConversion` to an `IfcProjectedCRS`: how the project's
/// engineering frame (metres) maps to map coordinates.
///
/// `x_axis_abscissa` and `x_axis_ordinate` are the direction of the
/// engineering frame's X axis in map coordinates; together they carry the
/// rotation between grid north and the project's Y axis. They need not be
/// normalised, but cannot both be zero.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct MapConversion {
    /// `IfcProjectedCRS.Name`, for example `EPSG:2056`.
    pub crs_name: String,
    /// The unit `eastings`, `northings` and `orthogonal_height` are in,
    /// written as the CRS's `MapUnit`. Without one IFC reads map coordinates
    /// in the project's length unit (metre), which is wrong for a feet-based
    /// CRS such as a US State Plane zone.
    pub map_unit: MapUnit,
    pub eastings: f64,
    pub northings: f64,
    pub orthogonal_height: f64,
    pub x_axis_abscissa: f64,
    pub x_axis_ordinate: f64,
    /// `None` writes `$`, which IFC4 reads as 1.
    pub scale: Option<f64>,
}

/// What [`skeleton`] writes.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct Skeleton {
    pub project: SkeletonRoot,
    pub site: SkeletonRoot,
    pub building: SkeletonRoot,
    /// Direction of true north in the project's XY plane, written as the
    /// model context's `TrueNorth`. `None` leaves it unset, which IFC reads
    /// as +Y.
    pub true_north: Option<[f64; 2]>,
    pub map_conversion: Option<MapConversion>,
    /// The application writing the file. Present, it owns the project, site,
    /// building and their aggregations (`ADDED`) and the header names it, the
    /// same way [`super::PlanContext::application`] does for a plan.
    pub application: Option<ExportingApplication>,
    /// The header's `FILE_NAME` name. `None` writes an empty one.
    pub file_name: Option<String>,
}

/// An `IfcConversionBasedUnit` length unit of `metres` metres.
fn length_unit(emit: &mut Emit, name: &str, metres: f64, metre: u32) -> Result<u32, String> {
    let dimensions = emit.record(
        "IFCDIMENSIONALEXPONENTS",
        &[
            ("LengthExponent", "1".into()),
            ("MassExponent", "0".into()),
            ("TimeExponent", "0".into()),
            ("ElectricCurrentExponent", "0".into()),
            ("ThermodynamicTemperatureExponent", "0".into()),
            ("AmountOfSubstanceExponent", "0".into()),
            ("LuminousIntensityExponent", "0".into()),
        ],
    )?;
    let factor = emit.record(
        "IFCMEASUREWITHUNIT",
        &[("ValueComponent", format!("IFCLENGTHMEASURE({})", fmt(metres))), ("UnitComponent", format!("#{metre}"))],
    )?;
    emit.record(
        "IFCCONVERSIONBASEDUNIT",
        &[
            ("Dimensions", format!("#{dimensions}")),
            ("UnitType", ".LENGTHUNIT.".into()),
            ("Name", format!("'{name}'")),
            ("ConversionFactor", format!("#{factor}")),
        ],
    )
}

/// The skeleton's bytes. A header that doesn't follow buildingSMART's
/// agreement is not reported here; [`skeleton_with_findings`] reports it.
///
/// # Errors
/// A number is not finite, a direction is zero length, the three roots do
/// not have distinct GlobalIds, `crs_name` is empty, or an
/// [`ExportingApplication`] is given whose change time cannot be attributed.
pub fn skeleton(s: &Skeleton) -> Result<Vec<u8>, String> {
    build(s, true).map(|(bytes, _)| bytes)
}

/// [`skeleton`], reporting rather than refusing an application it cannot
/// attribute the skeleton to: the skeleton is then written unattributed, and
/// a finding says why. A header that doesn't follow buildingSMART's
/// agreement is a finding too.
///
/// # Errors
/// As [`skeleton`], but for the application.
pub fn skeleton_with_findings(s: &Skeleton) -> Result<(Vec<u8>, Vec<ValidationFinding>), String> {
    build(s, false)
}

/// The skeleton and its findings, for both entry points.
fn build(s: &Skeleton, strict: bool) -> Result<(Vec<u8>, Vec<ValidationFinding>), String> {
    check(s)?;
    let mut findings = Vec::new();
    let mut ids = IdAllocator::after(0);
    let mut out = Vec::new();
    let mut emit = Emit {
        schema: SKELETON_SCHEMA,
        ids: &mut ids,
        out: &mut out,
    };
    // The exporting application owns what the skeleton creates.
    let identity = identity_of(s, strict, &mut findings)?;
    let history = owner_slot(identity.as_ref(), &mut emit)?;
    let name = |root: &SkeletonRoot| root.name.as_deref().map_or("$".to_string(), quoted);
    let gid = |root: &SkeletonRoot| format!("'{}'", root.global_id.encode());

    let si = |emit: &mut Emit, unit: &str, name: &str| {
        emit.record(
            "IFCSIUNIT",
            &[
                // Derived in IfcSIUnit, so written `*`.
                ("Dimensions", "*".into()),
                ("UnitType", format!(".{unit}.")),
                ("Name", format!(".{name}.")),
            ],
        )
    };
    let units = [
        si(&mut emit, "LENGTHUNIT", "METRE")?,
        si(&mut emit, "AREAUNIT", "SQUARE_METRE")?,
        si(&mut emit, "VOLUMEUNIT", "CUBIC_METRE")?,
        si(&mut emit, "PLANEANGLEUNIT", "RADIAN")?,
    ];
    let unit_assignment = emit.record("IFCUNITASSIGNMENT", &[("Units", ref_list(&units))])?;

    let wcs = emit.identity_placement()?;
    let mut context_fields = vec![
        ("ContextType", "'Model'".to_string()),
        ("CoordinateSpaceDimension", "3".into()),
        ("Precision", "1.E-05".into()),
        ("WorldCoordinateSystem", format!("#{wcs}")),
    ];
    if let Some([x, y]) = s.true_north {
        let north = emit.record(
            "IFCDIRECTION",
            &[("DirectionRatios", format!("({},{})", fmt(x), fmt(y)))],
        )?;
        context_fields.push(("TrueNorth", format!("#{north}")));
    }
    let context = emit.record("IFCGEOMETRICREPRESENTATIONCONTEXT", &context_fields)?;
    emit.record(
        "IFCGEOMETRICREPRESENTATIONSUBCONTEXT",
        &[
            ("ContextIdentifier", "'Body'".into()),
            ("ContextType", "'Model'".into()),
            // Derived from the parent context in a subcontext.
            ("CoordinateSpaceDimension", "*".into()),
            ("Precision", "*".into()),
            ("WorldCoordinateSystem", "*".into()),
            ("TrueNorth", "*".into()),
            ("ParentContext", format!("#{context}")),
            ("TargetView", ".MODEL_VIEW.".into()),
        ],
    )?;
    if let Some(m) = &s.map_conversion {
        map_conversion(m, context, units[0], &mut emit)?;
    }

    let project = emit.record(
        "IFCPROJECT",
        &[
            ("GlobalId", gid(&s.project)),
            ("OwnerHistory", history.clone()),
            ("Name", name(&s.project)),
            ("RepresentationContexts", format!("(#{context})")),
            ("UnitsInContext", format!("#{unit_assignment}")),
        ],
    )?;

    let site_a2p = emit.identity_placement()?;
    let site_placement = emit.record(
        "IFCLOCALPLACEMENT",
        &[("RelativePlacement", format!("#{site_a2p}"))],
    )?;
    let site = emit.record(
        "IFCSITE",
        &[
            ("GlobalId", gid(&s.site)),
            ("OwnerHistory", history.clone()),
            ("Name", name(&s.site)),
            ("ObjectPlacement", format!("#{site_placement}")),
            ("CompositionType", ".ELEMENT.".into()),
        ],
    )?;
    let building_a2p = emit.identity_placement()?;
    let building_placement = emit.record(
        "IFCLOCALPLACEMENT",
        &[
            ("PlacementRelTo", format!("#{site_placement}")),
            ("RelativePlacement", format!("#{building_a2p}")),
        ],
    )?;
    let building = emit.record(
        "IFCBUILDING",
        &[
            ("GlobalId", gid(&s.building)),
            ("OwnerHistory", history.clone()),
            ("Name", name(&s.building)),
            ("ObjectPlacement", format!("#{building_placement}")),
            ("CompositionType", ".ELEMENT.".into()),
        ],
    )?;
    for (relating, related, root) in [(project, site, &s.site), (site, building, &s.building)] {
        emit.record(
            "IFCRELAGGREGATES",
            &[
                (
                    "GlobalId",
                    format!("'{}'", root.global_id.derive("rel/aggregates").encode()),
                ),
                ("OwnerHistory", history.clone()),
                ("RelatingObject", format!("#{relating}")),
                ("RelatedObjects", format!("(#{related})")),
            ],
        )?;
    }

    Ok((step_text(s.file_name.as_deref(), identity.as_ref(), &out)?, findings))
}

/// The map conversion from the model `context` to its projected CRS, with
/// the CRS's length unit (`metre` when it is metres).
fn map_conversion(m: &MapConversion, context: u32, metre: u32, emit: &mut Emit) -> Result<(), String> {
    let map_unit = match m.map_unit {
        MapUnit::Metre => metre,
        MapUnit::Foot => length_unit(emit, "FOOT", 0.3048, metre)?,
        MapUnit::UsSurveyFoot => length_unit(emit, "US SURVEY FOOT", ifc_lite_core::US_SURVEY_FOOT_M, metre)?,
    };
    let crs = emit.record("IFCPROJECTEDCRS", &[("Name", quoted(&m.crs_name)), ("MapUnit", format!("#{map_unit}"))])?;
    emit.record(
        "IFCMAPCONVERSION",
        &[
            ("SourceCRS", format!("#{context}")),
            ("TargetCRS", format!("#{crs}")),
            ("Eastings", fmt(m.eastings)),
            ("Northings", fmt(m.northings)),
            ("OrthogonalHeight", fmt(m.orthogonal_height)),
            ("XAxisAbscissa", fmt(m.x_axis_abscissa)),
            ("XAxisOrdinate", fmt(m.x_axis_ordinate)),
            ("Scale", m.scale.map_or("$".to_string(), fmt)),
        ],
    )?;
    Ok(())
}

/// The skeleton's exporting identity. An application whose change time
/// can't be attributed refuses when `strict`; otherwise it is a finding and
/// the skeleton is written unattributed.
fn identity_of(s: &Skeleton, strict: bool, findings: &mut Vec<ValidationFinding>) -> Result<Option<Identity>, String> {
    match s.application.as_ref().map(|app| Identity::resolve(app, findings)).transpose() {
        Err(message) if strict => Err(message),
        Err(message) => {
            findings.push(ValidationFinding::new(None, message));
            Ok(None)
        }
        Ok(identity) => Ok(identity),
    }
}

/// The `OwnerHistory` slot of everything the skeleton creates: the
/// exporting application's `ADDED` history, written first, else unset.
fn owner_slot(identity: Option<&Identity>, emit: &mut Emit) -> Result<String, String> {
    let Some(identity) = identity else { return Ok("$".to_string()) };
    let id = identity.added_in(SKELETON_SCHEMA, emit.ids, None, &mut Made::default(), emit.out).ok_or("id space exhausted")?;
    Ok(format!("#{id}"))
}

/// The file: the header (naming the application, toolkit and change time
/// when there is an application, empty fields otherwise), then the records.
fn step_text(file_name: Option<&str>, identity: Option<&Identity>, out: &[(u32, String)]) -> Result<Vec<u8>, String> {
    // Without an application every field is empty, as the skeleton always
    // wrote it.
    let empty = || Some(String::new());
    let mut opts = crate::StepOptions {
        description: empty(),
        filename: Some(file_name.unwrap_or("").to_string()),
        time_stamp: empty(),
        application: empty(),
        ..Default::default()
    };
    let originating = identity.map(|identity| identity.stamp_header(&mut opts));
    let mut text = Vec::new();
    crate::step_header::write_header_originating(&mut text, &opts, None, SKELETON_SCHEMA, originating.as_deref()).map_err(|e| e.to_string())?;
    for (_, record) in out {
        text.extend_from_slice(record.as_bytes());
        text.push(b'\n');
    }
    text.extend_from_slice(b"ENDSEC;\nEND-ISO-10303-21;\n");
    Ok(text)
}

fn check(s: &Skeleton) -> Result<(), String> {
    let ids = [s.project.global_id, s.site.global_id, s.building.global_id];
    if ids[0] == ids[1] || ids[1] == ids[2] || ids[0] == ids[2] {
        return Err("the project, site and building need distinct GlobalIds".into());
    }
    if let Some(north) = s.true_north {
        check_direction(north, "true north")?;
    }
    if let Some(m) = &s.map_conversion {
        if m.crs_name.trim().is_empty() {
            return Err("a map conversion needs a CRS name".into());
        }
        let values = [
            m.eastings,
            m.northings,
            m.orthogonal_height,
            m.scale.unwrap_or(1.0),
        ];
        if values.iter().any(|v| !v.is_finite()) {
            return Err("a map conversion value is not finite".into());
        }
        if m.scale.is_some_and(|v| v <= 0.0) {
            return Err("a map conversion scale must be positive".into());
        }
        check_direction(
            [m.x_axis_abscissa, m.x_axis_ordinate],
            "the map conversion's X axis",
        )?;
    }
    Ok(())
}

fn check_direction([x, y]: [f64; 2], what: &str) -> Result<(), String> {
    // `!(.. > ..)` also refuses a NaN.
    if !(x.is_finite() && y.is_finite() && x.hypot(y) > 1e-12) {
        return Err(format!("{what} is not a direction"));
    }
    Ok(())
}

#[cfg(test)]
#[path = "skeleton_tests.rs"]
mod tests;
