// SPDX-License-Identifier: MPL-2.0
//! Source construction correspondence, shared by native and actual Worker readers.
//! Decoding numbers alone grants no authority. Production receipts retain this
//! exact request allocation, and processing checks its original source leases.
use super::RetainedRequest;
use crate::resource::{Cost, OwnedResourceContext, Reservation};

/// Admission made before copying a triangle-root stream. Owned by its proof,
/// so sharing that proof cannot refund its backing while a reader retains it.
#[derive(Debug)]
pub struct SourceTriangleAdmission {
    count: usize,
    _permit: Reservation,
}
impl SourceTriangleAdmission {
    pub fn new(count: usize, resources: &OwnedResourceContext) -> Result<Self, &'static str> {
        let bytes = count.checked_mul(4).ok_or("source triangle byte overflow")?;
        let permit = resources.charge(Cost {
            live_bytes: bytes as u64, copy_bytes: bytes as u64, ..Default::default()
        }).map_err(|_| "captured source triangle backing account")?;
        Ok(Self { count, _permit: permit })
    }
}


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConstructionRole {
    SweptSegment(u32),
    StartCap,
    EndCap,
}

#[derive(Debug)]
pub struct SourceCorrespondence {
    request: RetainedRequest,
    packet: Vec<u8>,
    roles: Vec<ConstructionRole>,
    triangles: Vec<u32>,
    _inventory_storage: Reservation,
    _triangle_storage: Option<SourceTriangleAdmission>,
}
impl SourceCorrespondence {
    pub fn descriptor(request: &RetainedRequest) -> Vec<u8> {
        let Some((epoch, revision)) = request.source_contract() else {
            return Vec::new();
        };
        let mut bytes = Vec::with_capacity(32);
        bytes.extend(1u32.to_le_bytes());
        bytes.extend(request.worker_incarnation().to_le_bytes());
        bytes.extend(epoch.to_le_bytes());
        bytes.extend(revision.to_le_bytes());
        bytes.extend(request.recipe().solid_id().to_le_bytes());
        bytes
    }

    /// Host-trusted numerical decoding only; never constructs a runtime lease.
    pub fn decode(
        request: &RetainedRequest,
        current: &[u8],
        packet: &[u8],
    ) -> Result<Self, &'static str> {
        let fail = "invalid source construction inventory";
        if current.len() != 16
            || packet.len() < 80
            || packet.len() > 3200
            || packet[4..20] != *current
        {
            return Err(fail);
        }
        let u32_at =
            |i| u32::from_le_bytes(packet[i..i + 4].try_into().expect("checked packet field"));
        let u64_at =
            |i| u64::from_le_bytes(packet[i..i + 8].try_into().expect("checked packet field"));
        let (epoch, revision) = request.source_contract().ok_or(fail)?;
        let count = u32_at(76) as usize;
        if u32_at(0) != 1
            || u32_at(72) != 1
            || count != request.payload().segments as usize + 2
            || count > 130
            || packet.len() != 80 + count * 24
            || u64_at(36) != request.worker_incarnation()
            || u64_at(44) != epoch
            || u64_at(52) != revision
            || u32_at(60) != request.recipe().solid_id()
            || u64_at(64) == 0
            || u64_at(20) == 0
            || u32_at(16) == 0
            || u32_at(32) == 0
            || packet[4..12] != packet[20..28]
        {
            return Err(fail);
        }
        let bytes = packet.len() + count * std::mem::size_of::<ConstructionRole>();
        let inventory_storage = OwnedResourceContext::capture_current().charge(Cost {
            live_bytes: bytes as u64, copy_bytes: bytes as u64, ..Default::default()
        }).map_err(|_| "source inventory budget")?;
        let mut roles = Vec::new();
        roles.try_reserve_exact(count).map_err(|_| "source inventory allocation")?;
        let domain = u64_at(80);
        for i in 0..count {
            let offset = 80 + i * 24;
            if domain == 0 || u64_at(offset) != domain || u64_at(offset + 8) == 0 {
                return Err(fail);
            }
            for j in 0..i {
                if u64_at(80 + j * 24 + 8) == u64_at(offset + 8) {
                    return Err(fail);
                }
            }
            let role = match (u32_at(offset + 16), u32_at(offset + 20)) {
                (1, n) if i < count - 2 && n as usize == i => ConstructionRole::SweptSegment(n),
                (2, 0) if i == count - 2 => ConstructionRole::StartCap,
                (3, 0) if i == count - 1 => ConstructionRole::EndCap,
                _ => return Err(fail),
            };
            roles.push(role);
        }
        let mut owned = Vec::new();
        owned.try_reserve_exact(packet.len()).map_err(|_| "source inventory allocation")?;
        owned.extend_from_slice(packet);
        Ok(Self {
            request: request.clone(),
            packet: owned,
            roles,
            triangles: Vec::new(),
            _inventory_storage: inventory_storage,
            _triangle_storage: None,
        })
    }
    pub fn is_initial_operation(&self, current: &[u8], operation: u64) -> bool {
        self.packet[20..36] == *current
            && u64::from_le_bytes(self.packet[64..72].try_into().expect("packet operation"))
                == operation
    }
    pub fn request(&self) -> &RetainedRequest {
        &self.request
    }
    pub fn roles(&self) -> &[ConstructionRole] {
        &self.roles
    }
    pub fn triangle_roots(&self) -> &[u32] {
        &self.triangles
    }
    /// Includes every root, its native generation, source identity and operation.
    /// Current copied object handles differ; original issuance never changes.
    pub fn same_source(&self, other: &Self) -> bool {
        self.request.same_admission(&other.request) && self.packet[20..] == other.packet[20..]
    }
    pub fn has_complete_coverage(&self) -> bool {
        if self.triangles.is_empty() { return false; }
        let mut seen = [false; 130];
        for &root in &self.triangles {
            if root as usize >= self.roles.len() { return false; }
            seen[root as usize] = true;
        }
        seen[..self.roles.len()].iter().all(|v| *v)
    }
    pub fn with_admitted_triangles(mut self, triangles: Vec<u32>, admission: SourceTriangleAdmission)
        -> Result<Self, &'static str> {
        let expected = admission.count;
        self._triangle_storage = Some(admission);
        self.with_triangles(triangles, expected)
    }
    /// Host-trusted numerical helper; production readers use pre-copy admission.
    pub fn with_triangles(
        mut self,
        triangles: Vec<u32>,
        expected: usize,
    ) -> Result<Self, &'static str> {
        if triangles.len() != expected
            || expected == 0
            || triangles.iter().any(|&r| r as usize >= self.roles.len())
        {
            return Err("invalid source triangle correspondence");
        }
        let mut seen = [false; 130];
        for &root in &triangles {
            seen[root as usize] = true;
        }
        if seen[..self.roles.len()].iter().any(|seen| !seen) {
            return Err("partial source triangle inventory");
        }
        self.triangles = triangles;
        Ok(self)
    }
}

#[cfg(test)]
#[path = "retained_source_tests.rs"]
mod tests;
