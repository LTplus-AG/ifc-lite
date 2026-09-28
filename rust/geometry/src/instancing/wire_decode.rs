// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The IFNS decoders, split from `wire.rs` (module-size ratchet) when #5984
//! appended trailing field 2. `wire.rs` stays the encoder and the layout's
//! constants; the format itself is documented in `instancing/mod.rs`.

use super::wire::{
    DecodedInstance, DecodedInstanced, DecodedTemplate, HEADER_BYTES, INSTANCED_MAGIC,
    INSTANCE_FINISH_OFFSET, INSTANCE_ITEM_ID_OFFSET, INSTANCE_RECORD_BASE_BYTES,
    INSTANCE_RECORD_ITEM_ID_BYTES, TEMPLATE_RECORD_BYTES,
};

/// Decode an instanced shard. Returns None on a bad magic/version or truncation.
pub fn decode_instanced(bytes: &[u8]) -> Option<DecodedInstanced> {
    let ru32 = |o: usize| -> Option<u32> {
        bytes.get(o..o + 4).map(|s| u32::from_le_bytes(s.try_into().unwrap()))
    };
    let rf32 = |o: usize| -> Option<f32> {
        bytes.get(o..o + 4).map(|s| f32::from_le_bytes(s.try_into().unwrap()))
    };
    let rf64 = |o: usize| -> Option<f64> {
        bytes.get(o..o + 8).map(|s| f64::from_le_bytes(s.try_into().unwrap()))
    };
    // PERMISSIVE on version, STRICT on stride. Rejecting a version above this
    // build's would reject exactly the shards forward compatibility is for: a
    // v3 that APPENDS a trailing field is still fully readable here, because
    // every field this build knows sits at a fixed offset inside the base
    // record and the declared stride steps over the tail it does not know.
    // Refusing it would also have rejected the v1 shards already sitting in
    // browser caches, which persist IFNS bytes verbatim rather than re-encoding
    // — a silent loss of all instanced geometry on every existing entry.
    // Version 0 is not a version.
    let version = ru32(4)?;
    if ru32(0)? != INSTANCED_MAGIC || version == 0 {
        return None;
    }
    let template_count = ru32(8)? as usize;
    let instance_count = ru32(12)? as usize;
    let positions_len = ru32(16)? as usize;
    let normals_len = ru32(20)? as usize;
    let _indices_len = ru32(24)? as usize;
    // Word 7 is `reserved` in v1 and the instance record STRIDE from v2 on. v1
    // wrote a literal 0 there, which is not a legal stride, so both readings of
    // a v1 shard land on the 88-byte base record.
    let declared_stride = if version >= 2 { ru32(28)? as usize } else { 0 };
    let inst_bytes = if declared_stride == 0 {
        INSTANCE_RECORD_BASE_BYTES
    } else {
        declared_stride
    };
    // A stride below the base is not a shorter record, it is a corrupt header:
    // the base fields are not optional. Reading at it would slice each record
    // out of its predecessor's transform and yield plausible garbage. An
    // UNALIGNED stride is refused beside it, in BOTH languages: every field on
    // this wire is 4 bytes, so a boundary off a 4-byte multiple names no field,
    // and the TS decoder cannot even attempt one — it views the data pools as
    // `Float32Array` over the shard buffer, which throws an opaque `RangeError`
    // where this decoder used to read the same bytes happily.
    if inst_bytes < INSTANCE_RECORD_BASE_BYTES || inst_bytes % 4 != 0 {
        return None;
    }

    // Checked throughout: `instance_count` and the stride are both attacker-
    // controlled u32s, so their product overflows a 32-bit usize (wasm32) and
    // can reach 2^64 on a 64-bit host. An overflow here would wrap the data
    // offset back INSIDE the buffer and every bounds check below would pass.
    let tt_off = HEADER_BYTES;
    let it_off = tt_off.checked_add(template_count.checked_mul(TEMPLATE_RECORD_BYTES)?)?;
    let data_off = it_off.checked_add(instance_count.checked_mul(inst_bytes)?)?;
    let nrm_data = data_off.checked_add(positions_len.checked_mul(4)?)?;
    let idx_data = nrm_data.checked_add(normals_len.checked_mul(4)?)?;

    // A corrupt/hostile header can claim an arbitrary template_count or
    // instance_count. Bound both against the buffer we actually have BEFORE
    // sizing `Vec::with_capacity` below — otherwise a bogus huge count tries
    // to reserve gigabytes (or aborts the process via the allocator's OOM
    // handler) long before the per-field `ru32`/`rf32` reads below would ever
    // get a chance to fail gracefully and return `None`. This is also what
    // validates the declared stride against the buffer: a stride that does not
    // fit the instance table it describes cannot reach the data pools.
    if bytes.len() < data_off {
        return None;
    }

    // Byte offset of element `k` of the pool at `base` whose template range
    // starts at element `off` — checked against the same attacker-controlled
    // u32s, and what makes "Checked throughout" above true of the pool reads
    // too. On wasm32 (usize = 32 bits) `pos_off = 0xFFFFFFFF` overflows
    // `base + (off + k) * 4`: debug traps rather than returning the promised
    // `None`, release wraps back INSIDE the buffer and returns WRONG geometry.
    let elem = |base: usize, off: usize, k: usize| -> Option<usize> {
        base.checked_add(off.checked_add(k)?.checked_mul(4)?)
    };

    let mut templates = Vec::with_capacity(template_count);
    for t in 0..template_count {
        let r = tt_off + t * TEMPLATE_RECORD_BYTES;
        let pos_off = ru32(r)? as usize;
        let pos_len = ru32(r + 4)? as usize;
        let nrm_off = ru32(r + 8)? as usize;
        let nrm_len = ru32(r + 12)? as usize;
        let i_off = ru32(r + 16)? as usize;
        let i_len = ru32(r + 20)? as usize;
        let origin = [rf64(r + 24)?, rf64(r + 32)?, rf64(r + 40)?];
        let positions = (0..pos_len)
            .map(|k| rf32(elem(data_off, pos_off, k)?))
            .collect::<Option<Vec<f32>>>()?;
        let normals = (0..nrm_len)
            .map(|k| rf32(elem(nrm_data, nrm_off, k)?))
            .collect::<Option<Vec<f32>>>()?;
        let indices = (0..i_len)
            .map(|k| ru32(elem(idx_data, i_off, k)?))
            .collect::<Option<Vec<u32>>>()?;
        templates.push(DecodedTemplate { positions, normals, indices, origin });
    }

    let mut instances = Vec::with_capacity(instance_count);
    for i in 0..instance_count {
        let r = it_off + i * inst_bytes;
        let template_index = ru32(r)?;
        let entity_id = ru32(r + 4)?;
        let mut color = [0.0f32; 4];
        for (k, c) in color.iter_mut().enumerate() {
            *c = rf32(r + 8 + k * 4)?;
        }
        let mut transform = [0.0f32; 16];
        for (k, v) in transform.iter_mut().enumerate() {
            *v = rf32(r + 24 + k * 4)?;
        }
        // Trailing field 1, present only when the stride makes room for it.
        // Anything the stride reaches BEYOND it is a field appended by a newer
        // producer: skipped, not an error — that is the forward compatibility
        // the stride buys. 0 is the producer's "no item" sentinel (STEP names
        // start at #1), and a shard without the field has none at all — both
        // surface as None, so a consumer cannot tell an absent id apart from a
        // fabricated #0.
        let item_id = if inst_bytes >= INSTANCE_RECORD_ITEM_ID_BYTES {
            Some(ru32(r + INSTANCE_ITEM_ID_OFFSET)?).filter(|&id| id != 0)
        } else {
            None
        };
        instances.push(DecodedInstance { template_index, entity_id, color, transform, item_id });
    }
    Some(DecodedInstanced { templates, instances })
}


/// Trailing field 2 of every instance record, in instance order (#5984):
/// `[metallic, roughness]`, NaN where unauthored. A shard whose stride does
/// not reach the field (v1, v2, or a v3 written by a model without finishes)
/// reads as all-NaN rather than failing, the same forward/backward rule the
/// item id follows. `None` exactly when [`decode_instanced`] would refuse the
/// header or the instance table does not fit the buffer.
pub fn decode_instance_finishes(bytes: &[u8]) -> Option<Vec<[f32; 2]>> {
    let ru32 = |o: usize| bytes.get(o..o + 4).map(|s| u32::from_le_bytes(s.try_into().unwrap()));
    let rf32 = |o: usize| bytes.get(o..o + 4).map(|s| f32::from_le_bytes(s.try_into().unwrap()));
    let version = ru32(4)?;
    if ru32(0)? != INSTANCED_MAGIC || version == 0 {
        return None;
    }
    let template_count = ru32(8)? as usize;
    let instance_count = ru32(12)? as usize;
    let declared = if version >= 2 { ru32(28)? as usize } else { 0 };
    let stride = if declared == 0 { INSTANCE_RECORD_BASE_BYTES } else { declared };
    if stride < INSTANCE_RECORD_BASE_BYTES || stride % 4 != 0 {
        return None;
    }
    let it_off = HEADER_BYTES.checked_add(template_count.checked_mul(TEMPLATE_RECORD_BYTES)?)?;
    if bytes.len() < it_off.checked_add(instance_count.checked_mul(stride)?)? {
        return None;
    }
    let carries = stride >= INSTANCE_FINISH_OFFSET + 8;
    (0..instance_count)
        .map(|i| {
            let r = it_off + i * stride + INSTANCE_FINISH_OFFSET;
            Some(if carries { [rf32(r)?, rf32(r + 4)?] } else { [f32::NAN; 2] })
        })
        .collect()
}

#[cfg(test)]
#[path = "wire_finish_tests.rs"]
mod finish_tests;
