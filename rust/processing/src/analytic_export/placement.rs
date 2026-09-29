// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Validate placement references before the mesh router's tolerant resolver.

use std::collections::HashSet;

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType, MAX_PLACEMENT_DEPTH};

pub(super) fn validate_placement_chain(
    element: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<(), String> {
    let Some(attr) = element.get(5).filter(|attr| !attr.is_null()) else {
        return Ok(());
    };
    let mut current = attr.as_entity_ref().ok_or("ObjectPlacement is not an entity reference")?;
    let mut seen = HashSet::new();
    loop {
        if seen.len() > MAX_PLACEMENT_DEPTH {
            return Err("placement chain exceeded maximum depth".into());
        }
        if !seen.insert(current) {
            return Err(format!("placement chain has a cycle at #{current}"));
        }
        let node = decoder.decode_by_id(current)
            .map_err(|error| format!("ObjectPlacement #{current}: {error}"))?;
        match node.ifc_type {
            IfcType::IfcLocalPlacement => {
                let relative = resolve_required(&node, 1, "RelativePlacement", decoder)?;
                if relative.ifc_type != IfcType::IfcAxis2Placement3D {
                    return Err(format!("IfcLocalPlacement #{current} has unsupported RelativePlacement #{} of type {}", relative.id, relative.ifc_type.name()));
                }
                validate_axis2_placement_3d(&relative, decoder)?;
            }
            IfcType::IfcGridPlacement => {
                // Positions follow the declared schema: IFC2X3/IFC4 have no
                // PlacementRelTo, so PlacementLocation is attribute 0 and the
                // parent frame is the placement of the grid owning the axes.
                let slot = decoder
                    .attribute_index("IfcGridPlacement", "PlacementLocation")
                    .ok_or_else(|| {
                        format!(
                            "IfcGridPlacement #{current} has no PlacementLocation in this schema"
                        )
                    })?;
                let location = resolve_required(&node, slot, "PlacementLocation", decoder)?;
                if location.ifc_type != IfcType::IfcVirtualGridIntersection {
                    return Err(format!("IfcGridPlacement #{current} has invalid PlacementLocation #{}", location.id));
                }
                if decoder.attribute_index("IfcGridPlacement", "PlacementRelTo").is_none() {
                    match owning_grid_placement(&location, decoder) {
                        Some(parent) => {
                            current = parent;
                            continue;
                        }
                        None => return Ok(()),
                    }
                }
            }
            IfcType::IfcLinearPlacement => {
                let relative = node.get(1).filter(|attr| !attr.is_null());
                let cartesian = node.get(2).filter(|attr| !attr.is_null());
                if relative.is_none() && cartesian.is_none() {
                    return Err(format!("IfcLinearPlacement #{current} has no RelativePlacement or CartesianPosition"));
                }
                if relative.is_some() {
                    let value = resolve_required(&node, 1, "RelativePlacement", decoder)?;
                    if value.ifc_type != IfcType::IfcAxis2PlacementLinear {
                        return Err(format!("IfcLinearPlacement #{current} has invalid RelativePlacement #{}", value.id));
                    }
                }
                if cartesian.is_some() {
                    let value = resolve_required(&node, 2, "CartesianPosition", decoder)?;
                    if value.ifc_type != IfcType::IfcAxis2Placement3D {
                        return Err(format!("IfcLinearPlacement #{current} has invalid CartesianPosition #{}", value.id));
                    }
                    validate_axis2_placement_3d(&value, decoder)?;
                }
            }
            _ => return Err(format!("ObjectPlacement #{current} has invalid type {}", node.ifc_type.name())),
        }
        let Some(parent) = node.get(0).filter(|attr| !attr.is_null()) else { return Ok(()) };
        current = parent.as_entity_ref()
            .ok_or_else(|| format!("placement #{current} has invalid PlacementRelTo"))?;
    }
}

/// IFC2X3/IFC4 grid placements sit in the frame of the `IfcGrid` that owns
/// their axes: that grid's ObjectPlacement id, when it has one.
fn owning_grid_placement(
    intersection: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Option<u32> {
    let axis = intersection.get_refs(0)?.first().copied()?;
    let grid = decoder.grid_of_axis(axis)?;
    let slot = decoder.attribute_index("IfcGrid", "ObjectPlacement")?;
    decoder.decode_by_id(grid).ok()?.get_ref(slot)
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
    fn ifc4_grid_placement_follows_the_owning_grid_placement() {
        // Break the grid's own placement: the walk must reach and refuse it.
        let broken = source("IFC4", "IFCGRIDPLACEMENT(#60,$)")
            .replace("#20=IFCLOCALPLACEMENT($,#23);", "#20=IFCLOCALPLACEMENT($,#21);");
        let err = validate(&broken).expect_err("grid placement chain reaches #20");
        assert!(err.contains("#20"), "{err}");
    }
}
