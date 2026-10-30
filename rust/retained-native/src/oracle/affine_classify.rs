// SPDX-License-Identifier: MPL-2.0
//! M10 winding-gate classification: which published products carry a nonrigid map,
//! decided from the source alone (no world placement, no analytic solid). Anything
//! that cannot be decoded is `Unmodelled`, so the harness fails closed.
use super::{affine::{mesh_moments,Frame},affine_operator::{mapping,nonrigid},math::*};
use ifc_lite_core::{slot, EntityDecoder, IfcType};

/// Whether a published product's mapped body carries a nonrigid transform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Classification {
    /// No mapped item changes handedness or scale.
    Rigid,
    /// At least one mapped item mirrors or scales: signed winding is mandatory.
    Affine,
    /// A mapped body this oracle cannot decode. The harness must fail closed.
    Unmodelled(String),
}
/// The product's selected representations, as item ids to walk.
pub(super) fn selected_items(d:&mut EntityDecoder<'_>,id:u32) -> Result<Vec<u32>,String> {
    let unavailable=|what:&str| format!("{what} of #{id} unavailable");
    let p=d.decode_by_id(id).map_err(|_|unavailable("product"))?;
    let reps=if p.ifc_type.is_subtype_of(IfcType::IfcTypeProduct) {
        let mut reps=Vec::new();
        for id in p.ref_list_at(slot::IfcTypeProduct::REPRESENTATION_MAPS).ok_or_else(||unavailable("representation maps"))? {
            let map=d.decode_by_id(id).map_err(|_|unavailable("representation map"))?;
            let rep=map.ref_at(slot::IfcRepresentationMap::MAPPED_REPRESENTATION).ok_or_else(||unavailable("mapped representation"))?;
            reps.push(d.decode_by_id(rep).map_err(|_|unavailable("mapped representation"))?);
        }
        reps
    } else {
        // `Ok(None)` is a product without a body: nothing selected, nothing mapped.
        let Some(shape)=ifc_lite_geometry::representation::product_shape(&p,d).map_err(|_|unavailable("shape"))? else {return Ok(Vec::new())};
        shape.representations().to_vec()
    };
    let mut items=Vec::new();
    // Use the retained selector's predicate: RepresentationType selects body
    // geometry even without an identifier, and direct geometry suppresses maps.
    for rep in ifc_lite_geometry::representation::meshed_representations(&p,&reps) {
        items.extend(rep.ref_list_at(slot::IfcRepresentation::ITEMS).ok_or_else(||unavailable("representation items"))?.into_iter().rev());
    }
    Ok(items)
}
/// Mapped leaves as `(item, mapping matrix, affine)`; the world placement is
/// deliberately absent, so IfcGridPlacement and IfcLinearPlacement cannot hide a mirror.
pub(super) fn mapped_items(d:&mut EntityDecoder<'_>,id:u32) -> Result<Vec<(u32,Frame,bool)>,String> {
    let mut stack:Vec<_>=selected_items(d,id)?.into_iter().map(|item|(item,IDENTITY,0,false)).collect();
    let mut result=Vec::new();let mut work=0;
    while let Some((id,mapping_matrix,depth,affine))=stack.pop() {
        work+=1;if work>8192||depth>128 {return Err("mapped body work or depth cap exceeded".into())}
        let e=d.decode_by_id(id).map_err(|_|format!("source node #{id} unavailable"))?;
        if e.ifc_type==IfcType::IfcMappedItem {
            let (Some(source),Some(target))=(e.ref_at(slot::IfcMappedItem::MAPPING_SOURCE),e.ref_at(slot::IfcMappedItem::MAPPING_TARGET)) else {
                return Err(format!("mapped item #{id} has no source or target"))
            };
            let (map,items)=mapping(d,source,target).ok_or_else(||format!("mapped item #{id}: unsupported operator, degenerate axes or missing origin"))?;
            for item in items.into_iter().rev() {stack.push((item,multiply(&mapping_matrix,&map),depth+1,affine||nonrigid(&map)));}
        } else {result.push((id,mapping_matrix,affine));}
    }
    Ok(result)
}
/// Whether any mapped item anywhere under the selected Body is nonrigid. The walk
/// follows Boolean operands and CSG roots as well as map contents: a mirrored map
/// under a Boolean operand still needs its winding gate. A mapped item whose
/// operator cannot be decoded, and any unreadable node, fail closed (`Err`), as
/// `bounded_source::contains_bounded` does; a body with no map is simply rigid.
fn scan(d:&mut EntityDecoder<'_>,id:u32) -> Result<bool,String> {
    let mut pending:Vec<_>=selected_items(d,id)?.into_iter().map(|item|(item,0u32)).collect();
    let mut visited=std::collections::BTreeSet::new();
    let mut affine=false;
    while let Some((id,depth))=pending.pop() {
        if !visited.insert(id) {continue}
        if visited.len()>8192||depth>128 {return Err("body scan work or depth cap exceeded".into())}
        let node=d.decode_by_id(id).map_err(|_|format!("source node #{id} unavailable"))?;
        match node.ifc_type {
            IfcType::IfcMappedItem=>{
                let (Some(source),Some(target))=(node.ref_at(slot::IfcMappedItem::MAPPING_SOURCE),node.ref_at(slot::IfcMappedItem::MAPPING_TARGET)) else {
                    return Err(format!("mapped item #{id} has no source or target"))
                };
                let (map,items)=mapping(d,source,target).ok_or_else(||format!("mapped item #{id}: unsupported operator, degenerate axes or missing origin"))?;
                affine|=nonrigid(&map);
                pending.extend(items.into_iter().map(|item|(item,depth+1)));
            }
            IfcType::IfcBooleanResult|IfcType::IfcBooleanClippingResult=>{
                for operand in [slot::IfcBooleanResult::FIRST_OPERAND,slot::IfcBooleanResult::SECOND_OPERAND] {
                    pending.push((node.ref_at(operand).ok_or_else(||format!("Boolean #{id} operand unavailable"))?,depth+1));
                }
            }
            IfcType::IfcCsgSolid=>pending.push((node.ref_at(slot::IfcCsgSolid::TREE_ROOT_EXPRESSION).ok_or_else(||format!("CSG solid #{id} root unavailable"))?,depth+1)),
            _=>{}
        }
    }
    Ok(affine)
}
/// Per published part: the mesh is outward-wound in world space. Retained publication keeps
/// `world_from_object` proper-rigid (det = +1): `bake()` in `program/mapping_affine.rs` turns any
/// other object frame into an Affine operation, `affine_final::bake` asserts `rigid()` and publishes
/// only a translation on top, and `require_frame` refuses det <= 0 at presentation. The local signed
/// volume therefore is the world one. The determinant is still applied (a mirrored frame flips it),
/// and a singular or nonfinite frame cannot certify anything, so it fails closed.
pub fn winding_positive(parts:&[crate::ShapePart]) -> Vec<bool> {
    parts.iter().map(|part|{
        let m=&part.world_from_object;
        let det=dot([m[0],m[1],m[2]],cross([m[4],m[5],m[6]],[m[8],m[9],m[10]]));
        det.is_finite()&&det!=0.
            &&mesh_moments(&part.positions,&part.indices,m).is_some_and(|v|v.0*det.signum()>0.)
    }).collect()
}
/// The classification the winding gate keys on; see `scan` for what fails closed.
pub(super) fn classify(d:&mut EntityDecoder<'_>,id:u32) -> Classification {
    match scan(d,id) {
        Ok(true) => Classification::Affine,
        Ok(false) => Classification::Rigid,
        Err(reason) => Classification::Unmodelled(reason),
    }
}
