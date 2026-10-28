// SPDX-License-Identifier: MPL-2.0
//! Independent IFC plane-chain oracle. Never reads a retained cutter recipe.
use super::{math::{dot, sub}, sections::{section_volume, ExtrudedHost}};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType, SourceBundle, slot};
use ifc_lite_geometry::{Matrix4, Point3, Vector3, placement::{Axis2Placement, resolve_object_placement},
    representation::{product_shape, rep_items, MappedLevel, Select}};
use ifc_lite_processing::AnalyticQuantitySources;
use std::{collections::HashSet, sync::Arc};

#[derive(Clone, Debug)]
pub struct Plane { pub entity: u32, pub point: [f64; 3], pub normal: [f64; 3] }
impl Plane {
    pub fn excess(&self, point: [f64; 3]) -> f64 { dot(self.normal, sub(point, self.point)).max(0.) }
    fn equation(&self) -> ([f64; 3], f64) { (self.normal, dot(self.normal, self.point)) }
}
#[derive(Debug)]
pub struct ClipPart {
    pub planes: Vec<Plane>,
    pub host_volume: Option<f64>,
    pub section_volume: Option<f64>,
    pub curved: bool,
    pub mixed: bool,
}
#[derive(Debug)]
pub struct ClipExpectation { pub parts: Vec<ClipPart> }
impl ClipExpectation {
    pub fn section_volume(&self) -> Option<f64> { self.parts.iter().try_fold(0., |v,p| Some(v+p.section_volume?)) }
    pub fn host_volume(&self) -> Option<f64> { self.parts.iter().try_fold(0., |v,p| Some(v+p.host_volume?)) }
    pub fn curved(&self) -> bool { self.parts.iter().any(|p| p.curved) }
}
fn reference(entity: &DecodedEntity, index: usize, decoder: &mut EntityDecoder) -> Result<DecodedEntity, String> {
    decoder.resolve_ref(entity.get(index).ok_or_else(|| format!("#{} missing attribute {index}", entity.id))?)
        .map_err(|e| e.to_string())?.ok_or_else(|| format!("#{} unresolved attribute {index}", entity.id))
}
fn plane(entity: &DecodedEntity, world: &Matrix4<f64>, decoder: &mut EntityDecoder) -> Result<Plane, String> {
    let surface = reference(entity, slot::IfcHalfSpaceSolid::BASE_SURFACE.index(), decoder)?;
    if surface.ifc_type != IfcType::IfcPlane { return Err("clip oracle requires IfcPlane".into()); }
    let position = reference(&surface, slot::IfcPlane::POSITION.index(), decoder)?;
    let local = Axis2Placement::read_3d(&position, decoder).map_err(|e| e.to_string())?.matrix();
    let p = world.transform_point(&Point3::new(local[(0,3)],local[(1,3)],local[(2,3)]));
    let normal = Vector3::new(local[(0,2)],local[(1,2)],local[(2,2)]);
    // Independent source decode, including IFC's omitted-flag default. Do not
    // call HalfSpacePlan, plane_source, halfspace_box or any retained lowering.
    let sign = if entity.get_bool(slot::IfcHalfSpaceSolid::AGREEMENT_FLAG.index()).unwrap_or(true) { -1. } else { 1. };
    let inverse = world.try_inverse().ok_or("singular clip source frame")?;
    let r = inverse.transpose().transform_vector(&(normal * sign)).normalize();
    if p.iter().chain(r.iter()).any(|v| !v.is_finite()) { return Err("nonfinite clip plane".into()); }
    Ok(Plane { entity: entity.id, point: [p.x,p.y,p.z], normal: [r.x,r.y,r.z] })
}
/// Walk one FirstOperand spine iteratively. Mapping expands only one host
/// value here; branching maps cannot be Boolean operands in the retained path.
fn part(mut current: DecodedEntity, mut world: Matrix4<f64>, sources: &AnalyticQuantitySources,
    product: u32, decoder: &mut EntityDecoder) -> Result<ClipPart, String> {
    let mut visited = HashSet::new(); let mut planes = Vec::new(); let mut mixed = false;
    for _ in 0..4096 {
        if !visited.insert(current.id) { return Err("cyclic clip source spine".into()); }
        match current.ifc_type {
            IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult => {
                let difference = current.get_enum(slot::IfcBooleanResult::OPERATOR.index()) == Some("DIFFERENCE");
                let right = reference(&current, slot::IfcBooleanResult::SECOND_OPERAND.index(), decoder)?;
                if right.ifc_type == IfcType::IfcHalfSpaceSolid {
                    if !difference { return Err("published non-Difference halfspace".into()); }
                    planes.push(plane(&right, &world, decoder)?);
                } else {
                    // A later Union could reintroduce material behind an earlier
                    // clip. Do not apply a kept-side predicate to that union.
                    if !difference { return Ok(ClipPart { planes: Vec::new(),host_volume:None,section_volume:None,curved:true,mixed:true }); }
                    mixed = true;
                }
                current = reference(&current, slot::IfcBooleanResult::FIRST_OPERAND.index(), decoder)?;
            }
            IfcType::IfcCsgSolid => current = reference(&current, 0, decoder)?,
            IfcType::IfcMappedItem => {
                let map = reference(&current, 0, decoder)?;
                let mapped_rep = reference(&map, 1, decoder)?;
                let level = MappedLevel { item:current, map, mapped_rep };
                if let Some(local) = level.local_transform(decoder).map_err(|e| e.to_string())? { world *= local; }
                let mut items = rep_items(&level.mapped_rep, decoder).map_err(|e| format!("{e:?}"))?;
                if items.len()!=1 { return Err("clip oracle requires a single mapped Boolean host".into()); }
                current = items.pop().unwrap();
            }
            _ => {
                let instance = sources.extrusion_definitions.instances.get(&product)
                    .and_then(|items| items.iter().find(|i| i.solid_id==current.id));
                let instance = instance.cloned().map(|mut i| {
                    i.world_from_source = Some(std::array::from_fn(|k| world[(k%4,k/4)])); i
                });
                let host = instance.as_ref().and_then(|i| ExtrudedHost::from_sources(sources,i));
                let curved = instance.as_ref().and_then(|i| sources.extrusion_definitions.sources.iter().find(|s|s.key==i.source))
                    .and_then(|s|s.source.profile.as_ref()).is_none_or(|p|p.loops.iter().flat_map(|l|&l.segments)
                        .any(|s|!matches!(s,ifc_lite_geometry::analytic::AnalyticCurveSegment::Line{..})));
                let host_volume = host.as_ref().and_then(|h| section_volume(h,&[]));
                let section_volume = if mixed {None} else {host.as_ref().and_then(|h| section_volume(h,&planes.iter().map(Plane::equation).collect::<Vec<_>>()))};
                return Ok(ClipPart {planes,host_volume,section_volume,curved,mixed});
            }
        }
    }
    Err("clip oracle spine work budget exhausted".into())
}
/// `None` means no supported plain-plane clip was found, not a zero-volume
/// expectation. A discovered but unsupported oracle remains explicit in parts.
pub fn expected(model: &Arc<SourceBundle>, sources: &AnalyticQuantitySources, product: u32)
    -> Result<Option<ClipExpectation>, String> {
    let mut decoder = model.decoder();
    let element = decoder.decode_by_id(product).map_err(|e| e.to_string())?;
    let Some(shape) = product_shape(&element,&mut decoder).map_err(|e|format!("{e:?}"))? else {return Ok(None)};
    let mut world = resolve_object_placement(&element,&mut decoder).map_err(|e|e.to_string())?.unwrap_or_else(Matrix4::identity);
    let scale = sources.extrusion_definitions.length_unit_scale;
    for i in 0..3 { for j in 0..4 { world[(i,j)] *= scale; } }
    let mut parts = Vec::new();
    let mut pending = Vec::new();
    for rep in shape.select(&element,Select::Meshed) {
        for item in rep_items(rep,&mut decoder).map_err(|e|format!("{e:?}"))? {
            pending.push((item,world,Vec::<u32>::new()));
        }
    }
    pending.reverse();
    let mut work = 0;
    while let Some((item,frame,mut path)) = pending.pop() {
        work += 1;
        if work > 4096 { return Err("clip oracle part budget exhausted".into()); }
        if item.ifc_type == IfcType::IfcMappedItem {
            if path.contains(&item.id) { return Err("cyclic clip mapping source".into()); }
            path.push(item.id);
            let map = reference(&item,0,&mut decoder)?;
            let mapped_rep = reference(&map,1,&mut decoder)?;
            let level = MappedLevel {item,map,mapped_rep};
            let frame = frame * level.local_transform(&mut decoder).map_err(|e|e.to_string())?.unwrap_or_else(Matrix4::identity);
            let items = rep_items(&level.mapped_rep,&mut decoder).map_err(|e|format!("{e:?}"))?;
            if pending.len()+items.len()>4096 { return Err("clip oracle pending budget exhausted".into()); }
            for child in items.into_iter().rev() { pending.push((child,frame,path.clone())); }
        } else {
            parts.push(part(item,frame,sources,product,&mut decoder)?);
        }
    }
    if parts.iter().all(|p|p.planes.is_empty()) { Ok(None) } else { Ok(Some(ClipExpectation {parts})) }
}
