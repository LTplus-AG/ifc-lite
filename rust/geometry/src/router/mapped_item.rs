// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcMappedItem` source resolution: caching, bounded owned continuations,
//! and merging an `IfcRepresentationMap`'s items into one source-coords mesh
//! per f64 frame (#6446).
//! Split out of `processing.rs` to stay within its module-size budget (#3691).

use super::frame_parts::single_frame_source;
use super::GeometryRouter;
use crate::{Mesh, Result};
#[cfg(test)]
use crate::SubMeshCollection;
use ifc_lite_core::{DecodedEntity, EntityDecoder};

use crate::program::GeometryProgram;

impl GeometryRouter {
    /// Reached cache effects of the common mapping child program. Lookup and
    /// publication keep their historical lock scope and degraded-source policy.
    pub(crate) fn cached_mapped_source(&self, id: u32) -> Option<std::sync::Arc<Mesh>> {
        match &self.shared_mapped_item_cache {
            Some(shared) => shared.lock().unwrap_or_else(|e| e.into_inner()).get(&id).cloned(),
            None => self.mapped_item_cache.borrow().get(&id).cloned(),
        }
    }

    pub(crate) fn publish_mapped_source(&self, id: u32, mesh: &Mesh, truncated: bool) -> Result<()> {
        crate::resource::check_current()?;
        match &self.shared_mapped_item_cache {
            Some(shared) => {
                if !mesh.positions.is_empty() && !crate::kernel::budget::tripped() && !truncated {
                    let source = self.clone_mapped_source(id, mesh)?;
                    shared.lock().unwrap_or_else(|e| e.into_inner()).insert(id, source);
                }
            }
            None => { self.mapped_item_cache.borrow_mut().insert(id, self.clone_mapped_source(id, mesh)?); }
        }
        Ok(())
    }

    fn clone_mapped_source(&self, id: u32, mesh: &Mesh) -> Result<std::sync::Arc<Mesh>> {
        if !crate::resource::is_active() { return Ok(std::sync::Arc::new(mesh.clone())) }
        self.check_mapped_cache_coverage()?;
        let (mesh, permit) = crate::resource::mesh::clone_mesh(mesh)?;
        self.retain_mapped_cache_account(id)?;
        permit.retain();
        Ok(std::sync::Arc::new(mesh))
    }

    /// Placeholder recovery queries the actual shared registry without walking
    /// descendants. Its one reached source child is driven by MappingProgram.
    pub(crate) fn shared_mapped_source_needed(&self, id: u32) -> bool {
        self.shared_mapped_item_cache.as_ref().is_some_and(|shared|
            !shared.lock().unwrap_or_else(|e| e.into_inner()).contains_key(&id))
    }
    pub(crate) fn publish_shared_source_parts(&self, id: u32, mut parts: Vec<Mesh>) -> Result<()> {
        crate::resource::check_current()?;
        if parts.len() != 1 || parts[0].positions.is_empty() || crate::kernel::budget::tripped() { return Ok(()) }
        let Some(shared) = &self.shared_mapped_item_cache else { return Ok(()) };
        self.check_mapped_cache_coverage()?;
        self.retain_mapped_cache_account(id)?;
        shared.lock().unwrap_or_else(|e| e.into_inner()).insert(id, std::sync::Arc::new(parts.pop().unwrap_or_default()));
        Ok(())
    }

    /// Process MappedItem with caching for repeated geometry.
    ///
    /// Errors when the source's items cannot share one f64 frame (#6446); use
    /// [`Self::process_mapped_item_parts`] to keep such a source at full precision.
    #[inline]
    pub(super) fn process_mapped_item_cached(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Mesh> {
        single_frame_source("IfcMappedItem", item.id, self.process_mapped_item_parts(item, decoder)?)
    }

    /// [`Self::process_mapped_item_cached`] as frame parts: one mesh, unless the
    /// source's items lie in frames at least 1 km apart (#6446).
    pub(crate) fn process_mapped_item_parts(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Mesh>> {
        let mut program = GeometryProgram::mapped_merged(item, self)?;
        while let Some(request) = program.request().expect("synchronous mapping request") {
            let reply = program.execute(request, self, decoder).expect("synchronous mapping execution");
            program.accept(reply, self).expect("synchronous mapping acceptance");
        }
        let result = program.finish_parts();
        self.drain_mapping_cleanup();
        result
    }

    /// The styled consumer shares the mapping continuation architecture but
    /// retains separate source ordering, error and occurrence policies.
    #[cfg(test)]
    pub(crate) fn collect_submeshes_from_item(
        &self, item: &DecodedEntity, decoder: &mut EntityDecoder<'_>,
        sub_meshes: &mut SubMeshCollection, allow_instancing: bool,
        texture_index: Option<&rustc_hash::FxHashMap<u32, crate::processors::texture::ResolvedTextureMap>>,
    ) -> Result<()> {
        let mut program = GeometryProgram::mapped_styled(item, allow_instancing, self)?;
        while let Some(request) = program.request().expect("synchronous styled mapping request") {
            let reply = program.execute_with_textures(request, self, decoder, texture_index)
                .expect("synchronous styled mapping execution");
            program.accept(reply, self).expect("synchronous styled mapping acceptance");
        }
        let result = program.finish_submeshes();
        self.drain_mapping_cleanup();
        let mut output = result?;
        crate::resource::reserve_headers(&mut sub_meshes.sub_meshes, output.len())?.retain();
        sub_meshes.sub_meshes.append(&mut output.sub_meshes);
        Ok(())
    }

}
