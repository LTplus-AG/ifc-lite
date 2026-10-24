// SPDX-License-Identifier: MPL-2.0
//! Wire identities are evidence only; neither this type nor a certificate owns a lease.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct WireHandle { pub session: u64, pub slot: u32, pub generation: u32 }
impl WireHandle {
    pub fn to_bytes(self) -> [u8; 16] {
        let mut bytes = [0; 16];
        bytes[..8].copy_from_slice(&self.session.to_le_bytes());
        bytes[8..12].copy_from_slice(&self.slot.to_le_bytes());
        bytes[12..].copy_from_slice(&self.generation.to_le_bytes());
        bytes
    }
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, &'static str> {
        let bytes: &[u8; 16] = bytes.try_into().map_err(|_| "invalid plane wire handle")?;
        Ok(Self { session: u64::from_le_bytes(bytes[..8].try_into().map_err(|_| "session")?),
            slot: u32::from_le_bytes(bytes[8..12].try_into().map_err(|_| "slot")?),
            generation: u32::from_le_bytes(bytes[12..].try_into().map_err(|_| "generation")?) })
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NumericalOutcome { NonEmpty, Empty }
