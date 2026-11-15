// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! One mesh record inside a geometry chunk: `writeMeshRecord` in
//! `sections/geometry.ts`, format v28.
//!
//!   expressId u32, vertexCount u32, indexCount u32, color f32x4,
//!   ifcType (u32 length + UTF-8), geometryClass u8,
//!   geometryItemId u32, materialId u32   (0xFFFFFFFF = absent, v14)
//!   origin f64x3                         (v6)
//!   positions f32[], normals f32[], indices u32[],
//!   provenance mode u8                   (v19; payload only for mode >= 2)
//!   metallic f32, roughness f32          (v22; NaN = absent)
//!   metadata flags u8 + payloads         (v25: shadingColor f32x4,
//!                                         localBounds f32x6, localToWorld f64x16)

use crate::buf::Buf;

/// The v14 absent source id. Not 0: `#0` can decode as a material-free layer.
const ABSENT_SOURCE_ID: u32 = u32::MAX;

/// `mesh-metadata.ts` flags.
const SHADING_COLOR: u8 = 1;
const LOCAL_BOUNDS: u8 = 2;
const LOCAL_TO_WORLD: u8 = 4;

/// A mesh as the cache stores it: already in the viewer's Y-up frame (see
/// `pipeline.rs`), with every optional field the record can carry.
#[derive(Clone, Debug)]
pub(crate) struct CacheMesh {
    pub(crate) express_id: u32,
    pub(crate) ifc_type: String,
    pub(crate) positions: Vec<f32>,
    pub(crate) normals: Vec<f32>,
    pub(crate) indices: Vec<u32>,
    pub(crate) color: [f32; 4],
    pub(crate) geometry_class: u8,
    pub(crate) geometry_item_id: Option<u32>,
    pub(crate) material_id: Option<u32>,
    pub(crate) origin: [f64; 3],
    pub(crate) metallic: Option<f32>,
    pub(crate) roughness: Option<f32>,
    /// Always `None` from the native pipeline (see the crate docs); kept so
    /// the record layout is complete and tested.
    pub(crate) shading_color: Option<[f32; 4]>,
    pub(crate) local_bounds: Option<[f32; 6]>,
    pub(crate) local_to_world: Option<[f64; 16]>,
}

impl CacheMesh {
    fn metadata_flags(&self) -> u8 {
        let mut flags = 0;
        if self.shading_color.is_some() {
            flags |= SHADING_COLOR;
        }
        if self.local_bounds.is_some() {
            flags |= LOCAL_BOUNDS;
        }
        if self.local_to_world.is_some() {
            flags |= LOCAL_TO_WORLD;
        }
        flags
    }

    /// `meshRecordByteLength`: the chunk byte budget is applied with it.
    pub(crate) fn record_len(&self) -> usize {
        4 + 4 + 4 + 16 + 4 + self.ifc_type.len() + 1 + 8 + 24 + 8
            + 1
            + self.shading_color.map_or(0, |_| 16)
            + self.local_bounds.map_or(0, |_| 24)
            + self.local_to_world.map_or(0, |_| 128)
            + (self.positions.len() + self.normals.len() + self.indices.len()) * 4
            + 1
    }

    pub(crate) fn write(&self, buf: &mut Buf) {
        buf.u32(self.express_id);
        buf.u32((self.positions.len() / 3) as u32);
        buf.u32(self.indices.len() as u32);
        buf.f32s(&self.color);
        buf.string(&self.ifc_type);
        buf.u8(self.geometry_class);
        buf.u32(self.geometry_item_id.unwrap_or(ABSENT_SOURCE_ID));
        buf.u32(self.material_id.unwrap_or(ABSENT_SOURCE_ID));
        for axis in self.origin {
            buf.f64(axis);
        }
        buf.f32s(&self.positions);
        buf.f32s(&self.normals);
        buf.u32s(&self.indices);
        // Appearance provenance mode 0: unmarked (see the crate docs).
        buf.u8(0);
        buf.f32(self.metallic.unwrap_or(f32::NAN));
        buf.f32(self.roughness.unwrap_or(f32::NAN));
        buf.u8(self.metadata_flags());
        if let Some(color) = self.shading_color {
            buf.f32s(&color);
        }
        if let Some(bounds) = self.local_bounds {
            buf.f32s(&bounds);
        }
        if let Some(matrix) = self.local_to_world {
            for value in matrix {
                buf.f64(value);
            }
        }
    }

    /// `cellKeyOf`'s anchor: origin plus the first vertex, in f64.
    pub(crate) fn anchor(&self) -> [f64; 3] {
        let first = |axis: usize| self.positions.get(axis).filter(|_| self.positions.len() >= 3);
        std::array::from_fn(|axis| self.origin[axis] + first(axis).map_or(0.0, |v| f64::from(*v)))
    }
}

#[cfg(test)]
#[path = "record_tests.rs"]
pub(crate) mod tests;
