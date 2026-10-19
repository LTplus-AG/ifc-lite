// SPDX-License-Identifier: MPL-2.0
//! Source hygiene, weld-before-source and each reached placement continuation.
mod placement;
pub(crate) use placement::{PlacementAdmission, ProductPlacementRequest, ReadyProductPlace};
use super::ProductOutput;
use crate::router::processing::SourceHygiene;
use crate::{Mesh, Result, SubMeshCollection};
use ifc_lite_core::DecodedEntity;

type Bounds = Option<[f32; 6]>;
type FarParts = std::vec::IntoIter<(Mesh, Bounds)>;

pub(crate) enum CompletedProduct { Retained(Vec<super::super::retained::LogicalRetainedValue>), Merged(Vec<Mesh>), Styled(SubMeshCollection) }
pub(crate) enum Geometry { Retained(Vec<super::super::retained::LogicalRetainedValue>), Single(Mesh), Styled(SubMeshCollection) }
#[derive(Clone, Copy)]
enum AppendPolicy { Ordinary, Rebased(Bounds) }

enum Sequence {
    Retained(Option<Vec<super::super::retained::LogicalRetainedValue>>),
    Merged { primary: Option<Mesh>, far: FarParts, rebased: Option<(Mesh, Bounds)>, output: Vec<Mesh> },
    Styled(Option<SubMeshCollection>),
}
enum State {
    Next, Preparing, Prepared(Geometry), Admitting(Geometry),
    Placing(Geometry, PlacementAdmission), AwaitPlace,
    Joining(Geometry), AwaitJoin, Complete,
}

pub(crate) struct ProductCompletion {
    element: DecodedEntity,
    hygiene: SourceHygiene,
    sequence: Sequence,
    append: AppendPolicy,
    state: State,
}
pub(crate) enum CompletionPoll {
    Prepare(ReadyProductPrepare), Source(ProductPlacementRequest),
    Place(ReadyProductPlace), Join(ReadyProductJoin),
    Complete(CompletedProduct), Pending,
}

impl ProductCompletion {
    pub(crate) fn new(element: DecodedEntity, output: ProductOutput, hygiene: SourceHygiene) -> Self {
        let sequence = match output {
            ProductOutput::Retained(values) => Sequence::Retained(Some(values)),
            ProductOutput::Merged((primary, far, rebased)) => Sequence::Merged {
                primary: Some(primary), far: far.into_parts(), rebased: Some(rebased), output: Vec::new() },
            ProductOutput::Styled(collection) => Sequence::Styled(Some(collection)),
        };
        Self { element, hygiene, sequence, append: AppendPolicy::Ordinary, state: State::Next }
    }

    pub(crate) fn poll(&mut self) -> CompletionPoll {
        let state = std::mem::replace(&mut self.state, State::Complete);
        match state {
            State::Next => self.next(),
            State::Prepared(geometry) => {
                let has_meshes = match &geometry {
                    Geometry::Retained(values) => !values.is_empty(),
                    Geometry::Single(_) => true,
                    Geometry::Styled(collection) => !collection.sub_meshes.is_empty(),
                };
                self.state = State::Admitting(geometry);
                CompletionPoll::Source(ProductPlacementRequest { element: self.element.clone(), has_meshes })
            }
            State::Placing(geometry, admission) => {
                self.state = State::AwaitPlace;
                CompletionPoll::Place(ReadyProductPlace { geometry, admission })
            }
            State::Joining(geometry) => match geometry {
                Geometry::Retained(values) => CompletionPoll::Complete(CompletedProduct::Retained(values)),
                Geometry::Styled(collection) => CompletionPoll::Complete(CompletedProduct::Styled(collection)),
                Geometry::Single(mesh) => {
                    let Sequence::Merged { output, .. } = &mut self.sequence else { unreachable!("merged sequence") };
                    self.state = State::AwaitJoin;
                    CompletionPoll::Join(ReadyProductJoin { output: std::mem::take(output), mesh, append: self.append })
                }
            },
            State::Complete => CompletionPoll::Pending,
            pending => { self.state = pending; CompletionPoll::Pending }
        }
    }

    fn next(&mut self) -> CompletionPoll {
        let (geometry, bounds) = match &mut self.sequence {
            Sequence::Retained(values) => match values.take() {
                Some(values) => (Geometry::Retained(values), None),
                None => return CompletionPoll::Pending,
            },
            Sequence::Styled(collection) => match collection.take() {
                Some(collection) => (Geometry::Styled(collection), None),
                None => return CompletionPoll::Pending,
            },
            Sequence::Merged { primary, far, rebased, output } => {
                if let Some(mesh) = primary.take() { (Geometry::Single(mesh), None) }
                else if let Some((mesh, bounds)) = far.next() { (Geometry::Single(mesh), Some(bounds)) }
                else if let Some((mesh, bounds)) = rebased.take().filter(|(mesh, _)| !mesh.positions.is_empty()) {
                    self.append = AppendPolicy::Rebased(bounds);
                    (Geometry::Single(mesh), None)
                } else {
                    return CompletionPoll::Complete(CompletedProduct::Merged(std::mem::take(output)));
                }
            }
        };
        self.state = State::Preparing;
        CompletionPoll::Prepare(ReadyProductPrepare { geometry, hygiene: self.hygiene, bounds })
    }

    pub(crate) fn accept_prepare(&mut self, geometry: Geometry) { self.state = State::Prepared(geometry); }
    pub(crate) fn accept_source(&mut self, admission: PlacementAdmission) {
        let State::Admitting(geometry) = std::mem::replace(&mut self.state, State::Complete)
            else { panic!("validated placement admission") };
        self.state = State::Placing(geometry, admission);
    }
    pub(crate) fn accept_place(&mut self, geometry: Geometry) { self.state = State::Joining(geometry); }
    pub(crate) fn accept_join(&mut self, joined: Vec<Mesh>) {
        let Sequence::Merged { output, .. } = &mut self.sequence else { unreachable!("merged sequence") };
        *output = joined;
        self.state = State::Next;
    }
}

pub(crate) struct ReadyProductPrepare { geometry: Geometry, hygiene: SourceHygiene, bounds: Option<Bounds> }
impl ReadyProductPrepare {
    pub(crate) fn execute(mut self) -> Geometry {
        match &mut self.geometry {
            Geometry::Retained(_) => {},
            Geometry::Single(mesh) => {
                if let Some(bounds) = self.bounds { mesh.local_bounds = bounds; }
                self.hygiene.apply(mesh);
                crate::mesh_weld::weld_mesh(mesh);
            }
            Geometry::Styled(collection) => {
                // All cleanup precedes all welds; a UV channel requires index-only cleanup.
                for sub in &mut collection.sub_meshes {
                    let hygiene = if sub.uvs.is_some() { SourceHygiene::IndexOnly } else { self.hygiene };
                    hygiene.apply(&mut sub.mesh);
                }
                for sub in &mut collection.sub_meshes { crate::mesh_weld::weld_sub_mesh(sub); }
            }
        }
        self.geometry
    }
}

pub(crate) struct ReadyProductJoin { output: Vec<Mesh>, mesh: Mesh, append: AppendPolicy }
impl ReadyProductJoin {
    pub(crate) fn execute(mut self) -> Result<Vec<Mesh>> {
        if let AppendPolicy::Rebased(bounds) = self.append {
            let mut target = None;
            for (index, part) in self.output.iter().enumerate() {
                crate::resource::charge(crate::resource::Cost { work: 1, ..Default::default() })?;
                if crate::router::frame_parts::frames_mergeable(part.origin, self.mesh.origin) {
                    target = Some(index); break;
                }
            }
            if let Some(index) = target {
                let part = &mut self.output[index];
                if crate::resource::is_active() {
                    crate::resource::mesh::merge_mesh(part, &self.mesh)?.retain();
                } else { part.merge(&self.mesh); }
                if let Some(bounds) = bounds {
                    crate::router::frame_parts::union_bounds(&mut part.local_bounds, bounds);
                }
                return Ok(self.output);
            }
            self.mesh.local_bounds = bounds;
        }
        crate::resource::reserve_headers(&mut self.output, 1)?.retain();
        self.output.push(self.mesh);
        Ok(self.output)
    }
}

#[cfg(test)]
mod tests;
