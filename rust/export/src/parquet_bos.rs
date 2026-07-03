// SPDX-License-Identifier: MPL-2.0
//! ara3d **BOS** (.bos) exporter — a ZIP of Apache Parquet tables. Ports
//! `packages/export/src/parquet-exporter.ts` (BIM Open Schema): Entities / Properties /
//! Quantities + optional geometry (VertexBuffer / IndexBuffer / Meshes) + Metadata.json.
//!
//! Native-only (feature `parquet-bos`): parquet's native compression and the zip writer
//! don't target wasm32 cleanly, and `.bos` isn't a browser-exposed format, so this stays
//! out of the wasm bundle. Server / CLI builds opt in.

use std::io::Write;
use std::sync::Arc;

use arrow::array::{ArrayRef, BooleanArray, Float32Array, StringArray, UInt32Array};
use arrow::record_batch::RecordBatch;
use parquet::arrow::ArrowWriter;
use serde_json::json;
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

use ifc_lite_processing::process_geometry;

use crate::error::ExportError;
use crate::model::{build_export_model, fmt_num, ExportModel};

/// Wrap a downstream encoder error (Arrow/Parquet/zip/serde_json) as
/// [`ExportError::Serialization`], tagged with the stage that failed.
fn ser_err<E: std::fmt::Display>(stage: &'static str) -> impl FnOnce(E) -> ExportError {
    move |e| ExportError::Serialization { stage, detail: e.to_string() }
}

/// Options for BOS export.
pub struct ParquetBosOptions {
    /// Include the geometry tables (VertexBuffer / IndexBuffer / Meshes).
    pub include_geometry: bool,
}

impl Default for ParquetBosOptions {
    fn default() -> Self {
        Self { include_geometry: true }
    }
}

fn str_col(vals: Vec<Option<String>>) -> ArrayRef {
    Arc::new(StringArray::from(vals)) as ArrayRef
}

/// Serialize one RecordBatch to Parquet bytes.
fn to_parquet(batch: &RecordBatch) -> Result<Vec<u8>, ExportError> {
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut writer = ArrowWriter::try_new(&mut buf, batch.schema(), None)
            .map_err(ser_err("arrow writer"))?;
        writer.write(batch).map_err(ser_err("write parquet batch"))?;
        writer.close().map_err(ser_err("close parquet"))?;
    }
    Ok(buf)
}

fn entities_table(model: &ExportModel) -> Result<Vec<u8>, ExportError> {
    let n = model.entities.len();
    let mut express = Vec::with_capacity(n);
    let mut global = Vec::with_capacity(n);
    let mut name = Vec::with_capacity(n);
    let mut desc = Vec::with_capacity(n);
    let mut ty = Vec::with_capacity(n);
    let mut otype = Vec::with_capacity(n);
    let mut has_geom = Vec::with_capacity(n);
    for e in &model.entities {
        express.push(e.express_id);
        global.push(e.global_id.clone());
        name.push(e.name.clone());
        desc.push(e.description.clone());
        ty.push(Some(e.ifc_type.clone()));
        otype.push(e.object_type.clone());
        has_geom.push(e.has_geometry);
    }
    let batch = RecordBatch::try_from_iter(vec![
        ("ExpressId", Arc::new(UInt32Array::from(express)) as ArrayRef),
        ("GlobalId", str_col(global)),
        ("Name", str_col(name)),
        ("Description", str_col(desc)),
        ("Type", str_col(ty)),
        ("ObjectType", str_col(otype)),
        ("HasGeometry", Arc::new(BooleanArray::from(has_geom)) as ArrayRef),
    ])
    .map_err(ser_err("entities batch"))?;
    to_parquet(&batch)
}

fn properties_table(model: &ExportModel) -> Result<Vec<u8>, ExportError> {
    let mut entity = Vec::new();
    let mut pset = Vec::new();
    let mut prop = Vec::new();
    let mut ptype = Vec::new();
    let mut value = Vec::new();
    for e in &model.entities {
        for ps in &e.property_sets {
            for p in &ps.properties {
                entity.push(e.express_id);
                pset.push(Some(ps.name.clone()));
                prop.push(Some(p.name.clone()));
                ptype.push(Some(p.value_type.clone()));
                value.push(Some(p.value.clone()));
            }
        }
    }
    let batch = RecordBatch::try_from_iter(vec![
        ("EntityId", Arc::new(UInt32Array::from(entity)) as ArrayRef),
        ("PsetName", str_col(pset)),
        ("PropName", str_col(prop)),
        ("PropType", str_col(ptype)),
        ("ValueString", str_col(value)),
    ])
    .map_err(ser_err("properties batch"))?;
    to_parquet(&batch)
}

fn quantities_table(model: &ExportModel) -> Result<Vec<u8>, ExportError> {
    let mut entity = Vec::new();
    let mut qset = Vec::new();
    let mut qname = Vec::new();
    let mut qtype = Vec::new();
    let mut value = Vec::new();
    for e in &model.entities {
        for qs in &e.quantity_sets {
            for q in &qs.quantities {
                entity.push(e.express_id);
                qset.push(Some(qs.name.clone()));
                qname.push(Some(q.name.clone()));
                qtype.push(Some(format!("IfcQuantity{}", q.kind)));
                value.push(Some(fmt_num(q.value)));
            }
        }
    }
    let batch = RecordBatch::try_from_iter(vec![
        ("EntityId", Arc::new(UInt32Array::from(entity)) as ArrayRef),
        ("QsetName", str_col(qset)),
        ("QuantityName", str_col(qname)),
        ("QuantityType", str_col(qtype)),
        ("Value", str_col(value)),
    ])
    .map_err(ser_err("quantities batch"))?;
    to_parquet(&batch)
}

/// (vertex_table, index_table, mesh_table, vertex_count, triangle_count) parquet bytes.
type GeometryTables = (Vec<u8>, Vec<u8>, Vec<u8>, usize, usize);

/// Returns the geometry parquet tables plus vertex/triangle totals.
fn geometry_tables(content: &[u8]) -> Result<GeometryTables, ExportError> {
    let result = process_geometry(content);

    let mut x = Vec::new();
    let mut y = Vec::new();
    let mut z = Vec::new();
    let mut nx = Vec::new();
    let mut ny = Vec::new();
    let mut nz = Vec::new();
    let mut i0 = Vec::new();
    let mut i1 = Vec::new();
    let mut i2 = Vec::new();
    let mut mesh_express = Vec::new();
    let mut vstart = Vec::new();
    let mut vcount = Vec::new();
    let mut istart = Vec::new();
    let mut icount = Vec::new();

    let mut vertex_offset: u32 = 0;
    let mut index_offset: u32 = 0;
    for mesh in &result.meshes {
        if mesh.geometry_class == 2 || mesh.indices.is_empty() {
            continue;
        }
        let nverts = (mesh.positions.len() / 3) as u32;
        let [ox, oy, oz] = mesh.origin;
        for v in mesh.positions.chunks_exact(3) {
            x.push(v[0] as f64 as f32 + ox as f32);
            y.push(v[1] as f64 as f32 + oy as f32);
            z.push(v[2] as f64 as f32 + oz as f32);
        }
        for nrm in mesh.normals.chunks_exact(3) {
            nx.push(nrm[0]);
            ny.push(nrm[1]);
            nz.push(nrm[2]);
        }
        for tri in mesh.indices.chunks_exact(3) {
            i0.push(vertex_offset + tri[0]);
            i1.push(vertex_offset + tri[1]);
            i2.push(vertex_offset + tri[2]);
        }
        mesh_express.push(mesh.express_id);
        vstart.push(vertex_offset);
        vcount.push(nverts);
        istart.push(index_offset);
        icount.push(mesh.indices.len() as u32);
        vertex_offset += nverts;
        index_offset += mesh.indices.len() as u32;
    }

    let vcount_total = x.len();
    let tricount_total = i0.len();

    let vbatch = RecordBatch::try_from_iter(vec![
        ("X", Arc::new(Float32Array::from(x)) as ArrayRef),
        ("Y", Arc::new(Float32Array::from(y)) as ArrayRef),
        ("Z", Arc::new(Float32Array::from(z)) as ArrayRef),
        ("NormalX", Arc::new(Float32Array::from(nx)) as ArrayRef),
        ("NormalY", Arc::new(Float32Array::from(ny)) as ArrayRef),
        ("NormalZ", Arc::new(Float32Array::from(nz)) as ArrayRef),
    ])
    .map_err(ser_err("vertex batch"))?;

    let ibatch = RecordBatch::try_from_iter(vec![
        ("Index0", Arc::new(UInt32Array::from(i0)) as ArrayRef),
        ("Index1", Arc::new(UInt32Array::from(i1)) as ArrayRef),
        ("Index2", Arc::new(UInt32Array::from(i2)) as ArrayRef),
    ])
    .map_err(ser_err("index batch"))?;

    let mbatch = RecordBatch::try_from_iter(vec![
        ("ExpressId", Arc::new(UInt32Array::from(mesh_express)) as ArrayRef),
        ("VertexStart", Arc::new(UInt32Array::from(vstart)) as ArrayRef),
        ("VertexCount", Arc::new(UInt32Array::from(vcount)) as ArrayRef),
        ("IndexStart", Arc::new(UInt32Array::from(istart)) as ArrayRef),
        ("IndexCount", Arc::new(UInt32Array::from(icount)) as ArrayRef),
    ])
    .map_err(ser_err("mesh batch"))?;

    Ok((
        to_parquet(&vbatch)?,
        to_parquet(&ibatch)?,
        to_parquet(&mbatch)?,
        vcount_total,
        tricount_total,
    ))
}

/// Export the model + geometry as a `.bos` archive (ZIP of Parquet tables).
///
/// Returns [`ExportError::Serialization`] if any downstream encoder (Arrow
/// writer, Parquet writer, zip container, or the metadata JSON serializer)
/// rejects the data — no encoder failure here panics the caller.
pub fn export_bos(content: &[u8], opts: &ParquetBosOptions) -> Result<Vec<u8>, ExportError> {
    let model = build_export_model(content);

    let cursor = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(cursor);
    let file_opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    let add = |zip: &mut zip::ZipWriter<std::io::Cursor<Vec<u8>>>,
               name: &str,
               bytes: &[u8]|
     -> Result<(), ExportError> {
        zip.start_file(name, file_opts).map_err(ser_err("zip start_file"))?;
        zip.write_all(bytes).map_err(ser_err("zip write"))?;
        Ok(())
    };

    add(&mut zip, "Entities.parquet", &entities_table(&model)?)?;
    add(&mut zip, "Properties.parquet", &properties_table(&model)?)?;
    add(&mut zip, "Quantities.parquet", &quantities_table(&model)?)?;

    let (mut vcount, mut tricount) = (0usize, 0usize);
    if opts.include_geometry {
        let (vb, ib, mb, vc, tc) = geometry_tables(content)?;
        add(&mut zip, "VertexBuffer.parquet", &vb)?;
        add(&mut zip, "IndexBuffer.parquet", &ib)?;
        add(&mut zip, "Meshes.parquet", &mb)?;
        vcount = vc;
        tricount = tc;
    }

    let meta = json!({
        "format": "ara3d-bos",
        "generator": "IFC-Lite",
        "entityCount": model.entities.len(),
        "vertexCount": vcount,
        "triangleCount": tricount,
        "tables": if opts.include_geometry {
            json!(["Entities", "Properties", "Quantities", "VertexBuffer", "IndexBuffer", "Meshes"])
        } else {
            json!(["Entities", "Properties", "Quantities"])
        },
    });
    let meta_bytes = serde_json::to_string_pretty(&meta).map_err(ser_err("metadata json"))?;
    add(&mut zip, "Metadata.json", meta_bytes.as_bytes())?;

    let zipped = zip.finish().map_err(ser_err("zip finish"))?;
    Ok(zipped.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn fixture(rel: &str) -> Vec<u8> {
        let path = format!("{}/../../tests/models/{}", env!("CARGO_MANIFEST_DIR"), rel);
        std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
    }

    #[test]
    fn duplex_exports_valid_bos() {
        let bos = export_bos(&fixture("ara3d/duplex.ifc"), &ParquetBosOptions::default())
            .expect("bos export");
        assert!(bos.len() > 1000, "non-trivial archive");

        // Re-open the zip and verify the expected tables + parquet magic.
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bos)).expect("valid zip");
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        for expected in [
            "Entities.parquet",
            "Properties.parquet",
            "Quantities.parquet",
            "VertexBuffer.parquet",
            "IndexBuffer.parquet",
            "Meshes.parquet",
            "Metadata.json",
        ] {
            assert!(names.iter().any(|n| n == expected), "missing {expected}");
        }

        // Each parquet entry starts + ends with the PAR1 magic.
        let mut entities = Vec::new();
        archive.by_name("Entities.parquet").unwrap().read_to_end(&mut entities).unwrap();
        assert_eq!(&entities[0..4], b"PAR1", "parquet header magic");
        assert_eq!(&entities[entities.len() - 4..], b"PAR1", "parquet footer magic");

        // Metadata.json is valid + reports entities.
        let mut meta = String::new();
        archive.by_name("Metadata.json").unwrap().read_to_string(&mut meta).unwrap();
        let v: serde_json::Value = serde_json::from_str(&meta).unwrap();
        assert_eq!(v["format"], "ara3d-bos");
        assert!(v["entityCount"].as_u64().unwrap() > 50);
        assert!(v["vertexCount"].as_u64().unwrap() > 0);
    }
}
