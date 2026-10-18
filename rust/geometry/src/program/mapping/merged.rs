// SPDX-License-Identifier: MPL-2.0
//! Merged-source consumer: errors remove path membership, child failures mark
//! every enclosing source truncated, and cache admission precedes mapping bake.
use super::{GeometryRouter, ItemIdentity, Path, representation, skipped, source};
use crate::{Error, InstanceMeta, Mesh, Result, math::mat4};
use crate::router::{frame_parts::SourceParts, transforms::instancing_enabled};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;
use crate::program::{ItemProgram, ItemListPolicy};
use crate::resource::{self, Cost};

type Value = Result<(Vec<Mesh>, bool)>;
struct Source {
    id: u32, depth: usize, policy: bool,
    transform: Option<Matrix4<f64>>,
    items: ItemProgram,
    parts: SourceParts, truncated: bool,
}
enum Frame {
    Enter { item: DecodedEntity, depth: usize, policy: bool },
    Exit { id: u32, policy: bool },
    Source(Source),
    AfterChild { parent: Source, item: ItemIdentity },
}
impl Frame {
    fn policy(&self) -> bool {
        match self {
            Self::Enter { policy, .. } | Self::Exit { policy, .. } => *policy,
            Self::Source(source) | Self::AfterChild { parent: source, .. } => source.policy,
        }
    }
}
pub(crate) struct MergedWalk { frames: Vec<Frame>, path: Path, value: Option<Value> }
impl MergedWalk {
    pub(crate) fn new(item: &DecodedEntity, router: &GeometryRouter) -> Result<Self> {
        resource::charge(Cost { work: 1, ..Cost::default() })?.retain();
        let frames = if resource::is_active() {
            let mut frames = Vec::new();
            resource::reserve_headers(&mut frames, 1)?.retain();
            frames.push(Frame::Enter { item: item.clone(), depth: 0, policy: router.unsupported_policy() });
            frames
        } else { vec![Frame::Enter { item: item.clone(), depth: 0, policy: router.unsupported_policy() }] };
        Ok(Self { frames, path: Path::default(), value: None })
    }
    pub(crate) fn run(mut self, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>) -> Result<Vec<Mesh>> {
        while self.advance(router, decoder) {
            resource::check_current()?;
        }
        resource::check_current()?;
        self.value.expect("completed mapped-source value").map(|(parts, _)| parts)
    }
    pub(super) fn advance(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>) -> bool {
        let Some(frame) = self.frames.pop() else { return false };
        if let Err(stop) = resource::check_current().and_then(|()| resource::charge(Cost { work: 1, ..Cost::default() }).map(|p| p.retain())) {
            self.frames.clear(); self.value = Some(Err(stop.into())); return false;
        }
        router.with_unsupported_policy(frame.policy(), || self.step(frame, router, decoder));
        true
    }
    fn push(&mut self, frame: Frame) {
        if let Ok(permit) = resource::reserve_headers(&mut self.frames, 1) {
            permit.retain(); self.frames.push(frame);
        }
    }
    fn step(&mut self, frame: Frame, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>) {
        match frame {
            Frame::Enter { item, depth, policy } => {
                if let Err(error) = resource::charge(Cost { occurrences: 1, ..Cost::default() }).map(|p| p.retain()).map_err(Error::from)
                    .and_then(|()| Path::depth(depth, item.id)).and_then(|()| self.path.enter(item.id)) {
                    self.value = Some(Err(error)); return;
                }
                self.push(Frame::Exit { id: item.id, policy });
                if let Err(error) = self.enter(item, depth, router, decoder) { self.value = Some(Err(error)); }
            }
            Frame::Exit { id, .. } => self.path.exit(id),
            Frame::Source(mut state) => match state.items.next() {
                Some(item) if item.ifc_type == IfcType::IfcMappedItem => {
                    let depth = state.depth + 1;
                    let policy = state.policy;
                    self.push(Frame::AfterChild { parent: state, item: ItemIdentity::from(&item) });
                    self.push(Frame::Enter { item, depth, policy });
                }
                Some(item) => {
                    router.merge_source_item(&item, decoder, &mut state.parts, "mapped-source");
                    self.push(Frame::Source(state));
                }
                None => self.value = Some(finish(state, router)),
            },
            Frame::AfterChild { mut parent, item } => {
                match self.value.take().expect("mapped child returned") {
                    Ok((parts, truncated)) => {
                        parent.truncated |= truncated;
                        for part in parts { parent.parts.merge(&part); }
                    }
                    Err(error) => {
                        if resource::check_current().is_err() { return }
                        parent.truncated = true; skipped(router, &item, &error, true);
                    }
                }
                self.push(Frame::Source(parent));
            }
        }
    }
    fn enter(&mut self, item: DecodedEntity, depth: usize, router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>) -> Result<()> {
        resource::check_current()?;
        let source = source(&item, decoder)?;
        // Merged sources decode transforms BEFORE looking in either cache.
        let transform = router.mapped_item_transform(&item, &source, decoder)?;
        let cached = router.cached_mapped_source(source.id);
        if let Some(mesh) = cached {
            let cloned = if resource::is_active() {
                let (mesh, permit) = resource::mesh::clone_mesh(&mesh)?; permit.retain(); mesh
            } else { mesh.as_ref().clone() };
            self.value = Some(Ok((place(vec![cloned], source.id, transform, router)?, false)));
            return Ok(());
        }
        let representation = representation(&source, decoder)?;
        let items = ItemProgram::admit(&representation, decoder, ItemListPolicy::RequiredMap)?;
        // Unlike the submesh consumer, claim AFTER this bulk item admission.
        let policy = router.claim_unsupported_source(source.id, &representation);
        self.push(Frame::Source(Source { id: source.id, depth, policy, transform,
            items, parts: SourceParts::default(), truncated: false }));
        Ok(())
    }
}
fn finish(state: Source, router: &GeometryRouter) -> Value {
    resource::check_current()?;
    let parts = state.parts.into_parts();
    resource::check_current()?;
    if parts.len() == 1 {
        router.publish_mapped_source(state.id, &parts[0], state.truncated)?;
    }
    Ok((place(parts, state.id, state.transform, router)?, state.truncated))
}
fn place(mut parts: Vec<Mesh>, id: u32, transform: Option<Matrix4<f64>>, router: &GeometryRouter) -> Result<Vec<Mesh>> {
    if resource::is_active() {
        let work = parts.iter().try_fold(0u64, |n, mesh| n.checked_add(mesh.positions.len() as u64));
        let work = work.ok_or_else(resource::overflow)?;
        resource::charge(Cost { work, ..Cost::default() })?;
    }
    let mut local_rm = None;
    if let Some(mut transform) = transform {
        router.scale_transform(&mut transform);
        if instancing_enabled() { local_rm = Some(mat4::from_na(&transform)); }
        for part in &mut parts { router.transform_mesh_local(part, &transform); }
    }
    if instancing_enabled() && parts.len() == 1 {
        parts[0].instance_meta = Some(InstanceMeta { transform: mat4::IDENTITY,
            local_transform: local_rm, canonical_transform: None, rep_identity: id as u128, instanceable: true });
    }
    Ok(parts)
}
