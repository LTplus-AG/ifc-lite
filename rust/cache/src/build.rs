// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Section assembly: `BinaryCacheWriter.write` in `packages/cache/src/writer.ts`.
//!
//! Sections in the TS order: Strings, Entities, Properties, Quantities,
//! Relationships, EntityIndex, then Geometry when requested. The header and
//! section table come first; offsets are absolute and u32, so a cache past
//! 4 GiB is refused rather than wrapped.
//!
//! Geometry is last, and its chunk records are the tail of the file, so both
//! writers share everything here: [`Scalars`] before the geometry pass, then
//! [`prefix`] (every byte before the first chunk record) after it. The
//! in-memory writer appends a `Vec` body to the prefix; the streaming writer
//! copies its spool after it.

use ifc_lite_processing::data_model::{
    extract_data_model_with, DataModelEntities, DataModelExtraction, DataModelOptions,
};

use crate::buf::Buf;
use crate::format::{
    header_flags, schema_byte, write_header, Header, Limits, SectionEntry, SectionType,
    HEADER_SIZE, SECTION_ENTRY_SIZE,
};
use crate::geometry::{GeometryHead, SectionWriter};
use crate::strings::StringTable;
use crate::{entities, entity_index, pipeline, relationships, row_facts};
use crate::{CacheError, CacheOptions, CacheStats};

/// An empty PropertyTable / QuantityTable section: count 0, no columns, three
/// empty row indices. Byte-identical for both (`writeProperties`,
/// `writeQuantities`), and what the TS writer emits for a STEP-parsed store.
const EMPTY_TABLE: [u8; 16] = [0; 16];

/// The sections that do not depend on the geometry pass.
pub(crate) struct Scalars {
    sections: Vec<(SectionType, Vec<u8>)>,
    total_entities: usize,
    entity_rows: usize,
    include_geometry: bool,
}

impl Scalars {
    pub(crate) fn extract(source: &[u8], options: &CacheOptions) -> Result<Self, CacheError> {
        let DataModelExtraction { model, total_entities, .. } = extract_data_model_with(
            source,
            DataModelOptions {
                entities: DataModelEntities::Rooted,
                properties: false,
                quantities: false,
            },
        );
        let mut strings = StringTable::new();
        let facts = row_facts::row_facts(source, &model.entities);
        let entities = entities::write_entities(&mut strings, &model.entities, &facts);
        let sections = vec![
            (SectionType::Strings, strings.write()),
            (SectionType::Entities, entities),
            (SectionType::Properties, EMPTY_TABLE.to_vec()),
            (SectionType::Quantities, EMPTY_TABLE.to_vec()),
            (SectionType::Relationships, relationships::write_relationships(&model.relationships)),
            (SectionType::EntityIndex, entity_index::write_entity_index(source)?),
        ];
        Ok(Self {
            sections,
            total_entities,
            entity_rows: model.entities.len(),
            include_geometry: options.include_geometry,
        })
    }

    fn table_end(&self) -> usize {
        let count = self.sections.len() + usize::from(self.include_geometry);
        HEADER_SIZE + count * SECTION_ENTRY_SIZE
    }

    /// Where the Geometry section will start: right after the scalar ones.
    pub(crate) fn geometry_start(&self) -> u64 {
        (self.table_end() + self.sections.iter().map(|(_, bytes)| bytes.len()).sum::<usize>()) as u64
    }
}

/// The geometry pass's output, for the header and table.
pub(crate) struct Geometry {
    pub(crate) head: GeometryHead,
    pub(crate) schema: &'static str,
}

/// Every byte before the first chunk record, and the stats of the whole
/// file. The file is `prefix` followed by the `head.body_length` body bytes.
pub(crate) fn prefix(
    source: &[u8],
    options: &CacheOptions,
    scalars: Scalars,
    geometry: Option<Geometry>,
    limits: Limits,
) -> Result<(Vec<u8>, CacheStats), CacheError> {
    debug_assert_eq!(scalars.include_geometry, geometry.is_some());
    let table_end = scalars.table_end();
    let Scalars { sections, total_entities, entity_rows, .. } = scalars;
    let mut stats = CacheStats {
        entity_count: total_entities as u64,
        entity_rows: entity_rows as u64,
        ..CacheStats::default()
    };
    let mut flags = 0;
    let mut lengths: Vec<(SectionType, u64)> =
        sections.iter().map(|(section_type, bytes)| (*section_type, bytes.len() as u64)).collect();
    let schema = match &geometry {
        Some(Geometry { head, schema }) => {
            stats.mesh_count = head.mesh_count;
            stats.skipped_meshes = head.skipped_meshes;
            stats.chunk_count = head.chunk_count;
            stats.total_vertices = u64::from(head.total_vertices);
            stats.total_triangles = u64::from(head.total_triangles);
            stats.chunk_cells = head.chunk_cells;
            stats.peak_open_chunk_bytes = head.peak_open_chunk_bytes;
            flags |= header_flags::HAS_GEOMETRY;
            lengths.push((SectionType::Geometry, head.section_length()));
            *schema
        }
        None => ifc_lite_processing::detect_schema_version(source),
    };

    let source_hash = if options.omit_source_hash {
        flags |= header_flags::SOURCE_HASH_UNSET;
        0
    } else {
        twox_hash::XxHash64::oneshot(0, source)
    };

    let total = table_end as u64 + lengths.iter().map(|(_, length)| length).sum::<u64>();
    if total > limits.max_bytes {
        return Err(CacheError::TooLarge(total));
    }
    // Every offset and size is at most `total`, which fits u32 by the check.
    let mut offset = table_end as u64;
    let table: Vec<SectionEntry> = lengths
        .iter()
        .map(|(section_type, length)| {
            let entry = SectionEntry { section_type: *section_type, offset: offset as u32, size: *length as u32 };
            offset += length;
            entry
        })
        .collect();

    let header = Header {
        flags,
        source_hash,
        schema: schema_byte(schema),
        entity_count: total_entities as u32,
        total_vertices: stats.total_vertices as u32,
        total_triangles: stats.total_triangles as u32,
    };
    let body_length = geometry.as_ref().map_or(0, |g| g.head.body_length);
    let mut out = Buf::with_capacity((total - body_length) as usize);
    write_header(&mut out, &header, &table);
    for (_, bytes) in &sections {
        out.bytes(bytes);
    }
    if let Some(Geometry { head, .. }) = &geometry {
        out.bytes(&head.bytes);
    }
    stats.cache_bytes = total;
    Ok((out.into_vec(), stats))
}

/// The in-memory writer: [`build_cache`](crate::build_cache).
pub(crate) fn build(source: &[u8], options: &CacheOptions, limits: Limits) -> Result<(Vec<u8>, CacheStats), CacheError> {
    let scalars = Scalars::extract(source, options)?;
    let mut body = Vec::new();
    let geometry = if options.include_geometry {
        let mut writer = SectionWriter::new(options.compress_geometry_chunks, scalars.geometry_start(), limits);
        let pass = pipeline::run_retained(source, |mesh| writer.push(&mesh, &mut body))?;
        let head = writer.finish(pass.coordinate_info, &mut body)?;
        Some(Geometry { head, schema: pass.schema })
    } else {
        None
    };
    let (mut bytes, stats) = prefix(source, options, scalars, geometry, limits)?;
    bytes.extend_from_slice(&body);
    debug_assert_eq!(bytes.len() as u64, stats.cache_bytes);
    Ok((bytes, stats))
}
