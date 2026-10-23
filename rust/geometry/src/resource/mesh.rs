// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Audited mesh copy/merge admission. These helpers account requested backing
//! storage, not allocator overhead or opaque numerical producer allocations.

use super::{Cost, ProgramStop, Reservation};
use crate::mesh::{Mesh, PlaneTag};

/// Length-only input permits overflow qualification without huge allocations.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct MeshLengths {
    pub positions: usize,
    pub normals: usize,
    pub indices: usize,
    pub planes: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MeshAdmissionError {
    Representation,
    Allocation,
}

impl MeshLengths {
    pub(crate) fn of(mesh: &Mesh) -> Self {
        Self {
            positions: mesh.positions.len(),
            normals: mesh.normals.len(),
            indices: mesh.indices.len(),
            planes: mesh.plane_tags.as_ref().map_or(0, Vec::len),
        }
    }

    pub(crate) fn bytes(self) -> Result<u64, MeshAdmissionError> {
        self.bytes_with_limit(isize::MAX as usize)
    }

    fn bytes_with_limit(self, maximum_bytes: usize) -> Result<u64, MeshAdmissionError> {
        u32::try_from(self.positions / 3).map_err(|_| MeshAdmissionError::Representation)?;
        let mut bytes = 0u64;
        for count in [self.positions, self.normals, self.indices] {
            bytes = bytes
                .checked_add(checked_buffer_with_limit(count, 4, maximum_bytes)?)
                .ok_or(MeshAdmissionError::Representation)?;
        }
        bytes
            .checked_add(checked_buffer_with_limit(
                self.planes,
                std::mem::size_of::<PlaneTag>(),
                maximum_bytes,
            )?)
            .ok_or(MeshAdmissionError::Representation)
    }
}

/// Backing retained when an existing mesh moves into a cache. Deep copies use
/// logical lengths instead; spare Vec capacity is resident but is not copied.
pub(crate) fn resident_bytes(mesh: &Mesh) -> Result<u64, MeshAdmissionError> {
    MeshLengths::of(mesh).bytes()?;
    [
        (mesh.positions.capacity(), 4),
        (mesh.normals.capacity(), 4),
        (mesh.indices.capacity(), 4),
        (
            mesh.plane_tags.as_ref().map_or(0, Vec::capacity),
            std::mem::size_of::<PlaneTag>(),
        ),
    ]
    .into_iter()
    .try_fold(0u64, |sum, (count, width)| {
        sum.checked_add(checked_buffer(count, width)?)
            .ok_or(MeshAdmissionError::Representation)
    })
}

/// Every individual vector must fit the executing target's signed Vec extent.
/// The pure limit parameter also qualifies wasm32 arithmetic on native hosts.
fn checked_buffer(count: usize, width: usize) -> Result<u64, MeshAdmissionError> {
    checked_buffer_with_limit(count, width, isize::MAX as usize)
}

fn checked_buffer_with_limit(
    count: usize,
    width: usize,
    maximum_bytes: usize,
) -> Result<u64, MeshAdmissionError> {
    let bytes = count
        .checked_mul(width)
        .ok_or(MeshAdmissionError::Representation)?;
    if bytes > maximum_bytes {
        return Err(MeshAdmissionError::Representation);
    }
    u64::try_from(bytes).map_err(|_| MeshAdmissionError::Representation)
}

pub(crate) fn preflight_merge(
    target: MeshLengths,
    incoming: MeshLengths,
    maximum_index: Option<u32>,
) -> Result<MeshLengths, MeshAdmissionError> {
    preflight_merge_with_limit(target, incoming, maximum_index, isize::MAX as usize)
}

fn preflight_merge_with_limit(
    target: MeshLengths,
    incoming: MeshLengths,
    maximum_index: Option<u32>,
    maximum_bytes: usize,
) -> Result<MeshLengths, MeshAdmissionError> {
    let positions = target
        .positions
        .checked_add(incoming.positions)
        .ok_or(MeshAdmissionError::Representation)?;
    let normals = target
        .normals
        .checked_add(incoming.normals)
        .ok_or(MeshAdmissionError::Representation)?;
    let indices = target
        .indices
        .checked_add(incoming.indices)
        .ok_or(MeshAdmissionError::Representation)?;
    let offset =
        u32::try_from(target.positions / 3).map_err(|_| MeshAdmissionError::Representation)?;
    if positions / 3 > u32::MAX as usize {
        return Err(MeshAdmissionError::Representation);
    }
    if let Some(index) = maximum_index {
        offset
            .checked_add(index)
            .ok_or(MeshAdmissionError::Representation)?;
    }
    for count in [positions, normals, indices] {
        checked_buffer_with_limit(count, 4, maximum_bytes)?;
    }
    Ok(MeshLengths {
        positions,
        normals,
        indices,
        planes: target.planes,
    })
}

#[cfg(test)]
thread_local! { static RESERVE_EVENTS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }

fn reached_reservation() {
    #[cfg(test)]
    RESERVE_EVENTS.with(|events| events.set(events.get() + 1));
}

/// Prepare replacements together so a later allocation failure cannot leave
/// grown, unowned backing capacity attached to the surviving destination.
fn replacement<T: Copy>(
    source: &Vec<T>,
    additional: usize,
) -> Result<Option<Vec<T>>, MeshAdmissionError> {
    let length = source
        .len()
        .checked_add(additional)
        .ok_or(MeshAdmissionError::Representation)?;
    if source.capacity() >= length {
        return Ok(None);
    }
    let mut result = Vec::new();
    result
        .try_reserve_exact(length)
        .map_err(|_| MeshAdmissionError::Allocation)?;
    result.extend_from_slice(source);
    Ok(Some(result))
}

/// Reserve every destination before touching geometry, origin or RTC state.
/// Failed preparation drops its temporary replacements and leaves target intact.
/// The caller must admit cost and retain its permit BEFORE calling this helper.
pub(crate) fn reserve_merge(target: &mut Mesh, incoming: &Mesh) -> Result<(), MeshAdmissionError> {
    if incoming.is_empty() {
        return Ok(());
    }
    preflight_merge(
        MeshLengths::of(target),
        MeshLengths::of(incoming),
        incoming.indices.iter().copied().max(),
    )?;
    reached_reservation();
    let positions = replacement(&target.positions, incoming.positions.len())?;
    let normals = replacement(&target.normals, incoming.normals.len())?;
    let indices = replacement(&target.indices, incoming.indices.len())?;
    if let Some(buffer) = positions {
        target.positions = buffer;
    }
    if let Some(buffer) = normals {
        target.normals = buffer;
    }
    if let Some(buffer) = indices {
        target.indices = buffer;
    }
    Ok(())
}

/// Clone via fallible reservations. Metadata has no deep-owned allocations;
/// the optional plane vector does, and is included in both preflight and copy.
pub(crate) fn clone_reserved(source: &Mesh) -> Result<Mesh, MeshAdmissionError> {
    let lengths = MeshLengths::of(source);
    lengths.bytes()?;
    let mut target = Mesh::new();
    reached_reservation();
    target
        .positions
        .try_reserve_exact(lengths.positions)
        .map_err(|_| MeshAdmissionError::Allocation)?;
    target
        .normals
        .try_reserve_exact(lengths.normals)
        .map_err(|_| MeshAdmissionError::Allocation)?;
    target
        .indices
        .try_reserve_exact(lengths.indices)
        .map_err(|_| MeshAdmissionError::Allocation)?;
    let mut planes = Vec::new();
    planes
        .try_reserve_exact(lengths.planes)
        .map_err(|_| MeshAdmissionError::Allocation)?;
    target.positions.extend_from_slice(&source.positions);
    target.normals.extend_from_slice(&source.normals);
    target.indices.extend_from_slice(&source.indices);
    if let Some(tags) = &source.plane_tags {
        planes.extend_from_slice(tags);
        target.plane_tags = Some(planes);
    }
    target.rtc_applied = source.rtc_applied;
    target.origin = source.origin;
    target.instance_meta = source.instance_meta.clone();
    target.local_bounds = source.local_bounds;
    target.local_to_world = source.local_to_world;
    target.welded_in_object_frame = source.welded_in_object_frame;
    Ok(target)
}

fn terminal(error: MeshAdmissionError) -> ProgramStop {
    match error {
        MeshAdmissionError::Representation => super::overflow(),
        MeshAdmissionError::Allocation => super::allocation_failure(),
    }
}

/// The returned unique reservation must move with the clone's actual owner.
/// Shared raster payloads are not copied here; this helper operates on Mesh.
pub(crate) fn clone_mesh(source: &Mesh) -> Result<(Mesh, Reservation), ProgramStop> {
    let bytes = MeshLengths::of(source).bytes().map_err(terminal)?;
    let permit = super::charge(Cost {
        work: bytes / 4,
        copy_bytes: bytes,
        output_bytes: bytes,
        live_bytes: bytes,
        ..Cost::default()
    })?;
    let mesh = clone_reserved(source).map_err(terminal)?;
    Ok((mesh, permit))
}

/// Admission precedes reserve/copy, preserving the existing origin/RTC merge
/// algorithm and ordered triangle stream. No output mutation on refusal.
/// The permit covers each replacement backing while the old owner is alive.
pub(crate) fn merge_mesh(target: &mut Mesh, incoming: &Mesh) -> Result<Reservation, ProgramStop> {
    if incoming.is_empty() {
        return super::charge(Cost::default());
    }
    // Canonical merge does not copy the incoming optional plane metadata.
    let incoming_lengths = MeshLengths {
        planes: 0,
        ..MeshLengths::of(incoming)
    };
    let result =
        preflight_merge(MeshLengths::of(target), incoming_lengths, None).map_err(terminal)?;
    let bytes = incoming_lengths.bytes().map_err(terminal)?;
    let (live_bytes, moved_bytes) = [
        (
            target.positions.capacity(),
            target.positions.len(),
            result.positions,
        ),
        (
            target.normals.capacity(),
            target.normals.len(),
            result.normals,
        ),
        (
            target.indices.capacity(),
            target.indices.len(),
            result.indices,
        ),
    ]
    .into_iter()
    .try_fold((0u64, 0u64), |(live, moved), (capacity, old, length)| {
        if capacity >= length {
            return Ok((live, moved));
        }
        Ok((
            live.checked_add(checked_buffer(length, 4)?)
                .ok_or(MeshAdmissionError::Representation)?,
            moved
                .checked_add(checked_buffer(old, 4)?)
                .ok_or(MeshAdmissionError::Representation)?,
        ))
    })
    .map_err(terminal)?;
    let copy_bytes = bytes.checked_add(moved_bytes).ok_or_else(super::overflow)?;
    // reserve_merge's index preflight visits every incoming index before the
    // canonical copy loop. Charge that repeated scan before doing the walk.
    let work = (copy_bytes / 4)
        .checked_add(incoming.indices.len() as u64)
        .ok_or_else(super::overflow)?;
    let permit = super::charge(Cost {
        work,
        copy_bytes,
        output_bytes: bytes,
        live_bytes,
        ..Cost::default()
    })?;
    reserve_merge(target, incoming).map_err(terminal)?;
    target.merge(incoming);
    Ok(permit)
}

#[cfg(test)]
#[path = "mesh_tests.rs"]
mod tests;
