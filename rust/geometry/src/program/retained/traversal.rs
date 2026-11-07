// SPDX-License-Identifier: MPL-2.0
//! Retained program roots sharing one source and resource domain.
use super::*;
impl RetainedTraversal {
    #[cfg(feature = "retained-runtime")]
    pub(crate) fn layer_bands(&self, host: RetainedProductPlan, spec: layer_family::LayerSpec)
        -> std::result::Result<RetainedProgram<'static>, RetainedFailure> {
        let selection = self.selection.as_ref().ok_or(RetainedProgramError::Unsupported)?.for_root();
        crate::resource::charge(crate::resource::Cost { live_bytes: std::mem::size_of::<layers::LayerBands>() as u64,
            ..Default::default() }).map_err(RetainedFailure::Stopped)?.retain();
        let layers = layers::LayerBands::new(selection, next_program_id(), host, spec)?;
        Ok(RetainedProgram { inner: RetainedInner::Layers(Box::new(layers)), cancelled: false, unsupported: false })
    }

    pub(crate) fn new(contract: RetainedContract) -> Self {
        Self { selection: RetainedSelection::new(contract,next_program_id()) }
    }
    #[cfg(feature = "retained-runtime")]
    pub(crate) fn opening_cuts(&self, host: RetainedProductPlan, cutters: Vec<(u32, RetainedProductPlan)>)
        -> std::result::Result<RetainedProgram<'static>, RetainedFailure> {
        let selection = self.selection.as_ref().ok_or(RetainedProgramError::Unsupported)?.for_root();
        crate::resource::charge(crate::resource::Cost {
            live_bytes: std::mem::size_of::<openings::OpeningCuts>() as u64, ..Default::default()
        }).map_err(RetainedFailure::Stopped)?.retain();
        let cuts = openings::OpeningCuts::new(selection, next_program_id(), host, cutters)?;
        Ok(RetainedProgram { inner: RetainedInner::Cuts(Box::new(cuts)), cancelled: false, unsupported: false })
    }
    pub(crate) fn product_parts<'a>(&self, element: &'a DecodedEntity) -> RetainedProgram<'a> {
        let id = next_program_id();
        let selection = self.selection.as_ref().map(RetainedSelection::for_root);
        let unsupported = selection.is_none();
        let control = match selection {
            Some(selection) => ProductControl::retained(element, selection),
            None => {
                ProductControl::merged(element, crate::router::processing::SourceHygiene::IndexOnly)
            }
        };
        let mut inner = GeometryProgram::with_control(Control::Product(control));
        inner.id = id;
        RetainedProgram { inner: RetainedInner::Geometry(inner), cancelled: false, unsupported }
    }
    pub(crate) fn product_submeshes<'a>(&self, element: &'a DecodedEntity, allow_instancing: bool,
        textures: Option<&'a rustc_hash::FxHashMap<u32, crate::ResolvedTextureMap>>) -> RetainedProgram<'a> {
        let mut program = self.product_parts(element);
        if let RetainedInner::Geometry(inner) = &mut program.inner {
        if let Control::Product(control) = &mut inner.control {
            control.select_retained_styled(allow_instancing, textures);
        }
        }
        program
    }
    pub(crate) fn type_map<'a>(&self, rep_map: DecodedEntity,
        textures: Option<&'a rustc_hash::FxHashMap<u32, crate::ResolvedTextureMap>>) -> RetainedProgram<'a> {
        let id = next_program_id();
        let selection = self.selection.as_ref().map(RetainedSelection::for_root);
        let unsupported = selection.is_none();
        let control = match selection {
            Some(selection) => crate::program::mapping::MappingControl::retained_type_map(rep_map,textures,selection),
            None => {
                // Default wasm has no retained selection. Keep this root inert
                // without borrowing a temporary or constructing numerical authority.
                crate::program::mapping::MappingControl::occurrence(
                    crate::program::mapping::Reached::Nested(rep_map))
            }
        };
        let mut inner = GeometryProgram::with_control(Control::Mapping(control));
        inner.id = id;
        RetainedProgram { inner: RetainedInner::Geometry(inner), cancelled: false, unsupported }
    }
 }
