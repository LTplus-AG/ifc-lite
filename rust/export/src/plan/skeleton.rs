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
use crate::step_text::escape;

use super::add_types::GlobalId;
use super::placement::fmt;
use super::props_synth::ref_list;
use super::tessellation::Emit;

/// The schema a skeleton is written in.
pub const SKELETON_SCHEMA: &str = "IFC4";

/// One spatial root: its GlobalId and optional name.
#[derive(Debug, Clone)]
pub struct SkeletonRoot {
    pub global_id: GlobalId,
    pub name: Option<String>,
}

/// The length unit of a projected CRS's map coordinates.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
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
pub struct Skeleton {
    pub project: SkeletonRoot,
    pub site: SkeletonRoot,
    pub building: SkeletonRoot,
    /// Direction of true north in the project's XY plane, written as the
    /// model context's `TrueNorth`. `None` leaves it unset, which IFC reads
    /// as +Y.
    pub true_north: Option<[f64; 2]>,
    pub map_conversion: Option<MapConversion>,
}

/// An `IfcConversionBasedUnit` length unit of `metres` metres.
fn feet(emit: &mut Emit, name: &str, metres: f64, metre: u32) -> Result<u32, String> {
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

/// The skeleton's bytes.
///
/// # Errors
/// A number is not finite, a direction is zero length, the three roots do
/// not have distinct GlobalIds, or `crs_name` is empty.
pub fn skeleton(s: &Skeleton) -> Result<Vec<u8>, String> {
    check(s)?;
    let mut ids = IdAllocator::after(0);
    let mut out = Vec::new();
    let mut emit = Emit {
        schema: SKELETON_SCHEMA,
        ids: &mut ids,
        out: &mut out,
    };
    let quoted = |v: &str| format!("'{}'", escape(v));
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
        let map_unit = match m.map_unit {
            MapUnit::Metre => units[0],
            MapUnit::Foot => feet(&mut emit, "FOOT", 0.3048, units[0])?,
            MapUnit::UsSurveyFoot => feet(&mut emit, "US SURVEY FOOT", 1200.0 / 3937.0, units[0])?,
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
    }

    let project = emit.record(
        "IFCPROJECT",
        &[
            ("GlobalId", gid(&s.project)),
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
                ("RelatingObject", format!("#{relating}")),
                ("RelatedObjects", format!("(#{related})")),
            ],
        )?;
    }

    let mut text = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\n\
         FILE_SCHEMA(('{SKELETON_SCHEMA}'));\nENDSEC;\nDATA;\n"
    );
    for (_, record) in &out {
        text.push_str(record);
        text.push('\n');
    }
    text.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    Ok(text.into_bytes())
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
