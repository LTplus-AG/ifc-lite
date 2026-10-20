// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Graph packet payloads. Parsing completes before borrowing persistent state,
//! and no host callback or RefCell borrow survives a request.
use std::{cell::RefCell, collections::HashMap, sync::atomic::{AtomicU64, Ordering}};
use crate::{graph::{Event, EventKind, GraphProgram, Node, NodeReply, PointsReply}, ImportError, RawMesh};

struct Registry { programs: HashMap<u32, GraphProgram> }
// A process-wide namespace prevents a handle sent on another native thread
// from selecting an unrelated thread-local graph. WASM instances are isolated.
static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);
thread_local! {
    static REGISTRY: RefCell<Registry> = RefCell::new(Registry { programs: HashMap::new() });
}
struct Reader<'a> { data: &'a [u8], offset: usize }
impl Reader<'_> {
    fn bytes(&mut self, count: usize) -> Result<&[u8], ImportError> {
        let end = self.offset.checked_add(count).ok_or(ImportError::InvalidPacket)?;
        let bytes = self.data.get(self.offset..end).ok_or(ImportError::InvalidPacket)?;
        self.offset = end;
        Ok(bytes)
    }
    fn u32(&mut self) -> Result<u32, ImportError> {
        Ok(u32::from_le_bytes(self.bytes(4)?.try_into().map_err(|_| ImportError::InvalidPacket)?))
    }
    fn u64(&mut self) -> Result<u64, ImportError> {
        Ok(u64::from_le_bytes(self.bytes(8)?.try_into().map_err(|_| ImportError::InvalidPacket)?))
    }
    fn f64(&mut self) -> Result<f64, ImportError> {
        Ok(f64::from_le_bytes(self.bytes(8)?.try_into().map_err(|_| ImportError::InvalidPacket)?))
    }
    fn boolean(&mut self) -> Result<bool, ImportError> {
        match self.u32()? { 0 => Ok(false), 1 => Ok(true), _ => Err(ImportError::InvalidPacket) }
    }
    fn count(&mut self, minimum: usize) -> Result<usize, ImportError> {
        let count = self.u32()? as usize;
        if count > (self.data.len() - self.offset) / minimum { return Err(ImportError::InvalidPacket); }
        Ok(count)
    }
    fn string(&mut self) -> Result<String, ImportError> {
        let count = self.u32()? as usize;
        String::from_utf8(self.bytes(count)?.to_vec()).map_err(|_| ImportError::InvalidPacket)
    }
    fn optional_string(&mut self) -> Result<Option<String>, ImportError> {
        if self.boolean()? { Ok(Some(self.string()?)) } else { Ok(None) }
    }
    fn values(&mut self) -> Result<Vec<f64>, ImportError> {
        let count = self.count(8)?;
        (0..count).map(|_| self.f64()).collect()
    }
    fn optional_values(&mut self) -> Result<Option<Vec<f64>>, ImportError> {
        if self.boolean()? { Ok(Some(self.values()?)) } else { Ok(None) }
    }
    fn rows(&mut self) -> Result<Vec<Vec<f64>>, ImportError> {
        let count = self.count(4)?;
        (0..count).map(|_| self.values()).collect()
    }
    fn nodes(&mut self) -> Result<Vec<Node>, ImportError> {
        let count = self.count(8)?;
        (0..count).map(|_| {
            let path = self.string()?;
            let count = self.count(8)?;
            let children = (0..count).map(|_| Ok((self.string()?, self.u32()?)))
                .collect::<Result<Vec<_>, ImportError>>()?;
            Ok(Node { path, children })
        }).collect()
    }
    fn node_reply(&mut self) -> Result<NodeReply, ImportError> {
        Ok(NodeReply {
            has_entity: self.boolean()?, original_step_instance: self.optional_string()?,
            visibility: self.optional_string()?, diffuse: self.optional_values()?, opacity: self.f64()?,
            local_transform: if self.boolean()? { Some(self.rows()?) } else { None },
            has_mesh: self.boolean()?, has_points: self.boolean()?,
        })
    }
    fn mesh(&mut self) -> Result<RawMesh, ImportError> {
        Ok(RawMesh { points: self.rows()?, face_vertex_indices: self.values()?,
            face_vertex_counts: self.optional_values()?,
            normals: if self.boolean()? { Some(self.rows()?) } else { None } })
    }
    fn points(&mut self) -> Result<Option<PointsReply>, ImportError> {
        if !self.boolean()? { return Ok(None); }
        Ok(Some(PointsReply { positions: self.values()?, colors: self.optional_values()?,
            count: self.f64()?, precision: self.string()?, encoding: self.string()? }))
    }
}
enum Command {
    Open(Box<GraphProgram>), Poll(u32), Close(u32),
    Node(u32, u32, NodeReply), Key(u32, u32, String), Mesh(u32, u32, RawMesh),
    Points(u32, u32, Option<PointsReply>), Ack(u32, u32),
}
fn parse(input: &[u8]) -> Result<Command, ImportError> {
    let mut r = Reader { data: input, offset: 0 };
    if r.u32()? != 1 { return Err(ImportError::InvalidPacket); }
    let kind = r.u32()?;
    let command = match kind {
        100 => { let store = r.u64()?; let revision = r.u64()?; let mode = r.u32()?;
            let candidates = r.u32()? as usize;
            Command::Open(Box::new(GraphProgram::with_candidates(store, revision, mode, r.nodes()?, candidates)?)) }
        101 => Command::Poll(r.u32()?),
        102 => Command::Node(r.u32()?, r.u32()?, r.node_reply()?),
        103 => Command::Key(r.u32()?, r.u32()?, r.string()?),
        104 => Command::Mesh(r.u32()?, r.u32()?, r.mesh()?),
        105 => Command::Points(r.u32()?, r.u32()?, r.points()?),
        106 => Command::Ack(r.u32()?, r.u32()?),
        107 => Command::Close(r.u32()?),
        _ => return Err(ImportError::InvalidPacket),
    };
    if r.offset != input.len() { return Err(ImportError::InvalidPacket); }
    Ok(command)
}
fn length(value: usize) -> Result<u32, ImportError> { u32::try_from(value).map_err(|_| ImportError::InvalidPacket) }
fn word(out: &mut Vec<u8>, value: u32) { out.extend(value.to_le_bytes()); }
fn floats(out: &mut Vec<u8>, values: &[f32]) -> Result<(), ImportError> {
    word(out, length(values.len())?);
    for value in values { out.extend(value.to_le_bytes()); }
    Ok(())
}
fn color(out: &mut Vec<u8>, value: &Option<[f64; 4]>) {
    word(out, u32::from(value.is_some()));
    if let Some(values) = value { for value in values { out.extend(value.to_le_bytes()); } }
}
fn event(out: &mut Vec<u8>, event: Option<&Event>) -> Result<(), ImportError> {
    let Some(event) = event else { word(out, 0); return Ok(()); };
    let kind = match event.kind {
        EventKind::Node(_) => 1, EventKind::Key { .. } => 2, EventKind::MeshSource => 3,
        EventKind::PointsSource => 4, EventKind::MeshOutput { .. } => 5, EventKind::PointsOutput { .. } => 6,
    };
    word(out, kind); word(out, event.sequence);
    out.extend(event.frame.to_le_bytes()); word(out, event.node);
    if kind != 1 { word(out, event.context.ok_or(ImportError::IdentityMismatch)?); }
    match &event.kind {
        EventKind::Node(lineage) => {
            word(out, length(lineage.len())?);
            for entry in lineage {
                word(out, entry.node); word(out, u32::from(entry.edge.is_some()));
                if let Some(edge) = &entry.edge {
                    word(out, length(edge.len())?); out.extend(edge.as_bytes());
                }
            }
        }
        EventKind::Key { transform, color: value } => {
            floats(out, transform.as_ref().map_or(&[], |m| m.as_slice()))?;
            color(out, value);
        }
        EventKind::MeshOutput { output, color: value } => {
            color(out, value); floats(out, &output.positions)?; floats(out, &output.normals)?;
            word(out, length(output.indices.len())?);
            for index in &output.indices { word(out, *index); }
        }
        EventKind::PointsOutput { output, colors, count } => {
            floats(out, &output.positions)?; word(out, u32::from(colors.is_some()));
            if let Some(colors) = colors { floats(out, colors)?; }
            out.extend(count.to_le_bytes());
            for value in output.min.into_iter().chain(output.max) { out.extend(value.to_le_bytes()); }
        }
        EventKind::MeshSource | EventKind::PointsSource => {}
    }
    Ok(())
}
impl Registry {
    fn program(&mut self, handle: u32) -> Result<&mut GraphProgram, ImportError> {
        self.programs.get_mut(&handle).ok_or(ImportError::IdentityMismatch)
    }
    fn run(&mut self, command: Command) -> Result<Vec<u8>, ImportError> {
        let mut out = Vec::new();
        match command {
            Command::Open(program) => {
                let handle = NEXT_HANDLE.fetch_update(Ordering::Relaxed, Ordering::Relaxed,
                    |next| (next <= u64::from(u32::MAX)).then_some(next + 1))
                    .map_err(|_| ImportError::InvalidPacket)? as u32; self.programs.insert(handle, *program); word(&mut out, handle);
            }
            Command::Poll(handle) => event(&mut out, self.program(handle)?.poll()?)?,
            // Closing a stale handle is idempotent, but IDs are never reused.
            Command::Close(handle) => { self.programs.remove(&handle); }
            Command::Node(handle, sequence, reply) => self.program(handle)?.node_reply(sequence, reply)?,
            Command::Key(handle, sequence, reply) => self.program(handle)?.key_reply(sequence, reply)?,
            Command::Mesh(handle, sequence, reply) => self.program(handle)?.mesh_reply(sequence, reply)?,
            Command::Points(handle, sequence, reply) => self.program(handle)?.points_reply(sequence, reply)?,
            Command::Ack(handle, sequence) => self.program(handle)?.ack(sequence)?,
        }
        Ok(out)
    }
}
/// Returns an unframed payload; the numeric packet entry owns outer framing.
pub(crate) fn dispatch(input: &[u8]) -> Result<Vec<u8>, ImportError> {
    let command = parse(input)?;
    REGISTRY.with(|registry| registry.borrow_mut().run(command))
}

#[cfg(test)]
#[path = "graph_packet_tests.rs"]
mod tests;
