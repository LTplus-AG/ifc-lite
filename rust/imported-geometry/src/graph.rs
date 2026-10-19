// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Iterative imported graph owner. Host replies supply raw attributes and codecs;
//! traversal, eligibility, deduplication and numeric admission stay here.
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use crate::{scene, stage_transform, stage_values, ImportError, ImportIdentity,
    ImportedAssembly, ImportedDefinition, ImportedSource, RawMatrix, RawMesh};

#[derive(Clone, Debug)]
pub struct Node { pub path: String, pub children: Vec<(String, u32)> }
#[derive(Clone, Debug, Default)]
pub struct NodeReply {
    pub has_entity: bool,
    pub original_step_instance: Option<String>,
    pub visibility: Option<String>,
    pub diffuse: Option<Vec<f64>>,
    pub opacity: f64,
    pub local_transform: Option<RawMatrix>,
    pub has_mesh: bool,
    pub has_points: bool,
}
#[derive(Clone, Debug)]
pub struct PointsReply {
    pub positions: Vec<f64>, pub colors: Option<Vec<f64>>, pub count: f64,
    pub precision: String, pub encoding: String,
}
#[derive(Clone, Debug)]
pub struct PointMetadata {
    pub colors: Option<Vec<f64>>, pub count: f64, pub precision: String, pub encoding: String,
}
#[derive(Debug)]
pub struct RetainedSource {
    pub identity: ImportIdentity, pub transform_stack: Vec<RawMatrix>,
    pub source: Arc<ImportedSource>, pub points: Option<Arc<PointMetadata>>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LineageEntry { pub node: u32, pub edge: Option<String> }
#[derive(Clone, Debug)]
pub enum EventKind {
    Node(Vec<LineageEntry>),
    Key { transform: Option<[f32; 16]>, color: Option<[f64; 4]> },
    MeshSource,
    PointsSource,
    MeshOutput { output: crate::MeshOutput, color: Option<[f64; 4]> },
    PointsOutput { output: crate::PointsOutput, colors: Option<Vec<f32>>, count: f64 },
}
#[derive(Clone, Debug)]
pub struct Event {
    pub sequence: u32, pub frame: u64, pub node: u32, pub context: Option<u32>, pub kind: EventKind,
}
impl Event {
    pub fn reply_kind(&self) -> u32 {
        match self.kind {
            EventKind::Node(_) => 102, EventKind::Key { .. } => 103,
            EventKind::MeshSource => 104, EventKind::PointsSource => 105,
            EventKind::MeshOutput { .. } | EventKind::PointsOutput { .. } => 106,
        }
    }
}
/// Work limits for untrusted graph packets. Every outgoing edge clones its
/// parent frame, so an adversarial reply (the same child repeated, huge edge
/// names, oversized matrices, very deep chains) could otherwise multiply a
/// small packet into gigabytes. Real IFCX models are far below all of these.
/// Exceeding any limit refuses the program with `ImportError::InvalidPacket`.
/// Deepest path of nested nodes (a frame's lineage length).
pub const MAX_DEPTH: usize = 512;
/// Total frames a program may visit across all passes.
pub const MAX_FRAMES: u64 = 10_000_000;
/// Bytes (estimated) held by queued, not yet visited, frames at any moment.
pub const MAX_QUEUED_BYTES: usize = 256 << 20;
/// A local transform is accepted only as at most 4 rows of at most 4 values.
pub const MAX_TRANSFORM_ROWS: usize = 4;
pub const MAX_TRANSFORM_COLUMNS: usize = 4;
#[derive(Clone, Copy, Debug)]
struct Limits { depth: usize, frames: u64, queued_bytes: usize }
const LIMITS: Limits = Limits { depth: MAX_DEPTH, frames: MAX_FRAMES, queued_bytes: MAX_QUEUED_BYTES };
const FRAME_BYTES: usize = 160;
const ENTRY_BYTES: usize = 32;
fn matrix_bytes(matrix: &RawMatrix) -> usize {
    24 + matrix.iter().map(|row| 24 + row.len() * 8).sum::<usize>()
}

#[derive(Clone, Debug, Default)]
struct Frame {
    occurrence: u64, node: u32, lineage: Vec<LineageEntry>, context: Option<u32>,
    is_type: bool, invisible: bool, color: Option<[f64; 4]>, stack: Vec<RawMatrix>,
    /// Estimated size of this frame, kept in step with lineage and stack.
    bytes: usize,
}
#[derive(Debug)]
pub struct GraphProgram {
    store: u64, revision: u64, nodes: Vec<Node>, seeds: Vec<u32>, passes: Vec<bool>, pass: usize,
    queue: Vec<Frame>, current: Option<Frame>, pending: Option<Event>,
    sequence: u32, occurrence: u64, emitted: HashSet<String>, retained: Vec<RetainedSource>, failure: Option<ImportError>,
    definitions: HashMap<(u64, bool), Arc<ImportedSource>>,
    point_metadata: HashMap<u64, Arc<PointMetadata>>,
    limits: Limits, queued_bytes: usize,
}

fn seeds(nodes: &[Node], candidates: usize) -> Result<Vec<u32>, ImportError> {
    if candidates > nodes.len() { return Err(ImportError::InvalidPacket); }
    if nodes.iter().any(|node| node.children.iter().any(|(_, child)| *child as usize >= nodes.len())) {
        return Err(ImportError::InvalidPacket);
    }
    let mut child_paths = HashSet::new();
    for node in &nodes[..candidates] { for (_, child) in &node.children {
        let child = nodes.get(*child as usize).ok_or(ImportError::InvalidPacket)?;
        child_paths.insert(child.path.as_str());
    }}
    // composeIfcx can retain a cycle stub with the same path as a real map
    // entry. Source identity, rather than allocation index, defines reachability.
    let roots: Vec<u32> = nodes[..candidates].iter().enumerate()
        .filter(|(_, node)| !child_paths.contains(node.path.as_str()))
        .map(|(index, _)| index as u32).collect();
    let mut reachable = HashSet::new();
    let mut result = Vec::new();
    for root in roots { result.push(root); mark_reachable(root, nodes, &mut reachable)?; }
    for candidate in 0..candidates as u32 {
        if reachable.contains(nodes[candidate as usize].path.as_str()) { continue; }
        result.push(candidate); mark_reachable(candidate, nodes, &mut reachable)?;
    }
    Ok(result)
}
fn mark_reachable<'a>(root: u32, nodes: &'a [Node], reachable: &mut HashSet<&'a str>) -> Result<(), ImportError> {
    let mut work = vec![root];
    while let Some(id) = work.pop() {
        let node = nodes.get(id as usize).ok_or(ImportError::InvalidPacket)?;
        if !reachable.insert(node.path.as_str()) { continue; }
        work.extend(node.children.iter().map(|(_, child)| *child));
    }
    Ok(())
}

fn same_values(left: &[f64], right: &[f64]) -> bool {
    left.len() == right.len() && left.iter().zip(right).all(|(a, b)| a.to_bits() == b.to_bits())
}
fn same_optional(left: &Option<Vec<f64>>, right: &Option<Vec<f64>>) -> bool {
    match (left, right) { (Some(a), Some(b)) => same_values(a, b), (None, None) => true, _ => false }
}
fn same_rows(left: &[Vec<f64>], right: &[Vec<f64>]) -> bool {
    left.len() == right.len() && left.iter().zip(right).all(|(a, b)| same_values(a, b))
}
fn same_source(left: &ImportedSource, right: &ImportedSource) -> bool {
    match (left, right) {
        (ImportedSource::Points(a), ImportedSource::Points(b)) => same_values(a, b),
        (ImportedSource::Mesh(a), ImportedSource::Mesh(b)) => {
            same_rows(&a.points, &b.points) && same_values(&a.face_vertex_indices, &b.face_vertex_indices)
                && same_optional(&a.face_vertex_counts, &b.face_vertex_counts)
                && match (&a.normals, &b.normals) {
                    (Some(a), Some(b)) => same_rows(a, b), (None, None) => true, _ => false,
                }
        }
        _ => false,
    }
}

fn is_type(source: &str) -> bool {
    // ASCII equivalent of /=[A-Za-z0-9_]*Type\(/i, including an empty prefix.
    source.as_bytes().split(|byte| *byte == b'=').skip(1).any(|tail| {
        let length = tail.iter().take_while(|b| b.is_ascii_alphanumeric() || **b == b'_').count();
        length >= 4 && tail[length-4..length].eq_ignore_ascii_case(b"type") && tail.get(length) == Some(&b'(')
    })
}

impl GraphProgram {
    pub fn new(store: u64, revision: u64, mode: u32, nodes: Vec<Node>) -> Result<Self, ImportError> {
        let candidates = nodes.len();
        Self::with_candidates(store, revision, mode, nodes, candidates)
    }
    pub fn with_candidates(store: u64, revision: u64, mode: u32, nodes: Vec<Node>, candidates: usize) -> Result<Self, ImportError> {
        if !(1..=3).contains(&mode) || u32::try_from(nodes.len()).is_err() { return Err(ImportError::InvalidPacket); }
        let seeds = seeds(&nodes, candidates)?;
        let passes = match mode { 1 => vec![true], 2 => vec![false], _ => vec![true, false] };
        let mut program = Self { store, revision, nodes, seeds, passes, pass: 0, queue: Vec::new(),
            current: None, pending: None, sequence: 0, occurrence: 0, emitted: HashSet::new(), retained: Vec::new(), failure: None, definitions: HashMap::new(), point_metadata: HashMap::new(), limits: LIMITS, queued_bytes: 0 };
        program.seed_pass();
        Ok(program)
    }
    fn seed_pass(&mut self) {
        let frames: Vec<Frame> = self.seeds.iter().rev().map(|node| Frame {
            node: *node, lineage: vec![LineageEntry { node: *node, edge: None }],
            bytes: FRAME_BYTES + ENTRY_BYTES, ..Frame::default()
        }).collect();
        self.queued_bytes = self.queued_bytes.saturating_add(frames.iter().map(|f| f.bytes).sum());
        self.queue.extend(frames);
    }
    fn issue(&mut self, kind: EventKind) -> Result<(), ImportError> {
        let frame = self.current.as_ref().ok_or(ImportError::IdentityMismatch)?;
        self.sequence = self.sequence.checked_add(1).ok_or(ImportError::InvalidPacket)?;
        self.pending = Some(Event { sequence: self.sequence, frame: frame.occurrence,
            node: frame.node, context: frame.context, kind });
        Ok(())
    }
    /// Repeated polls return the same request until the matching reply arrives.
    pub fn poll(&mut self) -> Result<Option<&Event>, ImportError> {
        self.check_failure()?;
        if self.pending.is_some() { return Ok(self.pending.as_ref()); }
        while self.queue.is_empty() {
            if self.pass + 1 == self.passes.len() { return Ok(None); }
            self.pass += 1;
            self.seed_pass();
        }
        let mut frame = self.queue.pop().ok_or(ImportError::IdentityMismatch)?;
        self.queued_bytes = self.queued_bytes.saturating_sub(frame.bytes);
        self.occurrence = self.occurrence.checked_add(1).ok_or(ImportError::InvalidPacket)?;
        if self.occurrence > self.limits.frames { return Err(self.fail(ImportError::InvalidPacket)); }
        frame.occurrence = self.occurrence;
        let lineage = frame.lineage.clone();
        self.current = Some(frame);
        self.issue(EventKind::Node(lineage))?;
        Ok(self.pending.as_ref())
    }
    fn check_failure(&self) -> Result<(), ImportError> {
        self.failure.clone().map_or(Ok(()), Err)
    }
    pub fn check_reply(&self, sequence: u32, kind: u32) -> Result<(), ImportError> {
        self.check_failure()?;
        match &self.pending {
            Some(event) if event.sequence == sequence && event.reply_kind() == kind => Ok(()),
            _ => Err(ImportError::IdentityMismatch),
        }
    }
    pub fn node_reply(&mut self, sequence: u32, reply: NodeReply) -> Result<(), ImportError> {
        self.check_reply(sequence, 102)?;
        if reply.local_transform.as_ref().is_some_and(|m| m.len() > MAX_TRANSFORM_ROWS
            || m.iter().any(|row| row.len() > MAX_TRANSFORM_COLUMNS)) {
            return Err(self.fail(ImportError::InvalidPacket));
        }
        let frame = self.current.as_mut().ok_or(ImportError::IdentityMismatch)?;
        if reply.has_entity {
            frame.context = Some(frame.node);
            frame.is_type |= reply.original_step_instance.as_deref().is_some_and(is_type);
        }
        // USD: `inherited` takes the parent's state, so it never makes a hidden
        // ancestor visible. Any other explicit token overrides.
        if let Some(visibility) = reply.visibility {
            if !visibility.eq_ignore_ascii_case("inherited") { frame.invisible = visibility.eq_ignore_ascii_case("invisible"); }
        }
        if let Some(color) = reply.diffuse {
            frame.color = Some([color.first().copied().unwrap_or(f64::NAN),
                color.get(1).copied().unwrap_or(f64::NAN), color.get(2).copied().unwrap_or(f64::NAN), reply.opacity]); // not-an-attribute: diffuse RGB Vec<f64> components, not IFC entity attributes.
        }
        if let Some(local) = reply.local_transform { frame.bytes = frame.bytes.saturating_add(matrix_bytes(&local)); frame.stack.push(local); }
        // Stage on every frame, including hidden frames and nodes without geometry.
        let transform = stage_transform(&frame.stack, self.passes[self.pass]);
        let eligible = frame.context.is_some() && !frame.is_type && !frame.invisible;
        let next = if eligible && self.passes[self.pass] && reply.has_mesh {
            Some(EventKind::Key { transform, color: frame.color })
        } else if eligible && !self.passes[self.pass] && reply.has_points {
            Some(EventKind::PointsSource)
        } else { None };
        self.pending = None;
        if let Some(kind) = next { self.issue(kind) } else { self.finish_frame() }
    }
    pub fn key_reply(&mut self, sequence: u32, key: String) -> Result<(), ImportError> {
        self.check_reply(sequence, 103)?;
        self.pending = None;
        if self.emitted.insert(key) { self.issue(EventKind::MeshSource) } else { self.finish_frame() }
    }
    fn definition(&self, source: ImportedSource) -> Result<ImportedDefinition, ImportError> {
        let frame = self.current.as_ref().ok_or(ImportError::IdentityMismatch)?;
        Ok(ImportedDefinition { identity: ImportIdentity { store: self.store, revision: self.revision,
            definition: u64::from(frame.node) + 1, occurrence: frame.occurrence },
            source, transform_stack: frame.stack.clone() })
    }
    fn fail(&mut self, error: ImportError) -> ImportError {
        self.failure = Some(error.clone());
        self.pending = None;
        self.current = None;
        self.queue.clear();
        error
    }
    fn evaluate(&mut self, source: ImportedSource) -> Result<ImportedAssembly, ImportError> {
        let definition = self.definition(source)?;
        let key = (definition.identity.definition, matches!(definition.source, ImportedSource::Points(_)));
        if self.definitions.get(&key).is_some_and(|known| !same_source(known, &definition.source)) {
            return Err(self.fail(ImportError::IdentityMismatch));
        }
        match scene::evaluate(definition) {
            Ok(assembly) => Ok(assembly),
            Err(error) => Err(self.fail(error)),
        }
    }
    pub fn mesh_reply(&mut self, sequence: u32, source: RawMesh) -> Result<(), ImportError> {
        self.check_reply(sequence, 104)?;
        let ImportedAssembly { definition, output } = self.evaluate(ImportedSource::Mesh(source))?;
        let crate::ImportedOutput::Mesh(output) = output else { return Err(ImportError::IdentityMismatch); };
        let kind = EventKind::MeshOutput { output, color: self.current.as_ref().and_then(|frame| frame.color) };
        self.retain(definition, None);
        self.issue(kind)
    }
    pub fn points_reply(&mut self, sequence: u32, source: Option<PointsReply>) -> Result<(), ImportError> {
        self.check_reply(sequence, 105)?;
        let Some(source) = source else { self.pending = None; return self.finish_frame(); };
        let PointsReply { positions, colors, count, precision, encoding } = source;
        let id = self.current.as_ref().ok_or(ImportError::IdentityMismatch)?.node as u64 + 1;
        if self.point_metadata.get(&id).is_some_and(|known| known.count.to_bits() != count.to_bits()
            || known.precision != precision || known.encoding != encoding || !same_optional(&known.colors, &colors)) {
            return Err(self.fail(ImportError::IdentityMismatch));
        }
        let ImportedAssembly { definition, output } = self.evaluate(ImportedSource::Points(positions))?;
        let crate::ImportedOutput::Points(output) = output else { return Err(ImportError::IdentityMismatch); };
        let kind = EventKind::PointsOutput { output, colors: colors.as_deref().map(stage_values), count };
        let points = Some(PointMetadata { colors, count, precision, encoding });
        self.retain(definition, points);
        self.issue(kind)
    }
    fn retain(&mut self, definition: ImportedDefinition, points: Option<PointMetadata>) {
        let ImportedDefinition { identity, source, transform_stack } = definition;
        let is_points = matches!(source, ImportedSource::Points(_));
        let source = Arc::clone(self.definitions.entry((identity.definition, is_points))
            .or_insert_with(|| Arc::new(source)));
        let points = points.map(|metadata| Arc::clone(self.point_metadata.entry(identity.definition)
            .or_insert_with(|| Arc::new(metadata))));
        self.retained.push(RetainedSource { identity, transform_stack, source, points });
    }
    pub fn ack(&mut self, sequence: u32) -> Result<(), ImportError> {
        self.check_reply(sequence, 106)?;
        self.pending = None;
        self.finish_frame()
    }
    fn finish_frame(&mut self) -> Result<(), ImportError> {
        let frame = self.current.take().ok_or(ImportError::IdentityMismatch)?;
        for (edge, child) in self.nodes[frame.node as usize].children.iter().rev() {
            // Path scope preserves real DAG occurrences; only cycles are omitted.
            if frame.lineage.iter().any(|entry| self.nodes[entry.node as usize].path == self.nodes[*child as usize].path) { continue; }
            if frame.lineage.len() >= self.limits.depth { return Err(self.fail(ImportError::InvalidPacket)); }
            let bytes = frame.bytes.saturating_add(ENTRY_BYTES).saturating_add(edge.len());
            // Each queued frame owns a copy of its parent's state, so budget the clone first.
            self.queued_bytes = self.queued_bytes.saturating_add(bytes);
            if self.queued_bytes > self.limits.queued_bytes { return Err(self.fail(ImportError::InvalidPacket)); }
            let mut next = frame.clone();
            next.node = *child;
            next.bytes = bytes;
            next.lineage.push(LineageEntry { node: *child, edge: Some(edge.clone()) });
            self.queue.push(next);
        }
        Ok(())
    }
    pub fn retained(&self) -> &[RetainedSource] { &self.retained }
}

#[cfg(test)]
#[path = "graph_tests.rs"]
mod tests;
