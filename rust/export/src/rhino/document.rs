// SPDX-License-Identifier: MPL-2.0
//! Document user strings and the earth anchor point.

use ifc_lite_core::fmt_num::fmt_num;
use ifc_lite_processing::{Georeferencing, ModelMetadata};

use super::options::RhinoCoordinates;
use super::source::{AnchorSite, ModelInfo};
use super::space::{rhino_unit_for_scale, OutputSpace};
use super::wire::EarthAnchor;

/// The model's map conversion, when it has one (not the legacy site fallback,
/// which is lat/long and goes to the earth anchor instead).
fn map_conversion(georef: Option<&Georeferencing>) -> Option<&Georeferencing> {
    georef.filter(|g| g.is_map_conversion())
}

/// The earth anchor, set only when a site carries RefLatitude/RefLongitude.
/// Location and base point come from that one site ([`AnchorSite::origin`]).
/// A placement that does not resolve, or a length unit that was refused (so
/// RefElevation has no metres), omits the anchor with one warning: never a
/// guessed base point or elevation. North is the model context's TrueNorth
/// (`true_north`), else the map conversion's grid north, else +Y; all mapped
/// into the written frame.
pub(super) fn earth_anchor(
    anchor_site: Option<&AnchorSite>,
    true_north: Option<[f64; 2]>,
    space: &OutputSpace,
    metadata: &ModelMetadata,
    warnings: &mut Vec<String>,
) -> Option<EarthAnchor> {
    let AnchorSite { location: site, origin } = anchor_site?;
    let Some(length_unit_scale) = metadata.length_unit_scale else {
        warnings.push("the model's length unit was refused, so RefElevation has no metres; wrote no earth anchor".to_string());
        return None;
    };
    let Some(origin) = *origin else {
        warnings.push("the IfcSite with RefLatitude/RefLongitude has no resolvable placement; wrote no earth anchor".to_string());
        return None;
    };
    let grid_north = map_conversion(metadata.georeferencing.as_ref()).map(|g| [g.x_axis_ordinate, g.x_axis_abscissa]);
    let [nx, ny] = true_north
        .or_else(|| grid_north.and_then(|[x, y]| ifc_lite_core::unit_xy(x, y)))
        .unwrap_or([0.0, 1.0]);
    // `+ 0.0` turns a negative zero (`RefElevation -0.`, a north of +Y) into 0.
    let tidy = |v: [f64; 3]| v.map(|c| c + 0.0);
    Some(EarthAnchor {
        latitude: site.latitude,
        longitude: site.longitude,
        elevation: site.elevation * length_unit_scale + 0.0,
        model_base_point: tidy(space.world_point(origin)),
        model_north: tidy(space.world_direction([nx, ny, 0.0])),
        model_east: tidy(space.world_direction([ny, -nx, 0.0])),
        name: "IfcSite RefLatitude/RefLongitude".to_string(),
    })
}

/// Document user strings, in a fixed key order; empty values are omitted.
pub(super) fn document_strings(
    content: &[u8],
    info: &ModelInfo,
    metadata: &ModelMetadata,
    coordinates: RhinoCoordinates,
    space: &OutputSpace,
) -> Vec<(String, String)> {
    let header = crate::source_header::parse_source_header(content);
    let mut out: Vec<(String, String)> = Vec::new();
    let mut put = |k: &str, v: Option<String>| {
        if let Some(v) = v.filter(|v| !v.is_empty()) {
            out.push((k.to_string(), v));
        }
    };
    put("IFC::Schema", Some(metadata.schema_version.clone()));
    put("IFC::Project", info.project_info.name.clone());
    put("IFC::ProjectGlobalId", info.project_info.global_id.clone());
    put("IFC::SourceFileName", header.as_ref().and_then(|h| h.name.clone()));
    put("IFC::SourceApplication", header.as_ref().and_then(|h| h.originating_system.clone()));
    put(
        "IFC::LengthUnit",
        metadata.length_unit_scale.map(|s| rhino_unit_for_scale(s).map_or_else(|| format!("{} m", fmt_num(s)), |(n, _)| n.to_string())),
    );
    put("IFC::Coordinates", Some(if coordinates == RhinoCoordinates::World { "world" } else { "local" }.to_string()));
    put("IFC::WorldFromModel", space.world_from_model().map(|m| m.iter().map(|v| fmt_num(*v)).collect::<Vec<_>>().join(" ")));
    if let Some(g) = map_conversion(metadata.georeferencing.as_ref()) {
        put("IFC::MapConversion::Eastings", Some(fmt_num(g.eastings)));
        put("IFC::MapConversion::Northings", Some(fmt_num(g.northings)));
        put("IFC::MapConversion::OrthogonalHeight", Some(fmt_num(g.orthogonal_height)));
        put("IFC::MapConversion::XAxisAbscissa", Some(fmt_num(g.x_axis_abscissa)));
        put("IFC::MapConversion::XAxisOrdinate", Some(fmt_num(g.x_axis_ordinate)));
        put("IFC::MapConversion::Scale", Some(fmt_num(g.scale)));
        put("IFC::CRS", g.crs_name.clone());
    }
    put("IFC::Exporter", Some(format!("ifc-lite {}", env!("CARGO_PKG_VERSION"))));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use ifc_lite_core::SiteRefLocation;
    use ifc_lite_processing::MeshFrame;

    fn anchor(origin: Option<[f64; 3]>, length_unit_scale: Option<f64>) -> (Option<EarthAnchor>, Vec<String>) {
        let site = AnchorSite { location: SiteRefLocation { latitude: 47.0, longitude: 8.0, elevation: 408.0 }, origin };
        let space = OutputSpace::new(MeshFrame::select(None, None), RhinoCoordinates::Local, 1.0);
        let metadata = ModelMetadata { length_unit_scale, ..ModelMetadata::default() };
        let mut warnings = Vec::new();
        (earth_anchor(Some(&site), None, &space, &metadata, &mut warnings), warnings)
    }

    #[test]
    fn a_resolved_site_in_a_known_unit_anchors() {
        let (a, warnings) = anchor(Some([1.0, 2.0, 3.0]), Some(0.5));
        let a = a.expect("anchor");
        assert_eq!((a.elevation, a.model_base_point), (204.0, [1.0, 2.0, 3.0]));
        assert!(warnings.is_empty(), "{warnings:?}");
    }

    /// RefElevation in file units is never labelled metres: a refused unit
    /// writes no anchor rather than a scale of 1.
    #[test]
    fn a_refused_length_unit_writes_no_anchor() {
        let (a, warnings) = anchor(Some([0.0; 3]), None);
        assert!(a.is_none());
        assert_eq!(warnings, ["the model's length unit was refused, so RefElevation has no metres; wrote no earth anchor"]);
    }
}
