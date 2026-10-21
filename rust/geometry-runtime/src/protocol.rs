// SPDX-License-Identifier: MPL-2.0
//! transport-neutral owned-kernel messages, usable from native and wasm32.
//! Payloads contain version/request/op fields; stream length prefixes belong to
//! native transport. No pointers, JS numbers for u64 IDs, or host worker identity
//! cross this boundary. Handles belong to one worker/module incarnation.

/// Numerical Boolean selector; wire codes are fixed by the adapter ABI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BooleanOperation {
    Union,
    Intersection,
    Difference,
}

pub const VERSION: u32 = 1;
/// Original request and legacy response frame bound, including the 12-byte header.
pub const MAX_PAYLOAD_BYTES: usize = 4096;
pub const MAX_REQUEST_BYTES: usize = MAX_PAYLOAD_BYTES;
pub const MAX_RESPONSE_BYTES: usize = MAX_PAYLOAD_BYTES;
pub const MAX_MESH_CHUNK_SCALARS: u32 = 480;
/// Largest staged recipe chunk; a chunk request stays below the request bound.
pub const MAX_SWEEP_CHUNK_BYTES: usize = 3840;

/// Kernel-side token. Execution clients must separately enforce worker affinity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct WireHandle {
    pub session: u64,
    pub slot: u32,
    pub generation: u32,
}

impl WireHandle {
    pub fn to_bytes(self) -> [u8; 16] {
        let mut bytes = [0; 16];
        bytes[..8].copy_from_slice(&self.session.to_le_bytes());
        bytes[8..12].copy_from_slice(&self.slot.to_le_bytes());
        bytes[12..].copy_from_slice(&self.generation.to_le_bytes());
        bytes
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, ProtocolError> {
        if bytes.len() != 16 {
            return Err(ProtocolError::ResultSize);
        }
        Ok(Self {
            session: u64::from_le_bytes(bytes[..8].try_into().expect("eight bytes")),
            slot: u32::from_le_bytes(bytes[8..12].try_into().expect("four bytes")),
            generation: u32::from_le_bytes(bytes[12..].try_into().expect("four bytes")),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeshStream {
    Positions,
    Indices,
    SourceFaces,
    CornerNormals,
}
impl MeshStream {
    pub fn code(self) -> u32 {
        match self {
            Self::Positions => 1,
            Self::Indices => 2,
            Self::SourceFaces => 3,
            Self::CornerNormals => 4,
        }
    }
    pub fn scalar_bytes(self) -> usize {
        match self {
            Self::Positions | Self::CornerNormals => 8,
            Self::Indices | Self::SourceFaces => 4,
        }
    }
}

/// Numerical commands, independent of scheduling or IFC interpretation.
/// Box/cylinder coordinates are evaluation metres; tolerances are explicit.
#[derive(Debug, Clone)]
pub enum KernelCommand {
    AbiVersion,
    /// Additive capability negotiation; v1 commands stay unchanged.
    Capabilities,
    /// Declare one staged authored recipe (formats 1 and 2, see the C ABI).
    SweepBegin {
        session: u64,
        format: u32,
        length: u32,
        loops: u32,
        segments: u32,
    },
    /// Next sequential recipe bytes at `offset`.
    SweepChunk {
        session: u64,
        upload: u64,
        offset: u32,
        bytes: Vec<u8>,
    },
    /// Consume the upload and publish its validated solid. The ABI's abort
    /// (opcode 16) is not needed: a rejected chunk already discards the upload.
    SweepCommit {
        session: u64,
        upload: u64,
    },
    /// Copy then apply a proper rigid column-major metre transform.
    CopyTransform {
        session: u64,
        solid: WireHandle,
        column_major: [f64; 16],
    },
    CreateSession,
    DestroySession {
        session: u64,
    },
    Box {
        session: u64,
        origin: [f64; 3],
        size: [f64; 3],
    },
    Cylinder {
        session: u64,
        origin: [f64; 3],
        radius: f64,
        height: f64,
    },
    Boolean {
        session: u64,
        left: WireHandle,
        right: WireHandle,
        operation: BooleanOperation,
    },
    Volume {
        session: u64,
        solid: WireHandle,
        relative_accuracy: f64,
    },
    Manifold {
        session: u64,
        solid: WireHandle,
    },
    Release {
        session: u64,
        object: WireHandle,
    },
    Tessellate {
        session: u64,
        solid: WireHandle,
        chord_metres: f64,
        angle_degrees: f64,
    },
    MeshInfo {
        session: u64,
        mesh: WireHandle,
    },
    MeshRead {
        session: u64,
        mesh: WireHandle,
        stream: MeshStream,
        offset: u32,
        count: u32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolError {
    PayloadSize,
    Version,
    RequestId,
    InvalidUtf8,
    MeshChunkSize,
    ResultSize,
}
impl ProtocolError {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PayloadSize => "invalid kernel payload size",
            Self::Version => "unsupported kernel protocol version",
            Self::RequestId => "kernel response request ID mismatch",
            Self::InvalidUtf8 => "invalid UTF-8 in kernel error",
            Self::MeshChunkSize => "mesh transfer exceeds scalar chunk limit",
            Self::ResultSize => "unexpected kernel result size",
        }
    }
}
impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}
impl std::error::Error for ProtocolError {}

/// A borrowed response; callers copy/consume it before disposing the transport buffer.
#[derive(Debug, PartialEq, Eq)]
pub enum KernelResponse<'a> {
    Success(&'a [u8]),
    Failure { status: i32, message: &'a str },
}

/// Encode one bounded payload. IEEE float bits and every u64 token are preserved.
/// Geometric-domain validation is the executing boundary's responsibility.
pub fn encode_request(request_id: u32, command: &KernelCommand) -> Result<Vec<u8>, ProtocolError> {
    let mut out = Vec::with_capacity(96);
    out.extend(VERSION.to_le_bytes());
    out.extend(request_id.to_le_bytes());
    let opcode: u32 = match command {
        KernelCommand::AbiVersion => 0,
        KernelCommand::Capabilities => 12,
        KernelCommand::SweepBegin { .. } => 13,
        KernelCommand::SweepChunk { .. } => 14,
        KernelCommand::SweepCommit { .. } => 15,
        KernelCommand::CopyTransform { .. } => 17,
        KernelCommand::CreateSession => 1,
        KernelCommand::DestroySession { .. } => 2,
        KernelCommand::Box { .. } => 3,
        KernelCommand::Cylinder { .. } => 4,
        KernelCommand::Boolean { .. } => 5,
        KernelCommand::Volume { .. } => 6,
        KernelCommand::Manifold { .. } => 7,
        KernelCommand::Release { .. } => 8,
        KernelCommand::Tessellate { .. } => 9,
        KernelCommand::MeshInfo { .. } => 10,
        KernelCommand::MeshRead { .. } => 11,
    };
    out.extend(opcode.to_le_bytes());
    encode_arguments(command, &mut out)?;
    if out.len() > MAX_REQUEST_BYTES {
        return Err(ProtocolError::PayloadSize);
    }
    Ok(out)
}

fn encode_arguments(command: &KernelCommand, out: &mut Vec<u8>) -> Result<(), ProtocolError> {
    use KernelCommand::*;
    match command {
        AbiVersion | Capabilities | CreateSession => {}
        SweepBegin {
            session,
            format,
            length,
            loops,
            segments,
        } => {
            out.extend(session.to_le_bytes());
            for value in [format, length, loops, segments] {
                out.extend(value.to_le_bytes());
            }
        }
        SweepChunk {
            session,
            upload,
            offset,
            bytes,
        } => {
            let length = u32::try_from(bytes.len()).map_err(|_| ProtocolError::PayloadSize)?;
            if bytes.is_empty()
                || bytes.len() > MAX_SWEEP_CHUNK_BYTES
                || offset.checked_add(length).is_none()
            {
                return Err(ProtocolError::PayloadSize);
            }
            out.extend(session.to_le_bytes());
            out.extend(upload.to_le_bytes());
            out.extend(offset.to_le_bytes());
            out.extend(length.to_le_bytes());
            out.extend(bytes);
        }
        SweepCommit { session, upload } => {
            out.extend(session.to_le_bytes());
            out.extend(upload.to_le_bytes());
        }
        CopyTransform {
            session,
            solid,
            column_major,
        } => {
            write_solid(out, *session, *solid);
            for value in column_major {
                out.extend(value.to_le_bytes());
            }
        }
        DestroySession { session } => out.extend(session.to_le_bytes()),
        Box {
            session,
            origin,
            size,
        } => {
            out.extend(session.to_le_bytes());
            for value in origin.iter().chain(size) {
                out.extend(value.to_le_bytes());
            }
        }
        Cylinder {
            session,
            origin,
            radius,
            height,
        } => {
            out.extend(session.to_le_bytes());
            for value in origin.iter().chain([radius, height]) {
                out.extend(value.to_le_bytes());
            }
        }
        Boolean {
            session,
            left,
            right,
            operation,
        } => {
            out.extend(session.to_le_bytes());
            out.extend(left.to_bytes());
            out.extend(right.to_bytes());
            let code: u32 = match operation {
                BooleanOperation::Union => 1,
                BooleanOperation::Intersection => 2,
                BooleanOperation::Difference => 3,
            };
            out.extend(code.to_le_bytes());
        }
        Volume {
            session,
            solid,
            relative_accuracy,
        } => {
            write_solid(out, *session, *solid);
            out.extend(relative_accuracy.to_le_bytes());
        }
        Manifold { session, solid } => write_solid(out, *session, *solid),
        Release { session, object } => write_solid(out, *session, *object),
        Tessellate {
            session,
            solid,
            chord_metres,
            angle_degrees,
        } => {
            write_solid(out, *session, *solid);
            out.extend(chord_metres.to_le_bytes());
            out.extend(angle_degrees.to_le_bytes());
        }
        MeshInfo { session, mesh } => write_solid(out, *session, *mesh),
        MeshRead {
            session,
            mesh,
            stream,
            offset,
            count,
        } => {
            if *count > MAX_MESH_CHUNK_SCALARS || offset.checked_add(*count).is_none() {
                return Err(ProtocolError::MeshChunkSize);
            }
            write_solid(out, *session, *mesh);
            out.extend(stream.code().to_le_bytes());
            out.extend(offset.to_le_bytes());
            out.extend(count.to_le_bytes());
        }
    }
    Ok(())
}

fn write_solid(out: &mut Vec<u8>, session: u64, solid: WireHandle) {
    out.extend(session.to_le_bytes());
    out.extend(solid.to_bytes());
}

/// Validate response framing fields before any result bytes are trusted.
pub fn decode_response(request_id: u32, bytes: &[u8]) -> Result<KernelResponse<'_>, ProtocolError> {
    if !(12..=MAX_RESPONSE_BYTES).contains(&bytes.len()) {
        return Err(ProtocolError::PayloadSize);
    }
    if bytes[..4] != VERSION.to_le_bytes() {
        return Err(ProtocolError::Version);
    }
    if bytes[4..8] != request_id.to_le_bytes() {
        return Err(ProtocolError::RequestId);
    }
    let status = i32::from_le_bytes(bytes[8..12].try_into().expect("four bytes"));
    if status == 0 {
        return Ok(KernelResponse::Success(&bytes[12..]));
    }
    let message = std::str::from_utf8(&bytes[12..]).map_err(|_| ProtocolError::InvalidUtf8)?;
    Ok(KernelResponse::Failure { status, message })
}

#[cfg(test)]
#[path = "protocol_tests.rs"]
mod tests;
