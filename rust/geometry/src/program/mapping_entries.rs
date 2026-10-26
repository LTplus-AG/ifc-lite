// SPDX-License-Identifier: MPL-2.0
//! Constructors for the common mapping control.
use super::*;
impl<'a> MappingControl<'a> {
    pub(super) fn new(walk: Walk, action: Action<'a>) -> Self {
        Self {
            retained: None,
            walk,
            textures: None,
            rep_map: None,
            allow_instancing: false,
            meshes: SubMeshCollection::new(),
            textured: Vec::new(),
            levels: Vec::new(),
            action,
        }
    }

    pub(in crate::program) fn occurrence(item: Reached<'a>) -> Self {
        Self::new(Walk::Occurrence, Action::Enter(item))
    }

    #[cfg(test)]
    pub(in crate::program) fn shared_source(representation: &'a DecodedEntity, source_id: u32) -> Self {
        Self::new(Walk::Shared, Action::SharedItems(Reached::Root(representation), source_id, None))
    }

    /// One styled representation item, appending to `meshes`. A plain item
    /// is meshed under its own id; a mapped item walks its source.
    pub(in crate::program) fn styled(root: Reached<'a>, meshes: SubMeshCollection, allow_instancing: bool,
        textures: Textures<'a>, offset: (f64, f64, f64)) -> Self {
        let item = root.item();
        let action = if item.ifc_type == ifc_lite_core::IfcType::IfcMappedItem {
            Action::EnterStyled(root)
        } else if textures.is_some_and(|index| index.contains_key(&item.id)) {
            Action::Texture(root)
        } else {
            Action::Child(root, ChildControl::Cache(CacheControl::new(offset)))
        };
        Self { textures, allow_instancing, meshes, ..Self::new(Walk::Styled, action) }
    }

    pub(in crate::program) fn type_map(rep_map: &'a DecodedEntity, textures: &'a FxHashMap<u32, ResolvedTextureMap>) -> Self {
        Self { textures: Some(textures), rep_map: Some(Reached::Root(rep_map)), ..Self::new(Walk::TypeMap, Action::EnterTypeMap) }
    }

}
