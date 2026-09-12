// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IFC2x3 `ePSet_MapConversion` / `ePSet_ProjectedCRS` fallback for
//! `georef.rs`'s [`GeoRefExtractor`].
//!
//! Split out of `georef.rs` to keep that module inside its module-size
//! ratchet budget (the same split as `georef_parse.rs`): these functions are
//! the whole property-set path and are only ever reached from
//! `GeoRefExtractor::extract` when no `IfcMapConversion` is present.

use super::{GeoRefExtractor, GeoRefSource, GeoReference};
use crate::decoder::EntityDecoder;
use crate::error::Result;
use crate::generated::IfcType;
use crate::schema_gen::{AttributeValue, DecodedEntity};

/// Read an `IfcPropertySingleValue.NominalValue` (index 2) as a string,
/// unwrapping the typed-value wrapper `IFCLABEL('…')` / `IFCIDENTIFIER('…')`
/// (parsed as a `List([type-name, value])`) that plain `get_string` doesn't
/// see through. Property values in the IFC2x3 ePSets are always typed, so
/// without this the CRS `Name`/`TargetCRS` labels came back empty.
fn pset_value_string(prop: &DecodedEntity) -> Option<String> {
    match prop.get(2)? {
        AttributeValue::String(s) => Some(s.clone()),
        AttributeValue::List(items) => match (items.first(), items.get(1)) {
            (Some(AttributeValue::String(_)), Some(AttributeValue::String(v))) => Some(v.clone()),
            _ => None,
        },
        _ => None,
    }
}

impl GeoRefExtractor {
    /// Extract from IFC2X3 property sets (fallback)
    pub(super) fn extract_from_pset(
        decoder: &mut EntityDecoder,
        entity_types: &[(u32, IfcType)],
    ) -> Result<Option<GeoReference>> {
        // Locate the ePSet_MapConversion (required) and ePSet_ProjectedCRS
        // (optional) property sets. The match is case-insensitive: the
        // buildingSMART geo-referencing guide spells these `ePSet_…` (capital
        // S), but real authoring tools (e.g. the `ifc-georeferencer`
        // post-processor) write `ePset_…` (lowercase), and an exact match
        // silently dropped those models to the legacy IfcSite/EPSG:4326
        // fallback so they displayed the wrong CRS. IfcPropertySet.Name is
        // attribute 2 (attribute 0 is GlobalId); reading attribute 0 here
        // never matched the ePSet at all (issue #900 review).
        let mut map_conversion_pset: Option<u32> = None;
        let mut projected_crs_pset: Option<u32> = None;
        for (id, ifc_type) in entity_types {
            if *ifc_type != IfcType::IfcPropertySet {
                continue;
            }
            if let Some(name) = decoder.decode_string_by_id_transient(*id, 2)? {
                if name.eq_ignore_ascii_case("ePSet_MapConversion") && map_conversion_pset.is_none() {
                    map_conversion_pset = Some(*id);
                } else if name.eq_ignore_ascii_case("ePSet_ProjectedCRS") && projected_crs_pset.is_none() {
                    projected_crs_pset = Some(*id);
                }
            }
        }

        let Some(mc_id) = map_conversion_pset else {
            return Ok(None);
        };
        let mc_entity = decoder.decode_by_id(mc_id)?;
        Self::parse_pset_map_conversion(decoder, &mc_entity, projected_crs_pset)
    }

    /// Parse ePSet_MapConversion property set, plus the EPSG `Name` from an
    /// optional ePSet_ProjectedCRS set (falling back to the MapConversion's
    /// own `TargetCRS` label). Without the CRS name the EPSG code authored in
    /// the file was never surfaced on the IFC2x3 path.
    fn parse_pset_map_conversion(
        decoder: &mut EntityDecoder,
        pset: &DecodedEntity,
        projected_crs_pset: Option<u32>,
    ) -> Result<Option<GeoReference>> {
        let mut georef = GeoReference::new();
        georef.source = GeoRefSource::EPSetMapConversion;
        let mut target_crs: Option<String> = None;

        // HasProperties is typically at index 4
        if let Some(props_list) = pset.get_list(4) {
            for prop_attr in props_list {
                if let Some(prop_id) = prop_attr.as_entity_ref() {
                    let prop = decoder.decode_by_id(prop_id)?;
                    // IfcPropertySingleValue: Name (0), Description (1), NominalValue (2)
                    if let Some(name) = prop.get_string(0) {
                        let value = prop.get_float(2);
                        match name {
                            "Eastings" => {
                                if let Some(v) = value {
                                    georef.eastings = v;
                                }
                            }
                            "Northings" => {
                                if let Some(v) = value {
                                    georef.northings = v;
                                }
                            }
                            "OrthogonalHeight" => {
                                if let Some(v) = value {
                                    georef.orthogonal_height = v;
                                }
                            }
                            "XAxisAbscissa" => {
                                if let Some(v) = value {
                                    georef.x_axis_abscissa = v;
                                }
                            }
                            "XAxisOrdinate" => {
                                if let Some(v) = value {
                                    georef.x_axis_ordinate = v;
                                }
                            }
                            "Scale" => {
                                if let Some(v) = value {
                                    georef.scale = v;
                                }
                            }
                            "TargetCRS" => {
                                if let Some(v) = pset_value_string(&prop) {
                                    target_crs = Some(v);
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        }

        // Pull the CRS name + datum fields from ePSet_ProjectedCRS if present.
        if let Some(crs_id) = projected_crs_pset {
            let crs_entity = decoder.decode_by_id(crs_id)?;
            Self::parse_pset_projected_crs(decoder, &crs_entity, &mut georef);
        }
        // ePSet_ProjectedCRS.Name wins, but an empty/whitespace-only name must
        // not block the TargetCRS fallback — the viewer gate requires a truthy
        // CRS name, so leaving `crs_name = Some("")` would silently drop the
        // model to the IfcSite/EPSG:4326 fallback. Treat blank as missing.
        let crs_name_is_blank = georef
            .crs_name
            .as_ref()
            .is_none_or(|name| name.trim().is_empty());
        if crs_name_is_blank {
            georef.crs_name = target_crs.filter(|name| !name.trim().is_empty());
        }

        georef.normalize_axis();

        if georef.has_georef() {
            Ok(Some(georef))
        } else {
            Ok(None)
        }
    }

    /// Parse an ePSet_ProjectedCRS property set into the georef's CRS fields.
    fn parse_pset_projected_crs(
        decoder: &mut EntityDecoder,
        pset: &DecodedEntity,
        georef: &mut GeoReference,
    ) {
        let Some(props_list) = pset.get_list(4) else {
            return;
        };
        for prop_attr in props_list {
            let Some(prop_id) = prop_attr.as_entity_ref() else {
                continue;
            };
            let Ok(prop) = decoder.decode_by_id(prop_id) else {
                continue;
            };
            let Some(name) = prop.get_string(0) else {
                continue;
            };
            let value = pset_value_string(&prop);
            match name {
                "Name" => georef.crs_name = value,
                "Description" => georef.crs_description = value,
                "GeodeticDatum" => georef.geodetic_datum = value,
                "VerticalDatum" => georef.vertical_datum = value,
                "MapProjection" => georef.map_projection = value,
                "MapZone" => georef.map_zone = value,
                "MapUnit" => {
                    // Parity with the native IfcProjectedCRS path: derive the
                    // metre scale from the unit label so consumers don't default
                    // explicit non-metre ePSet offsets to metres.
                    georef.map_unit_scale = value.as_deref().and_then(crate::unit_labels::infer_map_unit_scale);
                    georef.map_unit = value;
                }
                _ => {}
            }
        }
    }
}
