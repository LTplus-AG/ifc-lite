// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Validate placement references before the mesh router's tolerant resolver.

use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};
use ifc_lite_geometry::placement::{validate_chain, ChainPolicy};

/// What analytic export carries: local, grid and linear links, 3D frames only.
/// The walk is the shared one (visited set, no depth cap, D27).
const POLICY: ChainPolicy = ChainPolicy { grid: true, linear: true, planar_relative: false, strict_spatial: false };

pub(super) fn validate_placement_chain(
    element: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<(), String> {
    let Some(attr) = element.attr(slot::IfcProduct::OBJECT_PLACEMENT).filter(|attr| !attr.is_null()) else {
        return Ok(());
    };
    let id = attr.as_entity_ref().ok_or("ObjectPlacement is not an entity reference")?;
    let placement = decoder.decode_by_id(id).map_err(|error| format!("ObjectPlacement #{id}: {error}"))?;
    validate_chain(&placement, decoder, &POLICY).map_err(|error| error.to_string())
}

pub(super) fn resolve_required(
    node: &DecodedEntity,
    index: usize,
    name: &str,
    decoder: &mut EntityDecoder,
) -> Result<DecodedEntity, String> {
    let id = node.get_ref(index)
        .ok_or_else(|| format!("entity #{} has missing or invalid {name}", node.id))?;
    decoder.decode_by_id(id)
        .map_err(|error| format!("entity #{} {name} #{id}: {error}", node.id))
}

pub(super) fn validate_axis2_placement_3d(
    placement: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<(), String> {
    let location = resolve_required(placement, 0, "Location", decoder)?;
    if location.ifc_type != IfcType::IfcCartesianPoint {
        return Err(format!("IfcAxis2Placement3D #{} has invalid Location #{}", placement.id, location.id));
    }
    validate_optional_direction(placement, 1, "Axis", decoder)?;
    validate_optional_direction(placement, 2, "RefDirection", decoder)
}

pub(super) fn validate_axis2_placement_2d(
    placement: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<(), String> {
    let location = resolve_required(placement, 0, "Location", decoder)?;
    if location.ifc_type != IfcType::IfcCartesianPoint {
        return Err(format!("IfcAxis2Placement2D #{} has invalid Location #{}", placement.id, location.id));
    }
    validate_optional_direction(placement, 1, "RefDirection", decoder)
}

pub(super) fn validate_optional_direction(
    entity: &DecodedEntity,
    index: usize,
    name: &str,
    decoder: &mut EntityDecoder,
) -> Result<(), String> {
    if entity.get(index).is_none_or(|attr| attr.is_null()) {
        return Ok(());
    }
    let direction = resolve_required(entity, index, name, decoder)?;
    if direction.ifc_type != IfcType::IfcDirection {
        return Err(format!("entity #{} has invalid {name} #{} of type {}", entity.id, direction.id, direction.ifc_type.name()));
    }
    Ok(())
}

#[cfg(test)]
mod grid_layout_tests {
    use super::validate_placement_chain;
    use ifc_lite_core::EntityDecoder;

    /// #6232 F2: an IFC2X3/IFC4 grid placement is (PlacementLocation,
    /// PlacementRefDirection); reading it with the IFC4X3 slots refused a
    /// valid chain. The grid's own placement (#20) is then validated too.
    fn source(schema: &str, grid_placement: &str) -> String {
        format!(
            "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('{schema}'));\nENDSEC;\nDATA;\n\
#20=IFCLOCALPLACEMENT($,#23);\n#21=IFCCARTESIANPOINT((100.,200.,0.));\n\
#23=IFCAXIS2PLACEMENT3D(#21,$,$);\n\
#30=IFCCARTESIANPOINT((4.,-1.));\n#31=IFCCARTESIANPOINT((4.,10.));\n\
#32=IFCPOLYLINE((#30,#31));\n#33=IFCGRIDAXIS('1',#32,.T.);\n\
#34=IFCCARTESIANPOINT((-1.,3.));\n#35=IFCCARTESIANPOINT((10.,3.));\n\
#36=IFCPOLYLINE((#34,#35));\n#37=IFCGRIDAXIS('A',#36,.T.);\n\
#50=IFCGRID('0M7tQ9Jbj1BAeHd7rqnDmP',$,'Grid',$,$,#20,$,(#33),(#37),$,$);\n\
#60=IFCVIRTUALGRIDINTERSECTION((#33,#37),(0.,0.));\n\
#70={grid_placement};\n\
#90=IFCCOLUMN('1kTvXnbbzCWw8lcMd1dR4o',$,'C1',$,$,#70,$,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n"
        )
    }

    fn validate(content: &str) -> Result<(), String> {
        let mut decoder = EntityDecoder::new(content);
        let column = decoder.decode_by_id(90).expect("column");
        validate_placement_chain(&column, &mut decoder)
    }

    #[test]
    fn grid_placement_chain_validates_in_each_schema_layout() {
        assert_eq!(validate(&source("IFC2X3", "IFCGRIDPLACEMENT(#60,$)")), Ok(()));
        assert_eq!(validate(&source("IFC4", "IFCGRIDPLACEMENT(#60,$)")), Ok(()));
        assert_eq!(validate(&source("IFC4X3_ADD2", "IFCGRIDPLACEMENT(#20,#60,$)")), Ok(()));
    }

    #[test]
    fn issue_7779_grid_location_requires_a_virtual_intersection() {
        for (schema, prefix) in [("IFC2X3", ""), ("IFC4", ""), ("IFC4X3_ADD2", "#20,")] {
            for location in ["$", "#21"] {
                let placement = format!("IFCGRIDPLACEMENT({prefix}{location},$)");
                assert!(validate(&source(schema, &placement)).is_err(), "{schema}: {placement}");
            }
        }
    }

    #[test]
    fn ifc4_grid_placement_follows_the_owning_grid_placement() {
        // Break the grid's own placement: the walk must reach and refuse it.
        let broken = source("IFC4", "IFCGRIDPLACEMENT(#60,$)")
            .replace("#20=IFCLOCALPLACEMENT($,#23);", "#20=IFCLOCALPLACEMENT($,#21);");
        let err = validate(&broken).expect_err("grid placement chain reaches #20");
        assert!(err.contains("#21"), "the broken RelativePlacement of #20 is named: {err}");
    }
}

#[cfg(test)]
mod linear_layout_tests {
    use super::validate_placement_chain;
    use ifc_lite_core::EntityDecoder;

    /// X1 (#7780): `IfcLinearPlacement` is (PlacementRelTo, RelativePlacement,
    /// CartesianPosition) in IFC4X3, (PlacementRelTo, Distance, Orientation,
    /// CartesianPosition) in IFC4X1 and (PlacementRelTo, PlacementMeasuredAlong,
    /// Distance, Orientation, CartesianPosition) in IFC4X2. The validator read
    /// the IFC4X3 positions whatever the file declared, so every IFC4X1/4X2
    /// linear placement was refused as having an invalid RelativePlacement.
    fn source(schema: &str, linear: &str) -> String {
        format!(
            "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('{schema}'));\nENDSEC;\nDATA;\n\
#21=IFCCARTESIANPOINT((100.,200.,0.));\n#23=IFCAXIS2PLACEMENT3D(#21,$,$);\n\
#70={linear};\n#90=IFCCOLUMN('1kTvXnbbzCWw8lcMd1dR4o',$,'C1',$,$,#70,$,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n"
        )
    }

    fn validate(content: &str) -> Result<(), String> {
        let mut decoder = EntityDecoder::new(content);
        let column = decoder.decode_by_id(90).expect("column");
        validate_placement_chain(&column, &mut decoder)
    }

    #[test]
    fn cartesian_position_validates_at_each_schemas_own_position() {
        assert_eq!(validate(&source("IFC4X1", "IFCLINEARPLACEMENT($,$,$,#23)")), Ok(()));
        assert_eq!(validate(&source("IFC4X2", "IFCLINEARPLACEMENT($,$,$,$,#23)")), Ok(()));
        assert_eq!(validate(&source("IFC4X3_ADD2", "IFCLINEARPLACEMENT($,$,#23)")), Ok(()));
    }

    #[test]
    fn a_mislabelled_ifc4_file_keeps_the_ifc4x3_layout() {
        for schema in ["IFC2X3", "IFC4"] {
            assert_eq!(validate(&source(schema, "IFCLINEARPLACEMENT($,$,#23)")), Ok(()), "{schema}");
        }
    }

    #[test]
    fn a_linear_placement_with_nothing_to_resolve_is_refused_in_every_schema() {
        for (schema, linear) in [
            ("IFC4X1", "IFCLINEARPLACEMENT($,$,$,$)"),
            ("IFC4X2", "IFCLINEARPLACEMENT($,$,$,$,$)"),
            ("IFC4X3_ADD2", "IFCLINEARPLACEMENT($,$,$)"),
        ] {
            let err = validate(&source(schema, linear)).expect_err(schema);
            assert!(err.contains("missing RelativePlacement or CartesianPosition"), "{schema}: {err}");
        }
    }

    #[test]
    fn a_frame_in_the_wrong_slot_of_the_declared_schema_is_not_a_cartesian_position() {
        // Slot 2 of IFC4X2 is `Distance`, not CartesianPosition (4).
        let err = validate(&source("IFC4X2", "IFCLINEARPLACEMENT($,$,#23,$,$)")).expect_err("misplaced");
        assert!(err.contains("missing RelativePlacement or CartesianPosition"), "{err}");
    }
}
