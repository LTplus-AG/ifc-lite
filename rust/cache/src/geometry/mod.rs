// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The chunked geometry section (`buildGeometrySectionV13`):
//!
//!   headLength u32   (bytes after this field, up to the first chunk)
//!   meshCount u32, totalVertices u32, totalTriangles u32,
//!   coordinateInfo, sourceIndexPool (v19: count u32 + arrays),
//!   chunkCount u32, directory[chunkCount] x 44 bytes
//!     { aabbMin f32x3, aabbMax f32x3, byteOffset u32 (from section start),
//!       byteLength u32 (stored), uncompressedLength u32, meshCount u32,
//!       flags u32 }
//!   chunk records, back to back from `4 + headLength`
//!
//! [`section`] writes it incrementally, for the in-memory and the streaming
//! writer alike.

pub(crate) mod chunks;
pub(crate) mod coordinate_info;
pub(crate) mod record;
pub(crate) mod section;

pub(crate) use section::{ChunkBody, GeometryHead, SectionWriter};
