// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Format constants and the 64-byte header, mirroring
//! `packages/cache/src/types.ts` and `sections/header.ts`.
//!
//! Every value here is read by the TS reader, so each one names the TS
//! constant it must equal. The cross-language conformance gate
//! (`scripts/cache-native-conformance.mjs`) reads the native bytes back with
//! that reader, so a drifted constant fails there, not in the browser.

use crate::buf::Buf;

/// `MAGIC`: "IFCL" little-endian.
pub(crate) const MAGIC: u32 = 0x4C43_4649;
/// `FORMAT_VERSION`.
pub const FORMAT_VERSION: u16 = 28;
/// `HEADER_SIZE`.
pub(crate) const HEADER_SIZE: usize = 64;
/// `SECTION_ENTRY_SIZE`.
pub(crate) const SECTION_ENTRY_SIZE: usize = 16;
/// Bytes the header fields occupy before the zero padding (`header.ts`).
const HEADER_FIELDS: usize = 31;

/// `GEOMETRY_CHUNK_CELL_SIZE`.
pub(crate) const GEOMETRY_CHUNK_CELL_SIZE: f64 = 32.0;
/// `GEOMETRY_CHUNK_SOFT_BYTES`.
pub(crate) const GEOMETRY_CHUNK_SOFT_BYTES: usize = 8 * 1024 * 1024;
/// `GEOMETRY_CHUNK_COMPRESS_MIN_BYTES`.
pub(crate) const GEOMETRY_CHUNK_COMPRESS_MIN_BYTES: usize = 64 * 1024;
/// `GeometryChunkFlags.DeflateRaw`.
pub(crate) const CHUNK_FLAG_DEFLATE_RAW: u32 = 1;

/// `SectionType`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u16)]
pub(crate) enum SectionType {
    Strings = 1,
    Entities = 2,
    Properties = 3,
    Quantities = 4,
    Relationships = 5,
    Geometry = 6,
    EntityIndex = 9,
}

/// `HeaderFlags`. `HasSpatial` (bit 2) is never set, exactly as the TS
/// writer: no Spatial section exists to back it.
pub(crate) mod header_flags {
    /// `HeaderFlags.HasGeometry`.
    pub(crate) const HAS_GEOMETRY: u16 = 1 << 1;
    /// `HeaderFlags.SourceHashUnset`: bit 3. The fork prototype had it at bit
    /// 4, so the TS reader took a deliberately zeroed hash for a real one and
    /// `read({ sourceBuffer })` refused a valid cache.
    pub(crate) const SOURCE_HASH_UNSET: u16 = 1 << 3;
}

/// `SchemaVersion`: IFC2X3 = 0, IFC4 = 1, IFC4X3 = 2. Anything else (IFC5)
/// takes the IFC2X3 slot, the documented fallback of `toCacheDataStore`.
pub(crate) fn schema_byte(schema: &str) -> u8 {
    match schema {
        "IFC4" => 1,
        "IFC4X3" => 2,
        _ => 0,
    }
}

pub(crate) struct Header {
    pub(crate) flags: u16,
    pub(crate) source_hash: u64,
    pub(crate) schema: u8,
    pub(crate) entity_count: u32,
    pub(crate) total_vertices: u32,
    pub(crate) total_triangles: u32,
}

pub(crate) struct SectionEntry {
    pub(crate) section_type: SectionType,
    pub(crate) offset: u32,
    pub(crate) size: u32,
}

/// `writeHeader`: the header, zero padding to 64 bytes, then the section
/// table (flags and compressedSize are always 0: no section is compressed).
pub(crate) fn write_header(buf: &mut Buf, header: &Header, sections: &[SectionEntry]) {
    buf.u32(MAGIC);
    buf.u16(FORMAT_VERSION);
    buf.u16(header.flags);
    buf.u64(header.source_hash);
    buf.u8(header.schema);
    buf.u32(header.entity_count);
    buf.u32(header.total_vertices);
    buf.u32(header.total_triangles);
    buf.u16(sections.len() as u16);
    for _ in HEADER_FIELDS..HEADER_SIZE {
        buf.u8(0);
    }
    for section in sections {
        buf.u16(section.section_type as u16);
        buf.u16(0);
        buf.u32(section.offset);
        buf.u32(section.size);
        buf.u32(0);
    }
}
