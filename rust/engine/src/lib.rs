// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Stable backend-neutral IFC engine facade.
//!
//! This crate exposes a small API surface that desktop/native hosts can depend on
//! without needing to know about WASM bindings or Tauri command shapes.

use ifc_lite_processing::{
    process_geometry, process_geometry_filtered, process_geometry_streaming_with_options_and_bootstrap,
    CoordinateInfo, ModelMetadata, ProcessingResult, ProcessingStats,
    StreamingOptions as ProcessingStreamingOptions,
};
use memmap2::Mmap;
use serde::{Deserialize, Serialize};
use std::{fs::File, io, path::Path, str::Utf8Error};

pub mod physics;

/// Streaming configuration for chunked geometry delivery.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct StreamOptions {
    /// Number of meshes per emitted chunk.
    pub batch_size: usize,
    /// Batch size used after the first emitted chunk.
    pub throughput_batch_size: usize,
    /// Prefer simple/high-yield geometry first.
    pub fast_first_batch: bool,
    /// Include property parsing on the first-frame path.
    pub include_properties: bool,
    /// Include presentation-layer resolution on the first-frame path.
    pub include_presentation_layers: bool,
    /// Emit a lightweight metadata bootstrap during the scan phase.
    pub emit_quick_metadata_bootstrap: bool,
    /// Retain emitted meshes in the returned EngineResult.
    pub retain_emitted_meshes: bool,
}

impl Default for StreamOptions {
    fn default() -> Self {
        Self {
            batch_size: 50,
            throughput_batch_size: 50,
            fast_first_batch: false,
            include_properties: true,
            include_presentation_layers: true,
            emit_quick_metadata_bootstrap: false,
            retain_emitted_meshes: true,
        }
    }
}

/// A chunk of processed geometry emitted by [`stream_ifc_text`] or [`stream_ifc_bytes`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeometryChunk {
    pub meshes: Vec<MeshData>,
    pub processed: usize,
    pub total: usize,
    pub current_type: String,
}

/// Stable, backend-neutral geometry result shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineResult {
    pub meshes: Vec<MeshData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_coordinate_space: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_transform: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub building_transform: Option<Vec<f64>>,
    pub metadata: ModelMetadata,
    pub stats: ProcessingStats,
}

impl From<ProcessingResult> for EngineResult {
    fn from(value: ProcessingResult) -> Self {
        Self {
            meshes: value.meshes,
            mesh_coordinate_space: value.mesh_coordinate_space,
            site_transform: value.site_transform,
            building_transform: value.building_transform,
            metadata: value.metadata,
            stats: value.stats,
        }
    }
}

impl EngineResult {
    pub fn coordinate_info(&self) -> &CoordinateInfo {
        &self.metadata.coordinate_info
    }
}

/// Process UTF-8 IFC text into the stable engine contract.
pub fn process_ifc_text(content: &str) -> EngineResult {
    process_geometry(content).into()
}

/// Process UTF-8 IFC text with a configurable opening filter.
pub fn process_ifc_text_filtered(content: &str, opening_filter: OpeningFilterMode) -> EngineResult {
    process_geometry_filtered(content, opening_filter).into()
}

/// Process IFC bytes into the stable engine contract.
pub fn process_ifc_bytes(buffer: &[u8]) -> Result<EngineResult, Utf8Error> {
    let content = std::str::from_utf8(buffer)?;
    Ok(process_ifc_text(content))
}

/// Process an IFC file from disk into the stable engine contract.
pub fn process_ifc_file(path: impl AsRef<Path>) -> io::Result<EngineResult> {
    let mmap = map_ifc_file(path.as_ref())?;
    let content = std::str::from_utf8(&mmap)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    Ok(process_ifc_text(content))
}

/// Process IFC bytes with a configurable opening filter.
pub fn process_ifc_bytes_filtered(
    buffer: &[u8],
    opening_filter: OpeningFilterMode,
) -> Result<EngineResult, Utf8Error> {
    let content = std::str::from_utf8(buffer)?;
    Ok(process_ifc_text_filtered(content, opening_filter))
}

/// Emit geometry chunks from UTF-8 IFC text using the stable engine contract.
pub fn stream_ifc_text(
    content: &str,
    options: StreamOptions,
    on_chunk: impl FnMut(GeometryChunk),
    on_color_update: impl FnMut(&[(u32, [f32; 4])]),
) -> EngineResult {
    stream_ifc_text_with_bootstrap(content, options, on_chunk, on_color_update, |_| {})
}

pub fn stream_ifc_text_with_bootstrap(
    content: &str,
    options: StreamOptions,
    mut on_chunk: impl FnMut(GeometryChunk),
    on_color_update: impl FnMut(&[(u32, [f32; 4])]),
    on_quick_metadata_bootstrap: impl FnMut(&QuickMetadataBootstrap),
) -> EngineResult {
    process_geometry_streaming_with_options_and_bootstrap(
        content,
        ProcessingStreamingOptions {
            initial_batch_size: options.batch_size.max(1),
            throughput_batch_size: options.throughput_batch_size.max(options.batch_size.max(1)),
            fast_first_batch: options.fast_first_batch,
            include_properties: options.include_properties,
            include_presentation_layers: options.include_presentation_layers,
            emit_quick_metadata_bootstrap: options.emit_quick_metadata_bootstrap,
            retain_emitted_meshes: options.retain_emitted_meshes,
        },
        |meshes, processed, total| {
        on_chunk(GeometryChunk {
            meshes: meshes.to_vec(),
            processed,
            total,
            current_type: if processed >= total {
                "complete".to_string()
            } else {
                "processing".to_string()
            },
        });
    },
        on_color_update,
        on_quick_metadata_bootstrap,
    )
    .into()
}

/// Emit geometry chunks from IFC bytes using the stable engine contract.
pub fn stream_ifc_bytes(
    buffer: &[u8],
    options: StreamOptions,
    on_chunk: impl FnMut(GeometryChunk),
    on_color_update: impl FnMut(&[(u32, [f32; 4])]),
) -> Result<EngineResult, Utf8Error> {
    let content = std::str::from_utf8(buffer)?;
    Ok(stream_ifc_text(content, options, on_chunk, on_color_update))
}

pub fn stream_ifc_bytes_with_bootstrap(
    buffer: &[u8],
    options: StreamOptions,
    on_chunk: impl FnMut(GeometryChunk),
    on_color_update: impl FnMut(&[(u32, [f32; 4])]),
    on_quick_metadata_bootstrap: impl FnMut(&QuickMetadataBootstrap),
) -> Result<EngineResult, Utf8Error> {
    let content = std::str::from_utf8(buffer)?;
    Ok(stream_ifc_text_with_bootstrap(
        content,
        options,
        on_chunk,
        on_color_update,
        on_quick_metadata_bootstrap,
    ))
}

/// Emit geometry chunks from an IFC file on disk using the stable engine contract.
pub fn stream_ifc_file(
    path: impl AsRef<Path>,
    options: StreamOptions,
    on_chunk: impl FnMut(GeometryChunk),
    on_color_update: impl FnMut(&[(u32, [f32; 4])]),
) -> io::Result<EngineResult> {
    stream_ifc_file_with_bootstrap(path, options, on_chunk, on_color_update, |_| {})
}

pub fn stream_ifc_file_with_bootstrap(
    path: impl AsRef<Path>,
    options: StreamOptions,
    on_chunk: impl FnMut(GeometryChunk),
    on_color_update: impl FnMut(&[(u32, [f32; 4])]),
    on_quick_metadata_bootstrap: impl FnMut(&QuickMetadataBootstrap),
) -> io::Result<EngineResult> {
    let mmap = map_ifc_file(path.as_ref())?;
    let content = std::str::from_utf8(&mmap)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    Ok(stream_ifc_text_with_bootstrap(
        content,
        options,
        on_chunk,
        on_color_update,
        on_quick_metadata_bootstrap,
    ))
}

fn map_ifc_file(path: &Path) -> io::Result<Mmap> {
    let file = File::open(path)?;
    // SAFETY: the file handle remains alive for the lifetime of the returned mmap.
    unsafe { Mmap::map(&file) }
}

pub use ifc_lite_processing::{
    MeshData, OpeningFilterMode, QuickMetadataBootstrap, QuickMetadataEntitySummary,
    QuickMetadataSpatialNode,
};
