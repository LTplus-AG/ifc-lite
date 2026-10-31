// SPDX-License-Identifier: MPL-2.0
//! Source-only orientation walk. Frames come from the canonical analytic walk;
//! this walk determines Difference polarity without reconstructing placements.
use super::{disk, extrusion, AnalyticQuantitySources, Surface};
use ifc_lite_core::{slot, EntityDecoder, EntityScanner, IfcType, SourceBundle};
use ifc_lite_geometry::{analytic::AnalyticStatus, meshed_representations, GeometryRouter};
use std::collections::BTreeMap;
use ifc_lite_geometry::{placement::resolve_object_placement, representation::MappedLevel};
use super::math::{IDENTITY, multiply};

type Signs = BTreeMap<(u32, Vec<u32>), Vec<f64>>;
struct Node { id: u32, sign: f64, path: Vec<u32>, maps: Vec<u32>, world: [f64;16] }

pub fn surfaces(bytes: &[u8], sources: &AnalyticQuantitySources, product: u32) -> Result<Vec<Surface>,String> {
    let bundle = SourceBundle::new(bytes.to_vec());
    let mut decoder = bundle.decoder();
    if let Some(maps) = ifc_lite_processing::element::retained_runtime::canonical_type_maps(&bundle).get(&product) {
        return super::types::surfaces(&mut decoder,maps);
    }
    let mut products = vec![(product,1.)];
    let router = GeometryRouter::with_scale(decoder.length_unit_scale());
    let mut scan = EntityScanner::new(bytes);
    while let Some((_,name,start,end)) = scan.next_entity() {
        if !name.eq_ignore_ascii_case("IFCRELVOIDSELEMENT") {continue;}
        let rel = decoder.decode_at_uncached(start,end).map_err(|e| e.to_string())?;
        if rel.ref_at(slot::IfcRelVoidsElement::RELATING_BUILDING_ELEMENT) == Some(product) {
            let id = rel.ref_at(slot::IfcRelVoidsElement::RELATED_OPENING_ELEMENT).ok_or("missing opening")?;
            if router.opening_requires_subtraction(id,&mut decoder) { products.push((id,-1.)); }
        }
    }
    let mut result = Vec::new();
    for (id,polarity) in products {
        let extrusions = sources.extrusion_definitions.instances.get(&id);
        let disks = sources.swept_disk_descriptions.elements.get(&id);
        let (signs,halfspaces) = orientations(&mut decoder,id)?;
        for i in extrusions.into_iter().flatten() {
            let source = &sources.extrusion_definitions.sources.iter().find(|s| s.key==i.source).ok_or("missing prism source")?.source;
            for &sign in signs.get(&(i.solid_id,i.mapping_path.clone())).ok_or("missing prism polarity")? {
                let frame = i.world_from_source.ok_or("missing prism frame")?;
                result.extend(extrusion(source,&frame)
                    .or_else(|| super::retrace::extrusion(source,&mut decoder,&frame))
                    .ok_or("unresolved prism normals")?.into_iter().map(|s| s.reversed(sign*polarity)));
            }
        }
        for i in disks.into_iter().flatten() {
            if i.status != AnalyticStatus::Complete {return Err("unresolved swept disk source".into());}
            for &sign in signs.get(&(i.solid_id,i.mapping_path.clone())).ok_or("missing disk polarity")? {
                result.extend(disk(&i.directrix,i.radius,i.inner_radius).ok_or("unresolved disk normals")?
                    .into_iter().map(|s| s.reversed(sign*polarity)));
            }
        }
        result.extend(halfspaces.into_iter().map(|s| s.reversed(polarity)));
    }
    Ok(result)
}

fn orientations(decoder: &mut EntityDecoder<'_>, id: u32) -> Result<(Signs,Vec<Surface>),String> {
    let product = decoder.decode_by_id(id).map_err(|e| e.to_string())?;
    let mut world = resolve_object_placement(&product,decoder).map_err(|e| e.to_string())?
        .unwrap_or_else(ifc_lite_geometry::Matrix4::identity);
    let scale = decoder.length_unit_scale();
    for row in 0..3 { for col in 0..4 { world[(row,col)] *= scale; } }
    let world: [f64;16] = world.as_slice().try_into().unwrap();
    let shape = decoder.decode_by_id(product.ref_at(slot::IfcProduct::REPRESENTATION).ok_or("missing Representation")?)
        .map_err(|e| e.to_string())?;
    let representations = shape.ref_list_at(slot::IfcProductRepresentation::REPRESENTATIONS).ok_or("missing Representations")?
        .into_iter().map(|r| decoder.decode_by_id(r).map_err(|e| e.to_string())).collect::<Result<Vec<_>,_>>()?;
    let mut stack = Vec::new();
    for rep in meshed_representations(&product,&representations) {
        for id in rep.ref_list_at(slot::IfcRepresentation::ITEMS).ok_or("missing Items")? {
            stack.push(Node {id,sign:1.,path:Vec::new(),maps:Vec::new(),world});
        }
    }
    let mut result = Signs::new();
    let mut halfspaces = Vec::new();
    let mut work = 0;
    while let Some(mut n) = stack.pop() {
        work += 1;
        if work > 100_000 || n.path.contains(&n.id)
            || n.path.len() >= ifc_lite_core::limits::MAX_MAPPED_ITEM_DEPTH as usize {
            return Err("normal source walk exceeded bounds or cycled".into());
        }
        let item = decoder.decode_by_id(n.id).map_err(|e| e.to_string())?;
        n.path.push(n.id);
        let children = match item.ifc_type {
            IfcType::IfcMappedItem => {
                n.maps.push(n.id);
                let map_id = item.ref_at(slot::IfcMappedItem::MAPPING_SOURCE).ok_or("missing MappingSource")?;
                let map = decoder.decode_by_id(map_id).map_err(|e|e.to_string())?;
                let mapped_rep = decoder.decode_by_id(map.ref_at(slot::IfcRepresentationMap::MAPPED_REPRESENTATION)
                    .ok_or("missing MappedRepresentation")?).map_err(|e|e.to_string())?;
                let level = MappedLevel {item,map,mapped_rep};
                let local = level.local_transform(decoder).map_err(|e|e.to_string())?;
                n.world = multiply(&n.world,&local.map(|m|m.as_slice().try_into().unwrap()).unwrap_or(IDENTITY));
                vec![(map_id,n.sign)]
            }
            IfcType::IfcRepresentationMap => vec![(item.ref_at(slot::IfcRepresentationMap::MAPPED_REPRESENTATION)
                .ok_or("missing MappedRepresentation")?,n.sign)],
            IfcType::IfcShapeRepresentation => item.ref_list_at(slot::IfcRepresentation::ITEMS).ok_or("missing mapped Items")?
                .into_iter().map(|id| (id,n.sign)).collect(),
            IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult => {
                use slot::IfcBooleanResult as B;
                let sign = match item.enum_at(B::OPERATOR) {
                    Some("DIFFERENCE") => -n.sign, Some("UNION" | "INTERSECTION") => n.sign,
                    _ => return Err("unknown Boolean operator".into()),
                };
                vec![(item.ref_at(B::FIRST_OPERAND).ok_or("missing FirstOperand")?,n.sign),
                    (item.ref_at(B::SECOND_OPERAND).ok_or("missing SecondOperand")?,sign)]
            }
            IfcType::IfcCsgSolid => vec![(item.ref_at(slot::IfcCsgSolid::TREE_ROOT_EXPRESSION).ok_or("missing TreeRootExpression")?,n.sign)],
            _ => {
                // A face set's winding is the capture's and the witnesses' polarity to prove;
                // here each authored row is one flat source surface, whichever way it faces.
                if matches!(item.ifc_type, IfcType::IfcTriangulatedFaceSet | IfcType::IfcTriangulatedIrregularNetwork | IfcType::IfcPolygonalFaceSet) {
                    let set = super::super::face_sets::authored(&item,decoder,1.).ok_or("unreadable face set")?;
                    for (origin,normal) in super::super::face_sets::world_planes(&set,|p| super::super::math::transform(&n.world,p)) {
                        halfspaces.push(Surface::Plane {origin,normal});
                        halfspaces.push(Surface::Plane {origin,normal:normal.map(|v| -v)});
                    }
                }
                if item.ifc_type.is_subtype_of(IfcType::IfcHalfSpaceSolid) {
                    halfspaces.extend(super::halfspaces::surfaces(n.id,&n.world,decoder)?
                        .into_iter().map(|s|s.reversed(n.sign)));
                }
                result.entry((n.id,n.maps)).or_default().push(n.sign); continue;
            }
        };
        if stack.len().saturating_add(children.len()) > 100_000 {return Err("normal source frontier exceeded bounds".into());}
        for (id,sign) in children { stack.push(Node {id,sign,path:n.path.clone(),maps:n.maps.clone(),world:n.world}); }
    }
    Ok((result,halfspaces))
}
