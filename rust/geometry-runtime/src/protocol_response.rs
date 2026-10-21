// SPDX-License-Identifier: MPL-2.0
//! Kernel response frames and protocol errors, validated before any result
//! bytes are trusted.
use super::{MAX_RESPONSE_BYTES, VERSION};

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
