// SPDX-License-Identifier: MPL-2.0
//! Submesh-source consumer. Failed descendants keep their admitted path ids as
//! the previous source walk did; successful children receive mapping transforms
//! over exactly the submesh range they appended, after their whole return.
use super::{GeometryRouter, ItemIdentity, Path, occurrence, skipped};
use crate::{Result, SubMeshCollection};
use crate::processors::texture::ResolvedTextureMap;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use rustc_hash::FxHashMap;
use crate::program::{ItemProgram, ItemListPolicy};
use crate::resource::{self, Cost};

struct Source {
    item_id: u32, depth: usize, policy: bool, start: usize,
    admission: occurrence::Admission,
    items: ItemProgram,
}
enum Frame {
    Enter { item: DecodedEntity, depth: usize, policy: bool, allow_instancing: bool },
    Source(Source),
    AfterChild { parent: Source, item: ItemIdentity, start: usize },
}
impl Frame {
    fn policy(&self) -> bool {
        match self {
            Self::Enter { policy, .. } => *policy,
            Self::Source(source) | Self::AfterChild { parent: source, .. } => source.policy,
        }
    }
}
pub(crate) struct SubmeshWalk { frames: Vec<Frame>, path: Path, value: Option<Result<()>> }
impl SubmeshWalk {
    pub(crate) fn new(item: &DecodedEntity, allow_instancing: bool, router: &GeometryRouter) -> Result<Self> {
        resource::charge(Cost { work: 1, ..Cost::default() })?.retain();
        let frames = if resource::is_active() {
            let mut frames = Vec::new();
            resource::reserve_headers(&mut frames, 1)?.retain();
            frames.push(Frame::Enter { item: item.clone(), depth: 0, policy: router.unsupported_policy(), allow_instancing });
            frames
        } else { vec![Frame::Enter { item: item.clone(), depth: 0, policy: router.unsupported_policy(), allow_instancing }] };
        Ok(Self { frames, path: Path::default(), value: None })
    }
    pub(crate) fn run(mut self, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>,
        meshes: &mut SubMeshCollection, textures: Option<&FxHashMap<u32, ResolvedTextureMap>>) -> Result<()> {
        let start = meshes.len();
        while self.advance(router, decoder, meshes, textures) {
            if let Err(stop) = resource::check_current() { meshes.sub_meshes.truncate(start); return Err(stop.into()) }
        }
        if let Err(stop) = resource::check_current() { meshes.sub_meshes.truncate(start); return Err(stop.into()) }
        self.value.expect("completed submesh-source value")
    }
    pub(super) fn advance(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>,
        meshes: &mut SubMeshCollection, textures: Option<&FxHashMap<u32, ResolvedTextureMap>>) -> bool {
        let Some(frame) = self.frames.pop() else { return false };
        if let Err(stop) = resource::check_current().and_then(|()| resource::charge(Cost { work: 1, ..Cost::default() }).map(|p| p.retain())) {
            self.frames.clear(); self.value = Some(Err(stop.into())); return false;
        }
        router.with_unsupported_policy(frame.policy(), || self.step(frame, router, decoder, meshes, textures));
        true
    }
    fn push(&mut self, frame: Frame) {
        if let Ok(permit) = resource::reserve_headers(&mut self.frames, 1) {
            permit.retain(); self.frames.push(frame);
        }
    }
    fn step(&mut self, frame: Frame, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>,
        meshes: &mut SubMeshCollection, textures: Option<&FxHashMap<u32, ResolvedTextureMap>>) {
        match frame {
            Frame::Enter { item, depth, allow_instancing, .. } => {
                let result = resource::charge(Cost { occurrences: 1, ..Cost::default() })
                    .map(|p| p.retain()).map_err(crate::Error::from).and_then(|()| Path::depth(depth, item.id)).and_then(|()| {
                    if item.ifc_type == IfcType::IfcMappedItem {
                        self.path.enter(item.id)?;
                        self.enter(item, depth, allow_instancing, router, decoder, meshes, textures)
                    } else {
                        plain(&item, depth, router, decoder, meshes, textures)?;
                        self.value = Some(Ok(()));
                        Ok(())
                    }
                });
                // Compatibility: a failed mapped admission does not erase its
                // path id. Later siblings can encounter it as a cycle.
                if let Err(error) = result { self.value = Some(Err(error)); }
            }
            Frame::Source(mut parent) => match parent.items.next() {
                Some(item) => {
                    let depth = parent.depth + 1;
                    let policy = parent.policy;
                    self.push(Frame::AfterChild { parent, item: ItemIdentity::from(&item), start: meshes.len() });
                    self.push(Frame::Enter { item, depth, policy, allow_instancing: false });
                }
                None => {
                    if resource::check_current().is_err() { return }
                    occurrence::retag_template(&parent.admission, parent.start, meshes, router);
                    self.path.exit(parent.item_id);
                    self.value = Some(Ok(()));
                }
            },
            Frame::AfterChild { parent, item, start } => {
                match self.value.take().expect("submesh child returned") {
                    Ok(()) => occurrence::transform_children(parent.admission.transform, start, meshes, router),
                    Err(error) => {
                        if resource::check_current().is_err() { return }
                        skipped(router, &item, &error, false);
                    }
                }
                self.push(Frame::Source(parent));
            }
        }
    }
    #[allow(clippy::too_many_arguments)] // Reached source admission borrows execution services only for this step.
    fn enter(&mut self, item: DecodedEntity, depth: usize, allow_instancing: bool,
        router: &GeometryRouter, decoder: &mut EntityDecoder<'_>, meshes: &mut SubMeshCollection,
        textures: Option<&FxHashMap<u32, ResolvedTextureMap>>) -> Result<()> {
        let admission = occurrence::admit(&item, depth, allow_instancing, textures, router, decoder)?;
        if occurrence::placeholder(&admission, meshes, router, decoder)? {
            self.path.exit(item.id);
            self.value = Some(Ok(()));
            return Ok(());
        }
        let start = meshes.len();
        // Submeshes claim BEFORE their optional bulk item-list admission.
        let policy = router.claim_unsupported_source(admission.source_id, &admission.representation);
        let items = ItemProgram::admit(&admission.representation, decoder, ItemListPolicy::OptionalMap)?;
        self.push(Frame::Source(Source { item_id: item.id, depth, policy, start, admission,
            items }));
        Ok(())
    }
}
fn plain(item: &DecodedEntity, depth: usize, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>,
    meshes: &mut SubMeshCollection, textures: Option<&FxHashMap<u32, ResolvedTextureMap>>) -> Result<()> {
    resource::check_current()?;
    if let Some(map) = textures.and_then(|index| index.get(&item.id)) {
        if let Some((mut mesh, uvs)) = router.textured_face_set(item, decoder, map, Some(router.rtc_offset())) {
            if depth > 0 { router.keep_rebase_in_origin(&mut mesh); }
            admit_output(&mesh, uvs.len(), meshes)?;
            meshes.add_textured(item.id, mesh, uvs, map.attachment());
            resource::check_current()?;
            return Ok(());
        }
        resource::check_current()?;
    }
    let result = router.process_representation_item(item, decoder);
    resource::check_current()?;
    match result {
        Ok(mut mesh) => {
            if depth > 0 { router.keep_rebase_in_origin(&mut mesh); }
            if !mesh.is_empty() { admit_output(&mesh, 0, meshes)?; meshes.add(item.id, mesh); }
        }
        Err(error) => {
            router.record_unsupported_item(item.ifc_type.clone());
            crate::diag::diag_debug!(
                { item_id = item.id, ifc_type = ?item.ifc_type, error = %error,
                    "skipping unsupported geometry item" }
                else { #[cfg(debug_assertions)]
                    eprintln!("[ifc-lite] Skipping unsupported geometry #{} ({:?}): {}", item.id, item.ifc_type, error);
                }
            );
            let _ = error;
        }
    }
    Ok(())
}

fn admit_output(mesh: &crate::Mesh, uv_len: usize, meshes: &mut SubMeshCollection) -> Result<()> {
    if !resource::is_active() { return Ok(()) }
    let bytes = resource::mesh::MeshLengths::of(mesh).bytes().map_err(|_| resource::overflow())?;
    let uv_bytes = uv_len.checked_mul(4).and_then(|n| u64::try_from(n).ok()).ok_or_else(resource::overflow)?;
    let bytes = bytes.checked_add(uv_bytes).and_then(|n| n.checked_add(std::mem::size_of::<crate::SubMesh>() as u64))
        .ok_or_else(resource::overflow)?;
    resource::charge(Cost { output_bytes: bytes, live_bytes: bytes, ..Cost::default() })?.retain();
    resource::reserve_headers(&mut meshes.sub_meshes, 1)?.retain();
    Ok(())
}
