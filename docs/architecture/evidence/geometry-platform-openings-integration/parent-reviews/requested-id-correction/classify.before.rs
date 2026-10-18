// SPDX-License-Identifier: MPL-2.0
//! Ordered opening occurrences. Source services are borrowed for one step only.
use super::super::opening::OpeningBounds;
use crate::router::voids::{geom::spatial_cluster_count, OpeningType};
use crate::router::OpeningDiagnostic;
use crate::{resource, GeometryRouter, Mesh};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

pub(crate) struct Classifier {
    host: DecodedEntity,
    ids: std::vec::IntoIter<u32>,
    recording: bool,
    occurrence: usize,
    current: Option<OpeningOccurrence>,
    phase: Phase,
    output: Vec<OpeningType>,
    diagnostic: Vec<OpeningDiagnostic>,
}
enum Phase {
    Decode,
    Body,
    Bounds,
    FallbackBounds,
    ItemMeshes,
    Classify,
    Complete,
}
struct OpeningOccurrence {
    entity: DecodedEntity,
    parts: std::collections::VecDeque<Mesh>,
    bounds: OpeningBounds,
    meshes: Vec<Mesh>,
    triangles: usize,
    vertices: usize,
}
impl Classifier {
    pub(crate) fn new(host: &DecodedEntity, ids: &[u32], recording: bool) -> Self {
        Self {
            host: host.clone(),
            ids: ids.to_vec().into_iter(),
            recording,
            occurrence: 0,
            current: None,
            phase: Phase::Decode,
            output: Vec::new(),
            diagnostic: Vec::with_capacity(ids.len()),
        }
    }

    pub(crate) fn run(
        mut self,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>,
    ) -> crate::Result<Vec<OpeningType>> {
        resource::check_current()?;
        while !matches!(self.phase, Phase::Complete) {
            self.step(router, decoder)?;
        }
        resource::check_current()?;
        if self.recording && !self.diagnostic.is_empty() {
            router.record_host_opening_diagnostic(
                self.host.id,
                &format!("{}", self.host.ifc_type),
                self.diagnostic,
            );
        }
        Ok(self.output)
    }

    fn accept(&mut self, opening: OpeningType, id: u32, vertices: usize, router: &GeometryRouter) -> crate::Result<()> {
        resource::check_current()?;
        if self.recording {
            let (counter, kind) = super::decision::kind(&opening);
            router.bump_classification(counter);
            self.diagnostic.push(OpeningDiagnostic {
                opening_id: id,
                kind,
                vertex_count: vertices,
            });
        }
        self.output.push(opening);
        Ok(())
    }

    fn step(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>) -> crate::Result<()> {
        resource::check_current()?;
        match self.phase {
            Phase::Decode => self.decode(decoder),
            Phase::Body => self.body(router, decoder),
            Phase::Bounds => self.bounds(router, decoder),
            Phase::FallbackBounds => self.fallback_bounds(router, decoder),
            Phase::ItemMeshes => self.item_meshes(router, decoder),
            Phase::Classify => self.classify(router),
            Phase::Complete => Ok(())
        }
    }
    fn decode(&mut self, decoder: &mut EntityDecoder<'_>) -> crate::Result<()> {
        resource::check_current()?;
        let Some(id) = self.ids.next() else {
            self.phase = Phase::Complete;
            return Ok(());
        };
        self.occurrence += 1;
        let decoded = decoder.decode_by_id(id);
        resource::check_current()?;
        self.current = decoded.ok().map(|entity| OpeningOccurrence {
            entity,
            parts: Default::default(),
            bounds: Vec::new(),
            meshes: Vec::new(),
            triangles: 0,
            vertices: 0,
        });
        if self.current.is_some() {
            self.phase = Phase::Body;
        }
        Ok(())
    }
    fn body(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>) -> crate::Result<()> {
        resource::check_current()?;
        let current = self.current.as_mut().expect("reached opening occurrence");
        let parts = super::source_option(router.opening_body_parts(&current.entity, decoder))?;
        let Some(parts) = parts else {
            self.phase = Phase::Decode;
            return Ok(());
        };
        current.parts = parts.into_iter().filter(|m| !m.is_empty()).collect();
        if current.parts.is_empty() {
            self.phase = Phase::Decode;
            return Ok(());
        }
        current.triangles = current.parts.iter().map(Mesh::triangle_count).sum();
        current.vertices = current.parts.iter().map(Mesh::vertex_count).sum();
        self.phase = Phase::Bounds;
        Ok(())
    }
    fn bounds(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>) -> crate::Result<()> {
        resource::check_current()?;
        let current = self.current.as_mut().expect("reached opening occurrence");
        current.bounds = super::source_option(
            router.get_opening_item_bounds_with_direction(&current.entity, decoder),
        )?.unwrap_or_default();
        let separable = current.bounds.len() > 1 && spatial_cluster_count(&current.bounds) > 1;
        self.phase = if current.triangles > 100 && !separable {
            Phase::FallbackBounds
        } else if !current.bounds.is_empty() {
            Phase::ItemMeshes
        } else {
            Phase::Classify
        };
        Ok(())
    }
    fn fallback_bounds(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>) -> crate::Result<()> {
        resource::check_current()?;
        let current = self.current.as_mut().expect("reached opening occurrence");
        // Historically repeated once PER PART, including custom callbacks.
        let bounds = super::source_option(
            router.get_opening_item_bounds_with_direction(&current.entity, decoder),
        )?.unwrap_or_default();
        let direction = bounds.into_iter().find_map(|(_, _, d)| d);
        let mesh = current.parts.pop_front().expect("reached frame part");
        let (min, max) = super::decision::world_bounds(&mesh);
        let done = current.parts.is_empty();
        let opening = OpeningType::NonRectangular(mesh, min, max, direction);
        let id = current.entity.id;
        let vertices = current.vertices;
        // Publication precedes the next part's callbacks, as before.
        self.accept(opening, id, vertices, router)?;
        if done {
            self.current = None;
            self.phase = Phase::Decode;
        }
        Ok(())
    }
    fn item_meshes(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>) -> crate::Result<()> {
        resource::check_current()?;
        let current = self.current.as_mut().expect("reached opening occurrence");
        current.meshes = super::source_option(
            router.get_opening_item_meshes_world(&current.entity, decoder),
        )?.unwrap_or_default();
        self.phase = Phase::Classify;
        Ok(())
    }
    fn classify(&mut self, router: &GeometryRouter) -> crate::Result<()> {
        resource::check_current()?;
        let current = self.current.take().expect("reached opening occurrence");
        let id = current.entity.id;
        let vertices = current.vertices;
        let mut classified = super::decision::classify(current.parts, current.bounds, current.meshes);
        loop {
            resource::check_current()?;
            let Some(opening) = classified.next() else { break };
            self.accept(opening, id, vertices, router)?;
        }
        self.phase = Phase::Decode;
        Ok(())
    }
}
