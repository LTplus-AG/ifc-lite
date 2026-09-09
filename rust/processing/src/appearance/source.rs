// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use ifc_lite_core::{AttributeValue as A, DecodedEntity, EntityDecoder, EntityScanner, IfcType};
use std::collections::{BTreeMap, BTreeSet};

pub(super) const MAX_VALUES: usize = 8_000_000;
pub(super) struct Source<'a> {
    pub context: Option<super::context::Context>,
    pub decoder: EntityDecoder<'a>,
    pub types: BTreeMap<u32, IfcType>,
    pub incoming: BTreeMap<u32, BTreeSet<u32>>,
    pub texture_maps: BTreeMap<u32, Vec<u32>>,
    pub styled_items: BTreeMap<u32, Vec<u32>>,
    pub voided: BTreeSet<u32>,
    pub style_assignments: BTreeSet<u32>,
}
impl<'a> Source<'a> {
    pub fn new(bytes: &'a [u8]) -> Result<Self, String> {
        if bytes.len() > 128 * 1024 * 1024 {
            return Err("Appearance source exceeds 128 MiB budget".into());
        }
        let mut source = Self {
            context: None,
            decoder: EntityDecoder::new(bytes),
            types: BTreeMap::new(),
            incoming: BTreeMap::new(),
            texture_maps: BTreeMap::new(),
            styled_items: BTreeMap::new(),
            voided: BTreeSet::new(),
            style_assignments: BTreeSet::new(),
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
            source.types.insert(id, entity.ifc_type);
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
                    _ => {}
                }
            }
            if name == "IFCPRESENTATIONSTYLEASSIGNMENT" { source.style_assignments.insert(id); }
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
        if self.voided.contains(&product) {
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
                if self.types.get(&item) != Some(&IfcType::IfcTriangulatedFaceSet) {
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
