// SPDX-License-Identifier: MPL-2.0
//! Source-only orientation walk. Frames come from the canonical analytic walk;
//! this walk determines Difference polarity without reconstructing placements.
use super::{disk, extrusion, AnalyticQuantitySources, Surface};
use ifc_lite_core::{slot, EntityDecoder, EntityScanner, IfcType, SourceBundle};
use ifc_lite_geometry::{analytic::AnalyticStatus, meshed_representations, GeometryRouter};
use std::collections::BTreeMap;

type Signs = BTreeMap<(u32, Vec<u32>), Vec<f64>>;
struct Node { id: u32, sign: f64, path: Vec<u32>, maps: Vec<u32> }

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
        if extrusions.is_none() && disks.is_none() {continue;}
        let signs = orientations(&mut decoder,id)?;
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
        // An authored IfcHalfSpaceSolid plane is a source surface of the face it cuts:
        // outward normal toward the removed side, reversed for an opening cutter.
        result.extend(crate::oracle::clips::source_planes(&bundle,sources,id)?.into_iter()
            .map(|p| Surface::Plane {origin:p.point,normal:p.normal}.reversed(polarity)));
    }
    Ok(result)
}

fn orientations(decoder: &mut EntityDecoder<'_>, id: u32) -> Result<Signs,String> {
    let product = decoder.decode_by_id(id).map_err(|e| e.to_string())?;
    let shape = decoder.decode_by_id(product.ref_at(slot::IfcProduct::REPRESENTATION).ok_or("missing Representation")?)
        .map_err(|e| e.to_string())?;
    let representations = shape.ref_list_at(slot::IfcProductRepresentation::REPRESENTATIONS).ok_or("missing Representations")?
        .into_iter().map(|r| decoder.decode_by_id(r).map_err(|e| e.to_string())).collect::<Result<Vec<_>,_>>()?;
    let mut stack = Vec::new();
    for rep in meshed_representations(&product,&representations) {
        for id in rep.ref_list_at(slot::IfcRepresentation::ITEMS).ok_or("missing Items")? {
            stack.push(Node {id,sign:1.,path:Vec::new(),maps:Vec::new()});
        }
    }
    let mut result = Signs::new();
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
                vec![(item.ref_at(slot::IfcMappedItem::MAPPING_SOURCE).ok_or("missing MappingSource")?,n.sign)]
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
            _ => {result.entry((n.id,n.maps)).or_default().push(n.sign); continue;}
        };
        if stack.len().saturating_add(children.len()) > 100_000 {return Err("normal source frontier exceeded bounds".into());}
        for (id,sign) in children { stack.push(Node {id,sign,path:n.path.clone(),maps:n.maps.clone()}); }
    }
    Ok(result)
}
