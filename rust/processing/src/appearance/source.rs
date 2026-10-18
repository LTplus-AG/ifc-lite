// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use ifc_lite_core::{keyword_eq, AttributeValue as A, DecodedEntity, EntityDecoder, EntityScanner, IfcType};
use ifc_lite_geometry::ResolvedTextureMap;
use rustc_hash::FxHashMap;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

pub(super) const MAX_VALUES: usize = 8_000_000;
/// A face-masked evaluated Body: only `textured` receives the appearance while
/// `retained` keeps the source style under the same wrapper (#4404).
#[derive(Clone, Copy)]
pub(super) struct SplitBody {
    pub textured: u32,
    pub retained: u32,
}
pub(super) struct Source<'a> {
    pub production_model: crate::element::ProductionModel,
    pub production_identity: usize,
    pub empty_styles: super::owned_context::Styles,
    pub context: Option<super::context::Context>,
    pub decoder: EntityDecoder<'a>,
    pub types: BTreeMap<u32, IfcType>,
    pub incoming: BTreeMap<u32, BTreeSet<u32>>,
    pub texture_maps: BTreeMap<u32, Vec<u32>>,
    pub styled_items: BTreeMap<u32, Vec<u32>>,
    pub voided: BTreeSet<u32>,
    pub style_assignments: BTreeSet<u32>,
    /// Private normalization state keyed by product; empty outside conversions.
    pub evaluated_splits: BTreeMap<u32, SplitBody>,
    /// The surface-texture index, built once per session (see
    /// [`Self::texture_index`]).
    texture_index: Option<Arc<FxHashMap<u32, ResolvedTextureMap>>>,
}
impl<'a> Source<'a> {
    /// The model's surface-texture index, built on first use and shared by
    /// every later caller of this session. Each build decodes every texture
    /// and counts each refused binary, so building it per planning stage
    /// decoded a shared image up to three times and counted one bad texture
    /// as many (F4-1 follow-up, #7776).
    pub fn texture_index(&mut self, bytes: &[u8]) -> Arc<FxHashMap<u32, ResolvedTextureMap>> {
        let decoder = &mut self.decoder;
        Arc::clone(self.texture_index.get_or_insert_with(|| {
            Arc::new(ifc_lite_geometry::build_texture_index(bytes, decoder))
        }))
    }

    pub fn new(bytes: &'a [u8]) -> Result<Self, String> {
        if bytes.len() > 128 * 1024 * 1024 {
            return Err("Appearance source exceeds 128 MiB budget".into());
        }
        let mut source = Self {
            production_model: crate::element::ProductionModel::new(),
            production_identity: super::owned_context::source_identity(),
            empty_styles: super::owned_context::Styles::default(),
            context: None,
            decoder: EntityDecoder::new(bytes),
            types: BTreeMap::new(),
            incoming: BTreeMap::new(),
            texture_maps: BTreeMap::new(),
            styled_items: BTreeMap::new(),
            voided: BTreeSet::new(),
            style_assignments: BTreeSet::new(),
            evaluated_splits: BTreeMap::new(),
            texture_index: None,
        };
        let mut scanner = EntityScanner::new(bytes);
        let mut work = 0;
        while let Some((id, name, start, end)) = scanner.next_entity() {
            if source.types.len() >= 200_000 {
                return Err("Appearance entity budget exceeded".into());
            }
            if source.types.contains_key(&id) {
                return Err("Duplicate source express id".into());
            }
            let entity = source
                .decoder
                .decode_at_with_id(id, start, end)
                .map_err(|e| e.to_string())?;
            source.types.insert(id, entity.ifc_type.clone());
            let mut stack: Vec<&A> = entity.attributes.iter().collect();
            while let Some(value) = stack.pop() {
                work += 1;
                if work > MAX_VALUES {
                    return Err("Appearance reference work budget exceeded".into());
                }
                match value {
                    A::EntityRef(target) => {
                        source.incoming.entry(*target).or_default().insert(id);
                    }
                    A::List(values) => stack.extend(values.iter()),
                    A::Typed { value, .. } => stack.push(value),
                    _ => {}
                }
            }
            if keyword_eq(name, "IFCPRESENTATIONSTYLEASSIGNMENT") { source.style_assignments.insert(id); }
            match entity.ifc_type {
                IfcType::IfcIndexedTriangleTextureMap => {
                    if let Some(item) = entity.get_ref(1) {
                        source.texture_maps.entry(item).or_default().push(id);
                    }
                }
                IfcType::IfcStyledItem => {
                    if let Some(item) = entity.get_ref(0) {
                        source.styled_items.entry(item).or_default().push(id);
                    }
                }
                IfcType::IfcRelVoidsElement => {
                    if let Some(product) = entity.get_ref(4) {
                        source.voided.insert(product);
                    }
                }
                _ => {}
            }
        }
        source.context = Some(super::context::Context::new(bytes, &mut source.decoder));
        Ok(source)
    }
    pub fn entity(&mut self, id: u32) -> Result<DecodedEntity, String> {
        self.decoder.decode_by_id(id).map_err(|e| e.to_string())
    }
    /// Check completeness before using the canonical resolver, whose load-time
    /// recovery intentionally returns a truncated transform for bad files.
    pub fn validate_world_placement(&mut self, product: &DecodedEntity) -> Result<(), String> {
        let mut next = match product.get(5) {
            None | Some(A::Null) => None,
            value => Some(
                value
                    .and_then(A::as_entity_ref)
                    .ok_or("Invalid ObjectPlacement")?,
            ),
        };
        let mut visited = BTreeSet::new();
        while let Some(id) = next {
            if !visited.insert(id) || visited.len() > ifc_lite_core::MAX_PLACEMENT_DEPTH {
                return Err("World projection placement cycle/depth limit".into());
            }
            let placement = self.entity(id)?;
            if placement.ifc_type != IfcType::IfcLocalPlacement {
                return Err("Appearance authoring currently supports only local placement chains".into());
            }
            let axes = self.entity(placement.get_ref(1).ok_or("Missing RelativePlacement")?)?;
            if !matches!(
                axes.ifc_type,
                IfcType::IfcAxis2Placement3D | IfcType::IfcAxis2Placement2D
            ) {
                return Err("Invalid RelativePlacement type".into());
            }
            next = match placement.get(0) {
                None | Some(A::Null) => None,
                value => Some(
                    value
                        .and_then(A::as_entity_ref)
                        .ok_or("Invalid PlacementRelTo")?,
                ),
            };
        }
        Ok(())
    }
    pub fn single_parent(&self, id: u32, parent: u32) -> bool {
        self.incoming
            .get(&id)
            .is_some_and(|parents| parents.len() == 1 && parents.contains(&parent))
    }
    fn is_layer(&self, id: &u32) -> bool {
        self.types
            .get(id)
            .is_some_and(|t| t.is_subtype_of(IfcType::IfcPresentationLayerAssignment))
    }
    fn single_geometry_owner(&self, id: u32, parent: u32) -> bool {
        self.incoming.get(&id).is_some_and(|parents| {
            parents.contains(&parent) && parents.iter().all(|id| *id == parent || self.is_layer(id))
        })
    }
    /// Fixed-depth direct product -> PDS -> Body representation -> face set.
    /// Shared/mapped graphs are refused, rather than accidentally editing another owner.
    pub fn product_items(&mut self, product: u32) -> Result<Vec<u32>, String> {
        if self.voided.contains(&product) && !super::evaluated_openings::reference_only(self, product)? {
            return Err("CSG/opening-cut geometry is unsupported".into());
        }
        let entity = self.entity(product)?;
        if !entity.ifc_type.is_subtype_of(IfcType::IfcProduct) {
            return Err("Target is not an IfcProduct".into());
        }
        let pds_id = entity
            .get_ref(6)
            .ok_or("Product has no direct representation")?;
        let pds = self.entity(pds_id)?;
        if pds.ifc_type != IfcType::IfcProductDefinitionShape
            || !self.single_parent(pds_id, product)
        {
            return Err("Shared or unsupported product representation".into());
        }
        let mut items = BTreeSet::new();
        for rep_id in refs(pds.get(2))? {
            let rep = self.entity(rep_id)?;
            if rep.ifc_type != IfcType::IfcShapeRepresentation {
                return Err("Unsupported representation".into());
            }
            let identifier = rep.get(1).and_then(A::as_string).unwrap_or("");
            if !identifier.eq_ignore_ascii_case("Body") {
                continue;
            }
            if !self.single_geometry_owner(rep_id, pds_id) {
                return Err("Shared/mapped representation is unsupported".into());
            }
            for item in refs(rep.get(3))? {
                // IfcTriangulatedIrregularNetwork (a terrain TIN, #5942) is a
                // subtype that only APPENDS `Flags`: Coordinates, Normals,
                // Closed, CoordIndex and PnIndex keep positions 0-4, the only
                // ones mapping and canonical meshing read.
                if !matches!(
                    self.types.get(&item),
                    Some(IfcType::IfcTriangulatedFaceSet | IfcType::IfcTriangulatedIrregularNetwork)
                ) {
                    return Err("Only direct IfcTriangulatedFaceSet bodies are supported".into());
                }
                if let Some(parents) = self.incoming.get(&item) {
                    if parents.iter().any(|p| {
                        *p != rep_id
                            && !self.is_layer(p)
                            && !self
                                .texture_maps
                                .get(&item)
                                .is_some_and(|ids| ids.contains(p))
                            && !self
                                .styled_items
                                .get(&item)
                                .is_some_and(|ids| ids.contains(p))
                    }) {
                        return Err("Face set is shared with another representation".into());
                    }
                }
                if self
                    .styled_items
                    .get(&item)
                    .is_some_and(|ids| ids.len() > 1)
                {
                    return Err("Multiple IfcStyledItem records on one item".into());
                }
                for dependency in self
                    .styled_items
                    .get(&item)
                    .into_iter()
                    .flatten()
                    .chain(self.texture_maps.get(&item).into_iter().flatten())
                {
                    if self
                        .incoming
                        .get(dependency)
                        .is_some_and(|ids| !ids.is_empty())
                    {
                        return Err("Appearance association is referenced by another entity".into());
                    }
                }
                items.insert(item);
            }
        }
        if items.is_empty() {
            return Err("No direct tessellated Body representation".into());
        }
        // A masked conversion textures only its selected face set; the retained
        // face set is a sibling item the appearance pass must leave untouched.
        if let Some(split) = self.evaluated_splits.get(&product) {
            if !items.contains(&split.textured) || !items.contains(&split.retained) {
                return Err("Masked evaluated Body lost one of its face sets".into());
            }
            return Ok(vec![split.textured]);
        }
        Ok(items.into_iter().collect())
    }
}
pub(super) fn refs(value: Option<&A>) -> Result<Vec<u32>, String> {
    value
        .and_then(A::as_list)
        .ok_or("Expected reference list")?
        .iter()
        .map(|v| {
            v.as_entity_ref()
                .ok_or_else(|| "Invalid reference list".into())
        })
        .collect()
}
pub(super) fn numbers<const N: usize>(value: &A) -> Result<[f64; N], String> {
    let list = value.as_list().ok_or("Expected numeric tuple")?;
    if list.len() != N {
        return Err("Invalid tuple length".into());
    }
    let mut out = [0.; N];
    for (target, v) in out.iter_mut().zip(list) {
        *target = v
            .as_float()
            .filter(|n| n.is_finite())
            .ok_or("Non-finite coordinate")?;
    }
    Ok(out)
}

#[cfg(test)]
mod texture_index_tests {
    use super::Source;
    use std::sync::Arc;

    /// A textured model with one bad (not byte-aligned) pixel binary.
    const MODEL: &str = "ISO-10303-21;\nDATA;\n\
        #1=IFCPIXELTEXTURE(.T.,.T.,'MODULATE',$,$,1,1,3,(\"1FF0000\"));\n\
        #2=IFCTEXTUREVERTEXLIST(((0.,0.),(1.,0.),(0.,1.)));\n\
        #5=IFCINDEXEDTRIANGLETEXTUREMAP((#1),#4,#2,((1,2,3)));\n\
        ENDSEC;\nEND-ISO-10303-21;\n";

    /// F4-1 follow-up (#7776): one session builds the texture index once, so a
    /// shared image is decoded once and a bad texture is counted once.
    #[test]
    fn a_session_builds_the_texture_index_once_7776() {
        let mut source = Source::new(MODEL.as_bytes()).unwrap();
        let first = source.texture_index(MODEL.as_bytes());
        let second = source.texture_index(MODEL.as_bytes());
        assert!(Arc::ptr_eq(&first, &second));
    }
}
