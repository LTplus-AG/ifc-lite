// SPDX-License-Identifier: MPL-2.0
//! Independent IFC plane-chain oracle. Never reads a retained cutter recipe.
use super::{math::{dot, sub}, sections::{section_volume, ExtrudedHost}};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType, SourceBundle, slot};
use ifc_lite_geometry::{Matrix4, Point3, Vector3, placement::{Axis2Placement, resolve_object_placement},
    representation::{product_shape, rep_items, MappedLevel, Select}};
use ifc_lite_processing::AnalyticQuantitySources;
use std::{collections::HashSet, sync::Arc};
#[path = "clip_openings.rs"]
mod openings;

#[derive(Clone, Debug)]
pub struct Plane { pub entity: u32, pub point: [f64; 3], pub normal: [f64; 3] }
impl Plane {
    pub fn excess(&self, point: [f64; 3]) -> f64 { dot(self.normal, sub(point, self.point)).max(0.) }
    fn equation(&self) -> ([f64; 3], f64) { (self.normal, dot(self.normal, self.point)) }
}
pub struct ClipPart {
    host: Option<ExtrudedHost>,
    pub planes: Vec<Plane>,
    pub host_volume: Option<f64>,
    pub section_volume: Option<f64>,
    pub curved: bool,
    pub mixed: bool,
}
pub struct ClipExpectation { pub parts: Vec<ClipPart> }
impl ClipExpectation {
    pub fn section_volume(&self) -> Option<f64> { self.parts.iter().try_fold(0., |v,p| Some(v+p.section_volume?)) }
    pub fn host_volume(&self) -> Option<f64> { self.parts.iter().try_fold(0., |v,p| Some(v+p.host_volume?)) }

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
    // Exact (and therefore retained) defaults an unreadable AgreementFlag to
    // TRUE. The oracle must flag this invalid mandatory source independently.
    let agreement = entity.get_bool(slot::IfcHalfSpaceSolid::AGREEMENT_FLAG.index())
        .ok_or_else(|| format!("#{} invalid AgreementFlag", entity.id))?;
    let sign = if agreement { -1. } else { 1. };
    let inverse = world.try_inverse().ok_or("singular clip source frame")?;
    // A normal is a covector. Only the linear inverse-transpose applies;
    // Matrix4::transform_vector performs projective division using row 4,
    // which is nonzero after transposing a translated affine inverse.
    let r = (inverse.fixed_view::<3,3>(0,0).transpose() * (normal * sign)).normalize();
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
                    // We walk outside-in: collected planes execute AFTER this
                    // subtree, so all remain valid constraints on its result.
                    // Its volume/curvature are unknown; expose that limitation.
                    if !difference { return Ok(ClipPart { host:None, planes,host_volume:None,section_volume:None,curved:false,mixed:true }); }
                    mixed = true;
                }
                current = reference(&current, slot::IfcBooleanResult::FIRST_OPERAND.index(), decoder)?;
            }
            IfcType::IfcCsgSolid => current = reference(&current, slot::IfcCsgSolid::TREE_ROOT_EXPRESSION.index(), decoder)?,
            IfcType::IfcMappedItem => {
                let map = reference(&current, slot::IfcMappedItem::MAPPING_SOURCE.index(), decoder)?;
                let mapped_rep = reference(&map, slot::IfcRepresentationMap::MAPPED_REPRESENTATION.index(), decoder)?;
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
                    .and_then(|s|s.source.profile.as_ref()).is_some_and(|p|p.loops.iter().flat_map(|l|&l.segments)
                        .any(|s|!matches!(s,ifc_lite_geometry::analytic::AnalyticCurveSegment::Line{..})));
                let host_volume = host.as_ref().and_then(|h| section_volume(h,&[]));
                let section_volume = if mixed {None} else {host.as_ref().and_then(|h| section_volume(h,&planes.iter().map(Plane::equation).collect::<Vec<_>>()))};
                return Ok(ClipPart {host,planes,host_volume,section_volume,curved,mixed});
            }
        }
    }
    Err("clip oracle spine work budget exhausted".into())
}
// Source traversal only: opening extraction reuses this without recursively
// following void relationships. Cycles and expansion have the same work bound.
fn source_parts(model: &Arc<SourceBundle>, sources: &AnalyticQuantitySources, product: u32)
    -> Result<Vec<ClipPart>, String> {
    let mut decoder = model.decoder();
    let element = decoder.decode_by_id(product).map_err(|e| e.to_string())?;
    // IfcTypeProduct owns RepresentationMaps, not an occurrence's shape chain.
    // Its independent type-map oracle supplies the source gates (M9).
    if !element.ifc_type.is_subtype_of(IfcType::IfcProduct) { return Ok(Vec::new()); }
    let Some(shape) = product_shape(&element,&mut decoder).map_err(|e|format!("{e:?}"))? else {return Ok(Vec::new())};
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
            let map = reference(&item,slot::IfcMappedItem::MAPPING_SOURCE.index(),&mut decoder)?;
            let mapped_rep = reference(&map,slot::IfcRepresentationMap::MAPPED_REPRESENTATION.index(),&mut decoder)?;
            let level = MappedLevel {item,map,mapped_rep};
            let frame = frame * level.local_transform(&mut decoder).map_err(|e|e.to_string())?.unwrap_or_else(Matrix4::identity);
            let items = rep_items(&level.mapped_rep,&mut decoder).map_err(|e|format!("{e:?}"))?;
            if pending.len()+items.len()>4096 { return Err("clip oracle pending budget exhausted".into()); }
            for child in items.into_iter().rev() { pending.push((child,frame,path.clone())); }
        } else {
            parts.push(part(item,frame,sources,product,&mut decoder)?);
        }
    }
    Ok(parts)
}
/// Model-scoped source oracle. Relationship extraction runs once, not once per
/// clipped product. The cache borrows the source so it cannot outlive its model.
pub struct ClipOracle<'a> {
    model: &'a Arc<SourceBundle>,
    sources: &'a AnalyticQuantitySources,
    openings: std::collections::BTreeMap<u32, Vec<u32>>,
}
impl<'a> ClipOracle<'a> {
    pub fn new(model: &'a Arc<SourceBundle>, sources: &'a AnalyticQuantitySources) -> Self {
        Self { model, sources, openings: openings::index(model) }
    }
    /// A supported outer plane always supplies kept-side and closure gates,
    /// including when a mixed subtree has no independent volume prediction.
    pub fn expected(&self, product: u32) -> Result<Option<ClipExpectation>, String> {
        let mut parts=source_parts(self.model,self.sources,product)?;
        if parts.iter().all(|p|p.planes.is_empty()) { return Ok(None); }
        let cuts=openings::cutters(self.model,self.sources,self.openings.get(&product).map_or(&[],Vec::as_slice))?;
        if !cuts.is_empty() {
            for part in &mut parts {
                part.section_volume=if part.mixed {None} else {part.host.as_ref().and_then(|h|openings::net_volume(h,&part.planes,&cuts))};
            }
        }
        Ok(Some(ClipExpectation {parts}))
    }
}
