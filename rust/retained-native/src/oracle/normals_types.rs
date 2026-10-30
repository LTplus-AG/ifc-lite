// SPDX-License-Identifier: MPL-2.0
//! Orphan maps have no product occurrence in the analytic quantity inventory.
//! Use the same canonical map transforms as the existing orphan quantity oracle.
use super::{extrusion, Surface};
use super::super::math::{multiply, IDENTITY};
use ifc_lite_core::{slot, EntityDecoder, IfcType};
use ifc_lite_geometry::{analytic::extract_analytic_extrusion, GeometryRouter};
struct Node {id: u32, frame: [f64;16], path: Vec<u32>}

pub(super) fn surfaces(decoder: &mut EntityDecoder<'_>, maps: &[(u32,u8)]) -> Result<Vec<Surface>,String> {
    let router = GeometryRouter::with_scale(1.);
    let mut units = IDENTITY;
    for i in [0,5,10] {units[i]=decoder.length_unit_scale();}
    let mut stack = Vec::new();
    for &(id,_) in maps {
        let map = decoder.decode_by_id(id).map_err(|e| e.to_string())?;
        let origin = router.mapping_origin_transform(&map,decoder).map_err(|e| e.to_string())?
            .map(|m| ifc_lite_geometry::math::mat4::col_major_array(&m)).unwrap_or(IDENTITY);
        let rep = map.ref_at(slot::IfcRepresentationMap::MAPPED_REPRESENTATION).ok_or("missing MappedRepresentation")?;
        stack.push(Node {id:rep,frame:multiply(&units,&origin),path:vec![id]});
    }
    let mut result = Vec::new();
    let mut work = 0;
    while let Some(mut n) = stack.pop() {
        work+=1;
        if work > 100_000 || n.path.contains(&n.id) || n.path.len() >= ifc_lite_core::limits::MAX_MAPPED_ITEM_DEPTH as usize {
            return Err("orphan normal source walk exceeded bounds or cycled".into());
        }
        n.path.push(n.id);
        let item = decoder.decode_by_id(n.id).map_err(|e| e.to_string())?;
        let children = match item.ifc_type {
            IfcType::IfcShapeRepresentation => item.ref_list_at(slot::IfcRepresentation::ITEMS).ok_or("missing Items")?,
            IfcType::IfcMappedItem => {
                let map_id = item.ref_at(slot::IfcMappedItem::MAPPING_SOURCE).ok_or("missing MappingSource")?;
                if n.path.contains(&map_id) {return Err("cyclic orphan map".into());}
                n.path.push(map_id);
                let map = decoder.decode_by_id(map_id).map_err(|e| e.to_string())?;
                let local = router.resolve_scaled_mapped_item_transform(&item,&map,decoder).map_err(|e|e.to_string())?.unwrap_or(IDENTITY);
                n.frame=multiply(&n.frame,&local);
                vec![map.ref_at(slot::IfcRepresentationMap::MAPPED_REPRESENTATION).ok_or("missing mapped representation")?]
            }
            IfcType::IfcExtrudedAreaSolid => {
                result.extend(extrusion(&extract_analytic_extrusion(&item,decoder),&n.frame).ok_or("unresolved orphan prism normals")?);
                continue;
            }
            _ => return Err("unresolved orphan normal source".into()),
        };
        if stack.len().saturating_add(children.len())>100_000 {return Err("orphan source frontier exceeded bounds".into());}
        for id in children {stack.push(Node {id,frame:n.frame,path:n.path.clone()});}
    }
    Ok(result)
}
