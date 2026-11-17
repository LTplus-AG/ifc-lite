// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Section assembly: `BinaryCacheWriter.write` in `packages/cache/src/writer.ts`.
//!
//! Sections in the TS order: Strings, Entities, Properties, Quantities,
//! Relationships, EntityIndex, then Geometry when requested. The header and
//! section table come first; offsets are absolute and u32, so a cache past
//! 4 GiB is refused rather than wrapped.

use ifc_lite_processing::data_model::{
    extract_data_model_with, DataModelEntities, DataModelExtraction, DataModelOptions,
};

use crate::buf::Buf;
use crate::format::{
    header_flags, schema_byte, write_header, Header, SectionEntry, SectionType, HEADER_SIZE,
    SECTION_ENTRY_SIZE,
};
use crate::strings::StringTable;
use crate::{entities, entity_index, geometry, pipeline, relationships, row_facts};
use crate::{CacheError, CacheOptions, CacheStats};

/// An empty PropertyTable / QuantityTable section: count 0, no columns, three
/// empty row indices. Byte-identical for both (`writeProperties`,
/// `writeQuantities`), and what the TS writer emits for a STEP-parsed store.
const EMPTY_TABLE: [u8; 16] = [0; 16];

pub(crate) fn build(source: &[u8], options: &CacheOptions) -> Result<(Vec<u8>, CacheStats), CacheError> {
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
    let mut sections: Vec<(SectionType, Vec<u8>)> = vec![
        (SectionType::Strings, strings.write()),
        (SectionType::Entities, entities),
        (SectionType::Properties, EMPTY_TABLE.to_vec()),
        (SectionType::Quantities, EMPTY_TABLE.to_vec()),
        (SectionType::Relationships, relationships::write_relationships(&model.relationships)),
        (SectionType::EntityIndex, entity_index::write_entity_index(source)?),
    ];

    let mut stats = CacheStats {
        entity_count: total_entities as u64,
        entity_rows: model.entities.len() as u64,
        ..CacheStats::default()
    };
    let mut flags = 0;
    let schema = if options.include_geometry {
        let pass = pipeline::run(source);
        let section = geometry::build(pass.meshes, &pass.coordinate_info, options.compress_geometry_chunks);
        stats.mesh_count = u64::from(section.mesh_count);
        stats.skipped_meshes = u64::from(section.skipped_meshes);
        stats.chunk_count = u64::from(section.chunk_count);
        stats.total_vertices = u64::from(section.total_vertices);
        stats.total_triangles = u64::from(section.total_triangles);
        flags |= header_flags::HAS_GEOMETRY;
        sections.push((SectionType::Geometry, section.bytes));
        pass.schema
    } else {
        ifc_lite_processing::detect_schema_version(source)
    };

    let source_hash = if options.omit_source_hash {
        flags |= header_flags::SOURCE_HASH_UNSET;
        0
    } else {
        twox_hash::XxHash64::oneshot(0, source)
    };

    let table_end = HEADER_SIZE + sections.len() * SECTION_ENTRY_SIZE;
    let total = table_end + sections.iter().map(|(_, bytes)| bytes.len()).sum::<usize>();
    if total > u32::MAX as usize {
        return Err(CacheError::TooLarge(total as u64));
    }
    let mut offset = table_end;
    let table: Vec<SectionEntry> = sections
        .iter()
        .map(|(section_type, bytes)| {
            let entry = SectionEntry { section_type: *section_type, offset: offset as u32, size: bytes.len() as u32 };
            offset += bytes.len();
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
    let mut out = Buf::with_capacity(total);
    write_header(&mut out, &header, &table);
    for (_, bytes) in &sections {
        out.bytes(bytes);
    }
    let bytes = out.into_vec();
    stats.cache_bytes = bytes.len() as u64;
    Ok((bytes, stats))
}
