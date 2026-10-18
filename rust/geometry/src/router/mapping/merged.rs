// SPDX-License-Identifier: MPL-2.0
//! Merged-source consumer: errors remove path membership, child failures mark
//! every enclosing source truncated, and cache admission precedes mapping bake.
use super::{GeometryRouter, ItemIdentity, Path, representation, skipped, source};
use crate::{Error, InstanceMeta, Mesh, Result, math::mat4};
use crate::router::{frame_parts::SourceParts, transforms::instancing_enabled};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType, slot};
use nalgebra::Matrix4;
use std::sync::Arc;

type Value = Result<(Vec<Mesh>, bool)>;
struct Source {
    id: u32, depth: usize, policy: bool,
    transform: Option<Matrix4<f64>>,
    items: std::vec::IntoIter<DecodedEntity>,
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
pub(in crate::router) struct MergedWalk { frames: Vec<Frame>, path: Path, value: Option<Value> }
impl MergedWalk {
    pub(in crate::router) fn new(item: &DecodedEntity, router: &GeometryRouter) -> Self {
        Self { frames: vec![Frame::Enter { item: item.clone(), depth: 0, policy: router.unsupported_policy() }],
            path: Path::default(), value: None }
    }
    pub(in crate::router) fn run(mut self, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>) -> Result<Vec<Mesh>> {
        while self.advance(router, decoder) {}
        self.value.expect("completed mapped-source value").map(|(parts, _)| parts)
    }
    pub(super) fn advance(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>) -> bool {
        let Some(frame) = self.frames.pop() else { return false };
        router.with_unsupported_policy(frame.policy(), || self.step(frame, router, decoder));
        true
    }
    fn step(&mut self, frame: Frame, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>) {
        match frame {
            Frame::Enter { item, depth, policy } => {
                if let Err(error) = Path::depth(depth, item.id).and_then(|()| self.path.enter(item.id)) {
                    self.value = Some(Err(error)); return;
                }
                self.frames.push(Frame::Exit { id: item.id, policy });
                if let Err(error) = self.enter(item, depth, router, decoder) { self.value = Some(Err(error)); }
            }
            Frame::Exit { id, .. } => self.path.exit(id),
            Frame::Source(mut state) => match state.items.next() {
                Some(item) if item.ifc_type == IfcType::IfcMappedItem => {
                    let depth = state.depth + 1;
                    let policy = state.policy;
                    self.frames.push(Frame::AfterChild { parent: state, item: ItemIdentity::from(&item) });
                    self.frames.push(Frame::Enter { item, depth, policy });
                }
                Some(item) => {
                    router.merge_source_item(&item, decoder, &mut state.parts, "mapped-source");
                    self.frames.push(Frame::Source(state));
                }
                None => self.value = Some(Ok(finish(state, router))),
            },
            Frame::AfterChild { mut parent, item } => {
                match self.value.take().expect("mapped child returned") {
                    Ok((parts, truncated)) => {
                        parent.truncated |= truncated;
                        for part in parts { parent.parts.merge(&part); }
                    }
                    Err(error) => { parent.truncated = true; skipped(router, &item, &error, true); }
                }
                self.frames.push(Frame::Source(parent));
            }
        }
    }
    fn enter(&mut self, item: DecodedEntity, depth: usize, router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>) -> Result<()> {
        let source = source(&item, decoder)?;
        // Merged sources decode transforms BEFORE looking in either cache.
        let transform = router.mapped_item_transform(&item, &source, decoder)?;
        let cached = match &router.shared_mapped_item_cache {
            Some(shared) => shared.lock().unwrap_or_else(|e| e.into_inner()).get(&source.id).cloned(),
            None => router.mapped_item_cache.borrow().get(&source.id).cloned(),
        };
        if let Some(mesh) = cached {
            self.value = Some(Ok((place(vec![mesh.as_ref().clone()], source.id, transform, router), false)));
            return Ok(());
        }
        let representation = representation(&source, decoder)?;
        let attribute = representation.get(slot::IfcRepresentation::ITEMS.index())
            .ok_or_else(|| Error::geometry("Representation missing Items".to_string()))?;
        let items = decoder.resolve_ref_list(attribute)?;
        // Unlike the submesh consumer, claim AFTER this bulk item admission.
        let policy = router.claim_unsupported_source(source.id, &representation);
        self.frames.push(Frame::Source(Source { id: source.id, depth, policy, transform,
            items: items.into_iter(), parts: SourceParts::default(), truncated: false }));
        Ok(())
    }
}
fn finish(state: Source, router: &GeometryRouter) -> (Vec<Mesh>, bool) {
    let parts = state.parts.into_parts();
    if parts.len() == 1 {
        match &router.shared_mapped_item_cache {
            Some(shared) => {
                // Shared state must not retain depth-/budget-degraded geometry.
                if !parts[0].positions.is_empty() && !crate::kernel::budget::tripped() && !state.truncated {
                    let source = Arc::new(parts[0].clone());
                    shared.lock().unwrap_or_else(|e| e.into_inner()).insert(state.id, source);
                }
            }
            None => {
                let source = Arc::new(parts[0].clone());
                router.mapped_item_cache.borrow_mut().insert(state.id, source);
            }
        }
    }
    (place(parts, state.id, state.transform, router), state.truncated)
}
fn place(mut parts: Vec<Mesh>, id: u32, transform: Option<Matrix4<f64>>, router: &GeometryRouter) -> Vec<Mesh> {
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
    parts
}
