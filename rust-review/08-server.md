# apps/server review

## Summary
- **A three-line IFC file can kill the whole multi-tenant process.** `resolve_material` recurses through `IfcMaterialLayerSetUsage` / `IfcMaterialProfileSetUsage` with no depth limit and no visited set. A self-referencing or cyclic usage overflows the stack. Stack overflow aborts even under `server-release` (unwind), so `CatchPanicLayer` cannot contain it (SERVER-5).
- **Memory DoS paths that bypass admission:**
  - `/cache/check`, `/cache/geometry`, `/parse/data-model`, `/parse/symbolic` and the `?sha256=` probe gates read whole cache blobs with no admission slot.
  - Every "does this entry exist" check (`has_entry`) reads and integrity-hashes the whole entry, including the ~60 MB data model.
  - Cached replays drop their slot while the whole model (base64) stays resident for a slow reader.
  - (SERVER-6, -7, -8)
- **Every parse route repeats the same HTTP scaffold.** The sequence acquire(max_file) → extract_file → request_cache_key → cache probe → spawn_blocking(guard rides along) → cache write → hand-built `Response` is copied across 6 upload handlers and 4 cache-hit readers. The "geometry + data model + finishes + symbolic + serialize" blocking body is near-identical between `/parquet` and `/parquet/optimized`. The copies have already drifted: there are five different policies for a corrupt cache entry, and some of them 500 forever (SERVER-1, -2, -12).
- **Parity problem: the server's data model is a separate Rust implementation.** It is a fourth implementation of IFC property, quantity, material, relationship and spatial extraction, next to `rust/export` (`model_props`, `relationships`) and `rust/processing` (`processor/properties.rs`, `quick_metadata`).
  - It uses its own IFC4-only generated attribute table instead of core's per-schema registry.
  - It uses a hand-typed spatial-type list that processing explicitly replaced because it drifted (#3245).
  - It renders booleans and logicals differently from export (SERVER-3, -4, -28).
- **`benches/serialization.rs` is a ~450-line stale fork of the production serializers.** It has its own `MeshData`, ZSTD instead of LZ4_RAW, and no Y-up, origin, rotation, finish or source-id columns, so it benchmarks code that does not ship (SERVER-9).
- **The parquet-stream data-model fill takes a second admission slot while the stream still holds the first.** On a 1-slot or saturated host the fill always times out, so the data model is never written and `get_data_model` answers its terminal 404 (SERVER-8).
- **Blocking work runs on async workers:**
  - gzip and `.ifcZIP` decompression of up to 500 MB inside the async `extract_file` (SERVER-10).
  - `extract_data_model` copies the whole upload (`content.to_vec()`) just to wrap it in an `Arc` (SERVER-11).
- **Cross-crate duplication of core helpers:**
  - Z-up→Y-up conversion is implemented 3× inside the server and 4× more across export, processing and wasm.
  - Schema detection exists 4× and the server's copy is case-sensitive, so `/parse/metadata` and `/parse` disagree on lowercase `ifc4` (SERVER-15, -18).
  - Parquet writer helpers and length-prefixed framing exist 4× each; the data-model framing lacks the `u32` truncation guard (SERVER-13, -14).

## Findings

### SERVER-5: Unbounded recursion in `resolve_material` – a crafted file aborts the whole server
- Category: Bug
- Severity: High
- Confidence: CONFIRMED
- Where: apps/server/src/services/data_model/materials.rs:45, :69-74 (`IFCMATERIALLAYERSETUSAGE` → `resolve_material(decoder, set_id, …)`), :190-195 (`IFCMATERIALPROFILESETUSAGE` → same)
- What: The usage arms recurse into whatever entity attribute 0 references. There is no depth counter, no visited set and no type check that the target is actually a set. Compare `classifications.rs:52` (bounded at 8) and `material_units.rs:98-105` (visited set); this resolver has neither.
- Why it matters: The file `#1=IFCMATERIALLAYERSETUSAGE(#1,.AXIS2.,.POSITIVE.,0.,$); #2=IFCRELASSOCIATESMATERIAL('x',$,$,$,(#3),#1); #3=IFCWALL(...)` recurses forever on a rayon worker until it overflows the stack. Rust treats a stack overflow as SIGSEGV/abort, not as a panic. The `server-release` unwind profile and `CatchPanicLayer` (documented as "contains a malformed-IFC panic to the single offending request") cannot catch it, so every tenant's in-flight request dies. Any route that builds the data model triggers it: `/parse/parquet`, `/parse/parquet/optimized`, and the background fill of `/parse/parquet-stream`.
- Fix: Resolve usages iteratively with a hop limit (usage → set must be exactly one hop). Check `is_subtype_of(IfcMaterialLayerSet)` / `IfcMaterialProfileSet` on the target before descending. Add a regression test with self- and mutually-referencing usages.
- Effort: S

### SERVER-6: Cache-read routes and probe gates read whole blobs into memory with no admission
- Category: Bug (DoS)
- Severity: High
- Confidence: CONFIRMED
- Where:
  - apps/server/src/routes/parse/fetch.rs:181-229 (`check_cache` calls `get_bytes` on geometry plus `has_current_data_model` + `has_cached_symbolic` + `has_parquet_metadata`, all of which are full reads, just to return an empty 200)
  - fetch.rs:242-298 (`get_cached_geometry`), fetch.rs:50-114 (`get_data_model`), fetch.rs:130-167 (`get_symbolic`)
  - routes/parse/cached_replay.rs:84-86 and parquet_optimized_replay.rs:224-226 (probe gates, run "before touching the gate")
  - cache_keys.rs:306-308 (`has_entry` = `get_bytes`)
- What: `DiskCache::get_bytes` is `cacache::read`: it loads the entire entry into a `Vec` and verifies its SRI hash. None of these handlers acquires admission. In contrast, `get_cached` (routes/cache.rs:154) does acquire, so the routes are inconsistent. The probe doc comments claim a miss costs "two small reads (the metadata header and the data-model marker)" (cached_replay.rs:57-62). In fact the "marker" is the full data-model Parquet, which the same code base describes as up to 60 MB (cache_keys.rs:237).
- Why it matters: With an unauthenticated default deployment, any client that knows one cached hash (for example a public sample model) can fire concurrent `GET /api/v1/cache/check/{hash}` requests. Each one allocates geometry + data model + symbolic + metadata, unbounded by the byte budget, until the replica is OOM-killed. That is exactly the outage admission control exists to prevent (OPERATIONS.md).
- Fix:
  - Make existence checks real existence checks: `cacache::metadata` + `cacache::exists`, or an index lookup plus `content_path` stat. Do not read the content.
  - Stream bodies with `cacache::Reader` into `Body::from_stream` instead of `read`.
  - Route all whole-entry reads through one `CacheBodyReader` that takes an admission reservation sized to the entry's metadata size.
- Effort: M

### SERVER-7: Cached replay drops its admission slot but keeps the whole model resident for the drain
- Category: Bug (DoS)
- Severity: High
- Confidence: CONFIRMED
- Where: apps/server/src/routes/parse/cached_replay.rs:88-101 (guard dropped right after `try_cached_replay`), cached_replay.rs:203-291 (builds `Vec<Event>` holding every batch base64-encoded, ~1.33× geometry, plus the copies made in `take_length_prefixed`, parquet_replay_batches.rs:243-251); parquet_stream.rs:116-126 (same drop on the upload-hit path); parquet_optimized_replay.rs:228-233
- What: The doc comment correctly says the replay build is "several times the model's geometry resident at once" and that leaving it unbounded "would make the cheapest request … the cheapest way to exhaust the server". It then drops the guard before returning a stream that owns all of that memory. The stream's lifetime is bounded only by the 600 s write-idle timeout.
- Why it matters: N hash-only probes from slow readers each pin about 2× the model with zero admission accounting. On a large model this OOMs the box with a handful of connections.
- Fix: Keep the guard inside the stream (`stream::iter(events)` chained with a guard drop, as `process_streaming` does with `_admission`). Better: build batches lazily from the cached blob so resident memory is one batch. Reserve the entry's actual size, not `max_file_size` (see SERVER-24).
- Effort: M

### SERVER-8: parquet-stream data-model fill takes a second admission slot while the stream holds the first
- Category: Bug
- Severity: High
- Confidence: CONFIRMED (logic) / LIKELY (impact)
- Where: apps/server/src/routes/parse/parquet_stream.rs:93-97 (stream guard moved into `process_streaming`, held until the stream ends), :347-362 (background DM task `acquire(content_for_cache.len())`; on failure it silently skips)
- What: Each `/parse/parquet-stream` needs two CPU permits at once. When `max_concurrent_parses == 1` (WORKER_THREADS=1, typical of a small Railway instance), the DM task can never get a permit while its own stream runs. It waits `queue_timeout` (5 s) and then gives up.
- Why it matters: Any stream longer than 5 s on a 1-slot host, or any stream on a saturated host, never writes the data model. The `InFlightGuard` then drops and `get_data_model` returns 404, which the code itself documents as terminal for `fetchDataModel` (fetch.rs:61-62). Properties then silently never load. On larger hosts it halves effective stream concurrency and inflates `rejected_overload` metrics with self-inflicted rejections. The DM fill also re-parses the whole upload, a second full scan, while the stream parses it.
- Fix: Run the data-model extraction under the stream's own guard (share the `Arc<AdmissionGuard>` already created in `process_streaming`), or fold it into the producer task after the last batch. Do not acquire a second slot for work that belongs to the same request.
- Effort: M

### SERVER-1: The parse/cache HTTP scaffold is copy-pasted across every route
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where (every site):
  - Admission + extract: `state.admission.acquire(state.config.max_file_size_mb as u64 * 1024 * 1024).await?` followed by `extract_file(&mut multipart, …)`, with the same four-line comment, at:
    - routes/parse/json.rs:41-45 (`parse_full`), json.rs:172-176 (`parse_stream`), json.rs:225-229 (`parse_metadata`)
    - routes/parse/parquet.rs:75-79 (`parse_parquet`)
    - routes/parse/parquet_optimized.rs:82-86
    - routes/parse/parquet_stream.rs:93-97
  - Acquire only: routes/cache.rs:154-157, cached_replay.rs:88-91, parquet_optimized_replay.rs:228-231
  - "spawn_blocking with the guard riding the tuple": json.rs:60-67, json.rs:89-127, json.rs:235-274, parquet.rs:149-211, parquet_optimized.rs:118-192, routes/cache.rs:171-180
  - "hash-only probe else MissingFile": parquet_optimized.rs:69-75, parquet_stream.rs:71-86
  - Cache-hit early return: json.rs:58-69, parquet.rs:94-123, parquet_optimized.rs:95-99, parquet_stream.rs:116-126
  - "tracing::info Cache MISS, size": json.rs:71, parquet.rs:125-129, parquet_optimized.rs:101-105, parquet_stream.rs:128-132
- What: Ten handlers re-spell the same pipeline. The guard tuple threading through `spawn_blocking` is especially fragile: one route returns `(result, admission_guard)`, another `Ok((…, admission_guard))`, another a 7-tuple. Forgetting to move the guard in is a silent bug.
- Why it matters: Every cross-cutting change (reserve the actual size instead of the max, a read timeout, cache-error policy, metrics) must be applied 6–10 times. SERVER-12 and SERVER-24 are drift that has already happened.
- Fix:
  - Add an `AdmittedUpload` extractor in routes/parse/mod.rs that runs `acquire` + `extract_file` + quality/shape resolution and yields `{data, guard, cache_key, query}`.
  - Add `run_admitted<T>(guard, f) -> T` that spawns blocking and returns the guard with the result.
  - Add an enum `UploadOrProbe` for the `Option<Multipart>` + `sha256` routes.
- Effort: M

### SERVER-2: `/parse/parquet` and `/parse/parquet/optimized` share a near-identical parse-and-serialize body
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where: routes/parse/parquet.rs:149-211 vs routes/parse/parquet_optimized.rs:119-191; the same "geometry + finishes" join also appears at json.rs:89-102 and services/streaming.rs:127-137 (`ModelFinishes::from_content` + `finish_meshes`)
- What: Both do the following, each with its own copy of the comments:
  - `rayon::join(process_geometry_filtered_with_quality, rayon::join(extract_data_model, ModelFinishes::from_content))`
  - then `finish_meshes`
  - then build a `DataModelStats { entity_count, property_set_count, relationship_count, spatial_node_count }` (parquet.rs:160-165 == parquet_optimized.rs:130-135)
  - then `data_model_entities.apply`
  - then `baked_basis_zup(Some(mesh_coordinate_space), site_transform, origin_shift)` (parquet.rs:187-191 == parquet_optimized.rs:145-149)
  - then `rayon::join(extract_symbolic_data_with_provenance_in_frame, rayon::join(serialize_geometry, serialize_data_model_to_parquet))`

  They differ only in the geometry serializer and in whether `content` and `meshes` are dropped early. That memory behaviour has already drifted: the optimized route drops `content` and `meshes` early, the flat route does not.
- Why it matters: Each pipeline change (#4706, #5984, #6034 and #4118 all touched both) must be made twice. The flat route currently holds the upload and all meshes across both serializations, which is avoidable peak memory.
- Fix: Add `fn parse_model_bundle(content, opening_filter, quality, entities, serialize_geometry: impl FnOnce(&[MeshData], &Matrix4) -> Result<Bytes>) -> ModelBundle` in services/ (for example `services/parse_bundle.rs`). Put `impl From<&DataModel> for DataModelStats` beside `DataModelStats`.
- Effort: M

### SERVER-3: The server data model is a fourth Rust implementation of IFC data extraction
- Category: DRY (cross-crate parity)
- Severity: High
- Confidence: CONFIRMED
- Where:
  - Server: apps/server/src/services/data_model/{properties.rs:17, property_value.rs:237 (`resolve_single_value`), :304 (`fmt_number`), quantities.rs:13, relationships.rs:14, materials.rs:45, classifications.rs:15, documents.rs:14, metadata.rs:55, spatial.rs:43}
  - rust/export/src/model_props.rs:20 (`fmt_num`, byte-identical to server `fmt_number`), :29 (`map_enum`), :40 (`render_value`), :152 (`decode_property_set`), :173 (`decode_quantity_set`); rust/export/src/relationships.rs:48
  - rust/processing/src/processor/properties.rs (third pset decoder); rust/processing/src/processor/quick_metadata.rs (spatial tree)
- What: There are three Rust property-set and quantity decoders, plus the TypeScript `columnar-parser.ts` that the server mirrors by comment. Behaviour has already diverged:
  - export renders `.U.` as `"unknown"`, the server as `""` with kind `"logical"`;
  - export tags every bare `Enum` as `IFCBOOLEAN`, the server classifies it as T/F/U/other;
  - the server keeps unnamed-but-resolvable psets (#3963), export uses `resolve_pset_defs`.
- Why it matters: The same IFC file exports different property values from the CLI (export) and the server (data-model Parquet). AGENTS.md calls Rust the "source of truth for the server, CLI, SDK, and wasm". Here there is no single Rust truth, so every IDS or property fix lands in up to three places.
- Fix: Move one canonical `ifc_lite_processing::data_model` (pset/qset/material/classification/document/relationship/spatial extraction producing typed rows) into processing. Make the server's Parquet writer and export's CSV/JSON/BOS writers consume it, and make server `fmt_number` and export `fmt_num` one function. Keep the TS-parity tests as the contract tests.
- Effort: L

### SERVER-9: `benches/serialization.rs` is a stale fork of the production serializers
- Category: DRY
- Severity: High
- Confidence: CONFIRMED
- Where:
  - apps/server/benches/serialization.rs:24-52 (own `MeshData`), :105-270 (`serialize_parquet_basic`), :272-520 (`serialize_parquet_optimized`, which re-defines `hash_f32_slice`, `hash_u32_slice`, `quantize_position`, `color_to_byte`, `MaterialKey`, `VERTEX_MULTIPLIER`)
  - Production equivalents: services/parquet.rs, services/parquet_optimized.rs:38-70, services/parquet_instancing.rs:40-58
  - jscpd: benches/serialization.rs:372-386 ⇔ services/parquet_optimized.rs:208-222
- What: The bench's comment says "Since this is a binary crate, we'll define the necessary types here". It uses ZSTD (:257, :502), while production uses LZ4_RAW. It has no Y-up swap, no origin, rotation, geometry_class, source-id or finish columns, no rotation-aware dedup, and no dictionary opt-outs. parquet_schema.rs:178-181 already notes that it "has already drifted".
- Why it matters: Benchmark numbers and the "~15x / ~50x smaller" claims (main.rs:20-21, parquet.rs:7-10) describe code that does not ship. Perf work guided by the bench optimizes a phantom.
- Fix: Add `src/lib.rs` exposing `services` (keep `main.rs` thin) and make the bench call `serialize_combined_for_layout` / `serialize_to_parquet_optimized_with_stats` on fixtures from `parquet_test_fixtures`. Delete the forked code.
- Effort: M

### SERVER-10: gzip / `.ifcZIP` decompression runs on the async runtime
- Category: Bug (blocking on async)
- Severity: High
- Confidence: CONFIRMED
- Where: apps/server/src/routes/parse/mod.rs:185-207 (`GzDecoder…read_to_end`), mod.rs:251-331 (`unwrap_ifczip`: zip directory walk + inflate), both called from the async `extract_file` (mod.rs:147)
- What: Up to 500 MB of inflate runs synchronously inside the handler future on a tokio worker, unlike every other CPU-heavy step, which is moved to `spawn_blocking` (#4696).
- Why it matters: A handful of concurrent gzip uploads stall that worker for seconds. Every connection multiplexed on it then stalls too, including `/health` and `/ready` probes (Railway can restart-loop) and SSE streams.
- Fix: Return the raw `Bytes` from the multipart loop and do the magic sniff and decompress in `spawn_blocking` (or inside the route's existing blocking task). Also map decode failures to `BadRequest` (see SERVER-35).
- Effort: S

### SERVER-11: `extract_data_model` copies the entire upload and allocates a `String` per entity
- Category: Perf
- Severity: High
- Confidence: CONFIRMED
- Where: apps/server/src/services/data_model/mod.rs:136 (`let content_arc = Arc::new(content.to_vec());`), :72-77 (`EntityJob { type_name: type_name.to_string(), … }` for every entity); every extractor takes `&Arc<Vec<u8>>` only to call `.as_slice()` (properties.rs:19, quantities.rs, relationships.rs:14, materials.rs:246, classifications.rs, documents.rs, metadata.rs:55)
- What: The `Arc` wrapping is pointless because rayon borrows across `join`, and each call duplicates up to 500 MB. Millions of small `String`s add allocator pressure on top.
- Why it matters: Admission charges one upload size per request. The parquet routes run the geometry parse, a second scan for `ModelFinishes`, and this copy concurrently, so peak memory is about 2× upload + working set more than budgeted. `/parse/parquet-stream` holds the upload a third time in its DM task.
- Fix: Change the extractor signatures to `content: &[u8]` and drop the `to_vec`. Store `IfcType` (or a `&'a str` into the content) in `EntityJob`. Bucket jobs by type once instead of the 8 extractor-local `filter(eq_ignore_ascii_case)` passes (see SERVER-38).
- Effort: S

### SERVER-12: Five different policies for an unusable cache entry; three of them return 500 forever
- Category: DRY / Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - parquet_optimized_replay.rs:56-68 (`readable_entry`: error ⇒ miss), :144-150 (bad UTF-8 ⇒ miss)
  - parquet.rs:95-96 and :113-116 (`get_bytes(...).await?` and `String::from_utf8(...).map_err(Internal)?` ⇒ 500)
  - cached_replay.rs:149-151 (`?` ⇒ 500), :177-178 (metadata decode ⇒ `Internal` 500)
  - json.rs:58-67 (`decoded?` ⇒ 500 via `From<serde_json::Error>`)
  - routes/cache.rs:182-190 (decode failure ⇒ 404)
  - fetch.rs:262-263, :280-281 (⇒ 500)
- What: parquet_optimized_replay.rs:102-107 explicitly documents why an error must be a miss: cacache verifies content on read, a truncated blob is an error, and propagating it "would 500 this file's every future request". The flat, stream and JSON routes do exactly that.
- Why it matters: One interrupted cache write or partial GC permanently breaks that file on three routes until someone `DELETE`s it.
- Fix: Use one `async fn read_usable(cache, key) -> Option<Vec<u8>>`, with typed variants `read_json<T>` / `read_utf8`, on `DiskCache`. All cache-hit paths use it, and a miss falls through to re-parse, which overwrites the entry.
- Effort: S

### SERVER-13: Four Parquet writer helpers with drifted writer properties
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - services/parquet.rs:300-309 (`write_parquet_buffer`) + :322-345 (`writer_props`: numeric dictionary off EXCEPT `rot*`)
  - services/parquet_optimized.rs:466-503 (second `write_parquet_buffer`: dictionary off for every numeric column INCLUDING `UInt8/Int8` and the instance table's `rot0..rot8`)
  - services/parquet_data_model.rs:681-695 (`write_parquet_batch`: no dictionary tuning; doc says "Zstd", code is LZ4_RAW)
  - cross-crate: rust/export/src/parquet_bos.rs:59-68 (`to_parquet`, default props)
- What: parquet.rs:315-321 argues that `rot*` columns must keep dictionary+RLE, because otherwise each 100k rows hands the compressor 3.6 MB of nine plain f32. The optimized writer, which emits the same nine columns (parquet_optimized.rs:294), applies exactly the opt-out that comment warns against.
- Why it matters: The optimized payload (the "small" route) is larger than it needs to be on rotation-instanced models, and the next tuning change will land in only one of the writers.
- Fix: Give `services/parquet.rs` one `pub(crate) fn write_parquet(batch, &WriterProfile)`, with profiles `Geometry` (numeric opt-out minus `rot*`) and `Tabular` (data model). Use it from all three writers and fix the stale "Zstd" doc.
- Effort: S

### SERVER-14: Length-prefixed section framing written 4×, read 3×+; the data-model framer is unguarded
- Category: DRY / Bug
- Severity: Medium
- Confidence: CONFIRMED (dup) / LIKELY (truncation on extreme models)
- Where:
  - Writers: services/parquet.rs:150-162 (`frame_sections`), :174-190 (`frame_combined_sections`, which duplicates the three `check_u32_len` + six extends); services/parquet_optimized.rs:425-461 (`assemble_optimized_output`); services/parquet_data_model.rs:97-114 (eight `(x.len() as u32).to_le_bytes()` with NO `check_u32_len`, and `Vec::new()` without capacity)
  - Readers: routes/parse/cached_replay.rs:127-132 (`cached_geometry_slice`); services/parquet_replay_batches.rs:243-251 (`take_length_prefixed`, which also `copy_from_slice`s every section); tests (see SERVER-40)
- What: `check_u32_len` exists precisely so that a >4 GiB section fails loudly rather than becoming a silently corrupt length prefix (parquet.rs:131-136). The data-model writer was never routed through it.
- Why it matters: An oversized data-model table would write a wrapped length, and every client decode would then misread every later table. Separately, `frame_combined_sections` and `frame_sections` can disagree on a future edit.
- Fix: Add one `LengthPrefixedWriter { buf }` with `push_section(name, &[u8]) -> Result` and a matching `LengthPrefixedReader` (returning `Bytes::slice`, not copies) in `services/framing.rs`. Express all four writers and both readers through it.
- Effort: S

### SERVER-15: Z-up→Y-up conversion and its vertex loop are implemented 3× in the server and 4× more elsewhere
- Category: DRY (cross-crate)
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - Server: services/axis.rs:22 (`zup_to_yup`), :30 (`zup_to_yup_f64`), :40-91 (`mesh_to_yup_in_place`, separate position and normal loops); services/parquet_vertex_columns.rs:20-69 (`shape_vertices`); services/parquet_optimized.rs:224-265 (third copy of the loop + normals-mismatch warning); services/parquet_instancing.rs:216-254 (`P_ZUP_TO_YUP` + `mat3_mul` + `rotation_zup_to_yup`)
  - Cross-crate: rust/export/src/frame.rs:20 (`yup_f32`), :26 (`yup_f64`), :40 (`yup_matrix4`); rust/processing/src/simplify_math.rs:13/20 (`yup_to_zup`/`zup_to_yup`); rust/wasm-bindings/src/zero_copy (`swap_zup_to_yup_mat4`)
- What: axis.rs claims to be "THE ONE definition of the server wire's axis convention". Inside the server the normals-mismatch policy has already split: JSON clears normals (axis.rs:82), the flat and optimized routes zero-pad (parquet_vertex_columns.rs:30-37, parquet_optimized.rs:224-263), and the warning text is duplicated.
- Why it matters: A frame change (AGENTS.md treats the wire frame as a parity contract) must be made in 7+ places across 4 crates.
- Fix: Put a single `frame` module in `ifc_lite_geometry` (or `ifc_lite_processing`) with `zup_to_yup<[T;3]>`, `zup_to_yup_mat3/4`, and an iterator `yup_vertices(positions, normals) -> impl Iterator<Item=([f32;3], Option<[f32;3]>)>` that encodes the mismatch policy once. Have the server, export, processing and wasm re-export it.
- Effort: M

### SERVER-16: The six-field response/header shape is defined five times; `DataModelStats` is built twice
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - types/symbolic_response.rs:14-27 (`SymbolicParseResponse`, a field-by-field copy of `ifc_lite_processing::ParseResponse`)
  - routes/parse/parquet.rs:34-48 (`ParquetMetadataHeader`), routes/parse/parquet_optimized_replay.rs:35-54 (`OptimizedParquetMetadataHeader`)
  - types/response.rs:80-104 (`StreamEvent::Complete`)
  - Construction sites: parquet.rs:248-256, parquet_optimized.rs:206-216, parquet_stream.rs:291-299, json.rs:113-123 (builds a `ParseResponse` with `meshes: Vec::new()` only to convert it)
- What: The shared fields are `cache_key`, `metadata`, `stats`, `mesh_coordinate_space`, `site_transform`, `building_transform`, each with the same `skip_serializing_if` attributes.
- Why it matters: The cache-key version bumps documented in cache_keys.rs (#4653, #5129, #5542) all arose from one of these copies gaining a field the others did not.
- Fix: Define `#[derive(Serialize, Deserialize)] struct ModelEnvelope { … }` once and `#[serde(flatten)]` it into each header/response. Add `ModelEnvelope::from_result(&ProcessingResult, cache_key)` and `DataModelStats::from(&DataModel)`.
- Effort: S

### SERVER-17: The trailing per-mesh columns share a schema but are assembled twice
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: services/parquet_schema.rs:187-230 (`shared_trailing_fields`, shared); column assembly duplicated at services/parquet_mesh_tables.rs:106-138 + 197-209 and services/parquet_optimized.rs:118-131 + 170-186 + 285-294 (origin x/y/z, geometry_class, item id, material id with `ABSENT_SOURCE_ID`, finish, rotation)
- What: The schema-drift fix (#3215) shared the `Field` list, but each transport still pushes the values by hand in positional order.
- Why it matters: Adding a field to `shared_trailing_fields` compiles cleanly in both writers and only fails at runtime in `RecordBatch::try_new`, or worse, if types match, writes values into the wrong column. That is the swap class `MeshRow`'s doc (parquet_schema.rs:100-109) says it eliminated.
- Fix: Add a `TrailingColumns` builder in parquet_schema.rs with `push(&MeshData, origin_yup, rotation)` and `into_arrays() -> Vec<ArrayRef>`, generated from the same list as the fields. Both writers use it.
- Effort: S

### SERVER-18: Schema detection is duplicated, and `/parse/metadata` disagrees with `/parse`
- Category: DRY / Bug
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - apps/server/src/services/streaming.rs:56-85 (`find_bytes` + `detect_schema_version`: case-SENSITIVE, header-only, defaults IFC2X3), used by routes/parse/json.rs:259
  - rust/processing/src/processor/schema_detection.rs:20 (case-insensitive since #4661, whole-file, defaults IFC2X3), which feeds `ProcessingResult.metadata.schema_version` on every other route
  - rust/export/src/schema_detect.rs:13 → `core::parser::header::declared_schema` (proper header parser, defaults IFC4)
- What: For `FILE_SCHEMA(('ifc4'))`, `/parse/metadata` reports `IFC2X3` while `/parse` reports `IFC4`. That is the exact bug #4661 fixed in processing and #4593 fixed in export ("Keeping a second scanner here previously gave long and lower-case headers different answers"). A file whose DATA section mentions IFC4X3 gives the opposite disagreement.
- Why it matters: Clients that route by schema get inconsistent answers from the same server.
- Fix: Delete the server copy and use `ifc_lite_core::declared_schema_bounded` + `SchemaVersion::from_file_schema` everywhere (processing too). That leaves one detector with one default.
- Effort: S

### SERVER-19: Hand-built `Response::builder` boilerplate (nine sites)
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where:
  - routes/parse/parquet.rs:108-120 and :294-300 (flat geometry; also `CONTENT_TYPE` "application/x-parquet-geometry" 3×)
  - fetch.rs:87-92 (data model), :99-103 and :158-162 (identical 202 "processing" JSON bodies), :144-149, :208-211, :272-286
  - parquet_optimized_replay.rs:79-88 (the one place that already centralizes)
  - `"X-IFC-Metadata"` literal 4×; `String::from_utf8(meta)…mark_header_from_cache` 2× (parquet.rs:113-116, fetch.rs:277-282); `json_body` (json.rs:155) vs inline at routes/cache.rs:185
- What: Each site re-spells status, content type, metadata header, `CONTENT_LENGTH` and `map_err(Internal)`.
- Why it matters: Header name and content-type typos are not caught by the compiler. `optimized_parquet_response` exists precisely because "two hand-copied builders are indistinguishable only for as long as nobody edits one of them" (parquet_optimized_replay.rs:70-74), yet the flat route still has two.
- Fix: Add a `routes/parse/responses.rs` with `binary(content_type, body, metadata: Option<String>)`, `processing_202(what)`, `json_bytes(body)`, plus consts for header names and MIME types.
- Effort: S

### SERVER-20: The two `?sha256=` probe handlers are near-identical
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: routes/parse/cached_replay.rs:72-120 (`replay_by_client_hash`) vs routes/parse/parquet_optimized_replay.rs:213-254 (`replay_optimized_by_client_hash`)
- What: Both run the sequence digest check → `cache_key_from_parts` → three `has_*` gates → acquire max-size → try-replay → drop guard → identical info/debug/404 text.
- Why it matters: The gate order already differs (flat: metadata, data model, symbolic; optimized: metadata, symbolic, data model). Fixes to SERVER-6 and SERVER-7 must be made twice.
- Fix: Add a generic `probe_by_hash(state, query, quality, sha256, gates: &[Gate], replay: impl AsyncFnOnce)` in cached_replay.rs.
- Effort: S

### SERVER-21: `GET /parse/symbolic/{key}` answers 202 forever for keys nothing will write
- Category: Quirk
- Severity: Medium
- Confidence: CONFIRMED
- Where: routes/parse/fetch.rs:153-165
- What: `get_data_model` was fixed (#5129) to return 404 unless a fill is in flight. `get_symbolic` still returns 202 "still being processed" for any absent key, including typos, evicted entries and JSON-only parses.
- Why it matters: A polling client spins until its own timeout, which is the exact failure #5129 removed for the data model.
- Fix: Track symbolic writes in `InFlightKeys` (the streaming route spawns the write) and return 404 otherwise. Mirror `get_data_model`'s before/after check.
- Effort: S

### SERVER-22: `/parse/stream` advertises a `cache_key` that names nothing; parquet-stream hashes the upload twice
- Category: Quirk / Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where: services/streaming.rs:127 (`DiskCache::generate_key(&content)`, a SHA-256 over the whole upload inside the producer), types/response.rs:86 (`Complete.cache_key`); routes/parse/parquet_stream.rs:103 (already computed `request_cache_key`) and :220 (`..` discards it)
- What: The JSON SSE route writes no cache entry, and its `cache_key` is the bare hash without the `-{filter}{-q}` suffix. `GET /api/v1/cache/{key}` therefore rejects it with 400 (`resolve_request_cache_key`). On parquet-stream the second SHA-256 of up to 500 MB (about 1 s of CPU) is computed and thrown away.
- Why it matters: The event leads clients to a key that cannot work, and the duplicate hash wastes CPU on every streamed request.
- Fix: Pass `Option<String>` (the request cache key) into `process_streaming`. Emit it only when the route caches, otherwise omit it. Never hash inside the producer.
- Effort: S

### SERVER-23: The streaming producer clones every batch's geometry
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where: services/streaming.rs:175 (`finish_meshes(&mut finishes, meshes.to_vec())`)
- What: The pipeline hands the callback `&[MeshData]` with `retain_emitted_meshes: false`, so the slice is dropped right after. The `to_vec()` deep-copies every position, normal and index buffer of the whole model once.
- Why it matters: It costs a full extra pass and allocation over all geometry on the SSE routes.
- Fix: Let the batch callback take `Vec<MeshData>` by value (or `&mut Vec` to `mem::take`) in `process_geometry_streaming_filtered_with_baked_basis`. The non-retaining path already owns the batch.
- Effort: S (API change in processing)

### SERVER-24: Every admission reservation is `max_file_size`, even when the actual size is known
- Category: Perf / Quirk
- Severity: Medium
- Confidence: CONFIRMED
- Where: routes/cache.rs:156, cached_replay.rs:90, parquet_optimized_replay.rs:230 (cache hits whose entry size is known from metadata); compare parquet_stream.rs:354 (DM fill reserves `content.len()`)
- What: A 1 MB cached replay reserves 500 MB of the byte budget. On a 2 GB box (1.4 GB budget) only two cache hits can run at once, and they are throttled like full parses. The one call site that reserves the actual size shows the API supports it.
- Why it matters: Admission rejects cheap work, while the expensive work it should bound (SERVER-6/7) is not admitted at all.
- Fix: Reserve the `cacache::metadata(key).size` for cache paths. For uploads, keep the max reservation (multipart) but shrink it after `extract_file` (an `AdmissionGuard::shrink_to(actual)` returning the excess permits), which is the "tighter packing follow-up" admission.rs:113-115 mentions.
- Effort: M

### SERVER-25: JSON cache hits fully decode and re-encode the whole model to set one flag
- Category: Perf
- Severity: Medium
- Confidence: CONFIRMED
- Where: routes/parse/json.rs:58-68; routes/cache.rs:171-180
- What: A cache hit runs `serde_json::from_slice::<SymbolicParseResponse>` on the whole model plus `to_vec`, purely to flip `stats.from_cache`. The parquet routes do this with `mark_header_from_cache` on a few-hundred-byte header.
- Why it matters: A warm hit costs about the same CPU and 2–3× the memory of the JSON body, under an admission slot.
- Fix: Store the response with `from_cache` split out, or store `stats` as a separate small entry and splice it in, or byte-patch a fixed-width `"from_cache":false` marker. In any case avoid the full round-trip.
- Effort: M

### SERVER-26: Material association rows multiply elements × layers with no cap
- Category: Bug (DoS amplification)
- Severity: Medium
- Confidence: LIKELY
- Where: services/data_model/materials.rs:262-307
- What: Each `IfcRelAssociatesMaterial` emits one `MaterialAssociation` row per related element × per resolved layer, cloning five strings per row. A ~10 MB file with one association relating 10⁶ elements to a 1,000-layer set yields 10⁹ rows.
- Why it matters: Admission charges only the upload size, so a small file can OOM the server.
- Fix: Emit the definition once (definition table) plus an `element → definition` link table, or cap total rows with an explicit error. At minimum, `Arc<str>` the shared strings.
- Effort: M

### SERVER-27: Spatial-structure type list is hand-typed while processing derives it from the schema
- Category: DRY
- Severity: Medium
- Confidence: CONFIRMED
- Where: apps/server/src/services/data_model/spatial.rs:63-82 (`is_spatial_type`, 17 names), :83-93 (`is_building_like_spatial_type`), :97-98; canonical: rust/processing/src/processor/quick_metadata.rs:43-82 (`is_quick_spatial_type_ci`, public via `ifc_lite_processing`)
- What: processing replaced exactly this hand list because "it had already been caught missing IfcMarineFacility, IfcMarinePart and IfcFacilityPartCommon (#3245)", and the server list has the same history (#3965). The server's closure also calls `to_uppercase()` on every invocation.
- Why it matters: The next IFC schema addition will be missed here again.
- Fix: Call `ifc_lite_processing::is_quick_spatial_type_ci`. Derive "building-like" and "space-like" from `IfcType::is_subtype_of` in the same module.
- Effort: S

### SERVER-28: IFC4-only generated attribute table instead of core's per-schema registry
- Category: DRY (cross-crate) / Bug
- Severity: Medium
- Confidence: LIKELY
- Where: apps/server/src/services/data_model/generated/attr_indices.rs (6,245 lines, IFC4_ADD2_TC1 only, generated from the TS parser), used by metadata.rs:80 and rooted.rs:118; canonical: rust/core/src/generated/schema_registry.rs:41-80 (`SchemaVersion::from_file_schema(..).attribute_names(..)` for IFC2X3/4/4X1/4X2/4X3)
- What: `predefined_type` is read at the IFC4 position regardless of `FILE_SCHEMA`. Example: IFC2X3 `IfcBuildingElementProxy` attribute 8 is `CompositionType`, so a 2X3 proxy reports `PredefinedType = ELEMENT`. Core already solved this for export (`render_attributes` "Unknown source schemas … emit no names rather than borrowing another version's layout").
- Why it matters: The server reports a wrong `PredefinedType` for older-schema files, and maintains 6k lines of generated code that core already provides.
- Fix: Resolve root-attribute indices from core's registry per source schema (cache per type name). Delete the generated table. If TS parity requires IFC4-only behaviour, make that an explicit, tested choice.
- Effort: M

### SERVER-29: Slow uploads hold admission permits; no body read-progress timeout
- Category: Bug (DoS)
- Severity: Medium
- Confidence: LIKELY
- Where: routes/parse/*.rs (acquire before `extract_file`, see SERVER-1); write_timeout.rs:117-127 (`poll_read` has no timer); main.rs:231-233 (`TimeoutLayer` 300 s is the only bound)
- What: Admission is deliberately taken before buffering, but a client trickling 1 byte/s holds a CPU permit and a 500 MB byte reservation for up to 300 s. `WriteTimeoutIo` guards only writes.
- Why it matters: `max_concurrent_parses` (default = cores, often 1–8) slow connections lock every parse route for every tenant, renewable every 5 minutes. The server is unauthenticated by default.
- Fix: Add a read-idle deadline in `WriteTimeoutIo::poll_read`, mirroring `poll_stall`, or a per-chunk `tokio::time::timeout` in `extract_file`'s `field.chunk()` loop with a minimum-throughput rule.
- Effort: S

### SERVER-30: Admission RSS watermark and `Overloaded` construction duplicated
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: admission.rs:121-129 vs :224-230 (same `mem_budget_bytes / 100 * shed_pct` + `rss > 0` rule); `Overloaded { retry_after_secs: queue_timeout.as_secs().max(1) }` at :152-154, :176-178, :205-207 (and `*2` at :127)
- What: The shed rule and the retry-after computation are each written several times.
- Why it matters: If the `acquire` and `/ready` copies of the shed rule diverge, readiness stops reflecting what admission actually does.
- Fix: Add `fn shed_watermark(&self) -> Option<u64>` used by both, and `fn overloaded(&self, mult) -> ApiError`.
- Effort: S

### SERVER-31: `WriteTimeoutIo` duplicates its poll arms
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: write_timeout.rs:111-130 vs :132-152 (`poll_write` / `poll_write_vectored`), :160-171 vs :173-184 (`poll_flush` / `poll_shutdown`)
- What: Each pair matches the same `Ready(Ok)` / `Ready(Err)` / `Pending → poll_stall` shape. `poll_flush` also notes progress on `Ready(Err)`.
- Why it matters: The paired arms have to be kept in sync by hand.
- Fix: Add a helper `fn on_write_poll(&mut self, cx, r: Poll<io::Result<usize>>, empty: bool)` and a generic `fn on_unit_poll`.
- Effort: S

### SERVER-32: Route table listed in three places; two copies are stale
- Category: DRY / Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - main.rs:14-24 (module doc, missing `parse/parquet-stream`, `parse/data-model`, `cache/check`, `cache/geometry`, `ready`, `metrics`)
  - main.rs:155-215 (`build_router`)
  - routes/health.rs:74-107 (`info()`: lists 5 of 16 routes, uses axum-0.7 `:key` syntax)
  - main.rs:208-209 comment "registered only when enabled" is false: the route is always registered and the handler 404s (routes/metrics.rs:9-11)
- What: The route list is maintained by hand in three places, and two of them no longer match the router.
- Why it matters: `GET /` is the self-description clients see, and it is wrong.
- Fix: Use a single `const ROUTES: &[(Method, &str, &str, Handler)]`-style table that drives both `build_router` and `info()`, or delete `info()`'s list.
- Effort: S

### SERVER-33: Stale and contradictory comments
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - services/cache_remove.rs:100-107 names `-json-v2`, `-parquet-metadata-v4`, `-symbolic-v1` (now v6/v5/v4)
  - services/parquet_layout.rs:29-38, :46, :73-76 talk about v6/v7 keys (now v8/v9)
  - services/parquet_instancing.rs:31 "Hash of the quantized positions" (raw f32 bits are hashed)
  - parquet_data_model.rs:681 "Zstd" (LZ4_RAW)
  - routes/parse/mod.rs:219-227 the `unwrap_ifczip` doc is glued onto `is_apple_double`'s doc block
  - admission.rs:268-271 and OPERATIONS.md say "the allocator swap itself was deliberately skipped", but main.rs:31-33 installs mimalloc by default
  - config.rs:29-32 batch-size docs ("first 3 batches", "batches 11+") describe processing internals not enforced here
- What: Each comment describes code or versions that have since changed.
- Why it matters: These comments are the documentation of cache-key versioning, so wrong versions mislead the next bump.
- Fix: Correct each one. Keep version numbers only next to the `format!` that defines them (cache_keys.rs, `ParquetLayout::cache_suffix`).
- Effort: S

### SERVER-34: Dead dependencies, features, config and variants
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED (deps/config) / LIKELY (`Processing`)
- Where:
  - Cargo.toml:58 `tokio-stream` (no use in src, tests or benches)
  - Cargo.toml parquet features `snap`, `zstd` (production uses only LZ4_RAW; `zstd` pulls the C `zstd-sys` into a crate whose docs stress pure-Rust/musl builds)
  - tower-http `decompression-gzip`, `limit` (unused: decompression is manual, the limit is axum's `DefaultBodyLimit`)
  - config.rs:33-34, :180-183 `cache_max_age_days` (OPERATIONS.md admits nothing reads it)
  - services/cache.rs:121-133 `remove`/`clear` behind `#[allow(dead_code)]`
  - error.rs:30-31 `ApiError::Processing`, only constructed by `From<core::Error>` / `From<geometry::Error>` (error.rs:124-134), which no handler `?`s (pipeline entry points return values, not `Result`)
- What: These items are compiled, configured or documented but never used.
- Why it matters: Build time, binary size, cross-compile risk, and a configuration knob that does nothing.
- Fix: Remove them, or wire `CACHE_MAX_AGE_DAYS` to a pruning task.
- Effort: S

### SERVER-35: Client-caused decompression failures return 500
- Category: Quirk
- Severity: Low
- Confidence: CONFIRMED
- Where: routes/parse/mod.rs:194 (gzip `ApiError::Internal`), :317 (zip entry inflate `Internal`)
- What: Corrupt gzip or zip input from the client produces `500 INTERNAL_ERROR`, while a corrupt zip directory gives 400 (:257).
- Why it matters: Server alerting is triggered by bad uploads, and clients see inconsistent status codes for the same class of problem.
- Fix: Map both to `BadRequest`.
- Effort: S

### SERVER-36: Config parsing has two styles with duplicated defaults, plus an env re-parse
- Category: DRY / Quirk
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - config.rs:116-183: seven fields use `get(K).unwrap_or_else(|| "500".into()).parse().unwrap_or(500)`, with the default written twice, once as a string and once as a number; others use `.and_then(parse).unwrap_or(n)`
  - main.rs:328-330 re-reads `IFC_MEM_BUDGET_MB` outside `Config`
  - config.rs:201-205 `Default` reads the process env
  - No validation: `WORKER_THREADS=0` ⇒ `admission_queue_depth = 0` (every contended request 503s); `MAX_FILE_SIZE_MB` near `usize::MAX` ⇒ `(max + 16) * 1024 * 1024` in main.rs:228 wraps (overflow-checks off); invalid `CORS_ORIGINS` entries are silently dropped (main.rs:93)
- What: Defaults are duplicated, the memory-budget variable is parsed twice, and invalid values are silently accepted.
- Why it matters: Misconfiguration produces silent bad behaviour instead of a startup error.
- Fix: Add one `fn env<T: FromStr>(get, key, default: T) -> T`. Keep "explicitly set" as a `Config` field (`mem_budget_source`) instead of re-reading the env. Use `checked_mul`/`saturating_mul`, warn on dropped origins, and remove `impl Default`.
- Effort: S

### SERVER-37: Flat mesh table `index_count` disagrees with the written triangles for a ragged index buffer
- Category: Quirk
- Severity: Low
- Confidence: SUSPECT
- Where: services/parquet_mesh_tables.rs:64 and :77 (`index_count = indices.len()`) vs :164-172 (writes `indices.len() / 3` rows); parquet_replay_batches.rs:253-257 (acknowledges the per-row rounding)
- What: A mesh whose index count is not a multiple of 3 advances `index_start` by `len` but writes `floor(len/3)` rows. Every later mesh's `index_start / 3` then points one row off. axis.rs:41-52 treats the analogous position case defensively. Indices are also never range-checked against `vertex_count`.
- Why it matters: If the pipeline ever emits a ragged buffer, all following meshes in the table decode with shifted triangles.
- Fix: Truncate `indices` to a multiple of 3 (with a warning) once, before planning, using the same rule for counts and rows.
- Effort: S

### SERVER-38: Data-model extractors do repeated full-job scans and per-call uppercasing
- Category: Perf
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - Eight extractors each filter all jobs by type: properties.rs:24-27, quantities.rs, relationships.rs, materials.rs:251-256, classifications.rs, documents.rs, metadata.rs
  - spatial.rs:142 (`rel.rel_type.to_uppercase()` per relationship), :63-82 (`to_uppercase` per call), :172 (`children.contains` makes promoted children O(k²))
  - data_model/mod.rs:156 (`to_uppercase() == "IFCPROJECT"` per entity)
  - resolve_material/document `to_ascii_uppercase` per call
- What: Each extractor repeats work (type filtering, uppercasing) that could be done once.
- Why it matters: Millions of entities means millions of avoidable allocations, plus eight redundant passes.
- Fix: Bucket `EntityJob`s by `IfcType` once, compare with `eq_ignore_ascii_case` or `IfcType`, and use an `FxHashSet` for child dedup.
- Effort: S

### SERVER-39: `resolve_material` repeats the same set-walk three times and the usage arm twice
- Category: DRY
- Severity: Low
- Confidence: CONFIRMED
- Where: services/data_model/materials.rs:76-116 (LayerSet), :119-151 (List), :152-188 (ConstituentSet), :196-236 (ProfileSet), :69-74 and :190-195 (usage arms)
- What: Each arm repeats: member list at attribute N → `member_count` → decode each → subtype check → `material_details_of(attr M)` → `ResolvedLayer { … }` with 13 fields.
- Why it matters: Field mistakes are easy to make and hard to see, and the usage arms are where SERVER-5 lives.
- Fix: Make it table-driven: `SetSpec { kind, list_attr, member_type, material_attr, name_attr, category_attr, thickness_attr, fraction_attr }`.
- Effort: S

### SERVER-40: Test scaffolding is heavily copy-pasted
- Category: DRY (tests)
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - `test_state` ×17: parity_tests.rs:99, auth_and_cache_tests.rs:25, cors_tests.rs:36, middleware/error_envelope_tests.rs:25, routes/{metrics_tests.rs:36, cache_get_tests.rs:28, health_tests.rs:30, cache_delete_tests.rs:95}, routes/parse/{parquet_tests.rs:40, cached_replay_tests.rs:24, json_tests.rs:73, fetch_tests.rs:31, parquet_stream_tests.rs:85, parquet_optimized_tests.rs:69, cached_replay_batches_tests.rs:24, data_model_entities_tests.rs:59, parquet_stream_cross_batch_tests.rs:107}
  - `multipart_body` ×6: parity_tests.rs:84, parquet_tests.rs:27, parquet_optimized_tests.rs:56, cache_delete_tests.rs:82, parquet_stream_tests.rs:72, json_tests.rs:60
  - Optimized-header and section parsing inline: services/parquet_optimized_tests.rs:112, 187, 254, 407, 640, 834; finish_wire_tests.rs:52-57; parquet_data_model_tests.rs:20; parquet_stream_cross_batch_tests.rs:147; data_model_entities_tests.rs:122
  - Inline `ISO-10303-21` fixtures ×41 across 15 files; 25 `AdmissionCfg {…}` literals
  - jscpd also lists parquet_stream_tests.rs:33-65 ⇔ :181-213 and finish_tests.rs ⇔ processing/tests/issue_957
- What: Some `test_state` copies pin `api_token = None`, others use raw `Config::from_env()`. config.rs:100-104 says that exact difference makes suites fail under an exported token. Temp dirs are removed before use but never after.
- Why it matters: Fixture changes must be made in many files, and the token-handling difference makes some suites environment-dependent.
- Fix: Add a `#[cfg(test)] mod test_support` with `TestState::builder().admission(..).token(..)`, `multipart(content, filename)`, `read_sections(blob)`, `read_optimized(blob)`, and `fixtures::minimal_ifc(..)` (extend `parquet_test_fixtures`). Use a `tempfile::TempDir` guard.
- Effort: M

### SERVER-41: `quantize_position` silently saturates
- Category: Quirk
- Severity: Low
- Confidence: SUSPECT
- Where: services/parquet_optimized.rs:42-44
- What: `(value * 10_000.0).round() as i32` saturates beyond ±214.7 km and maps NaN to 0, without any error or warning.
- Why it matters: World-baked meshes (origin 0) of an un-shifted georeferenced model would collapse to `i32::MAX` on the optimized route only.
- Fix: Check the per-mesh range (`value.abs() < i32::MAX as f32 / VERTEX_MULTIPLIER`). On violation, return `ParquetError::Overflow`, or fall back to the flat route's float encoding.
- Effort: S

### SERVER-42: Content-hash dedup uses per-element SipHash
- Category: Perf
- Severity: Low
- Confidence: CONFIRMED
- Where: services/parquet_instancing.rs:40-58 (`DefaultHasher` + `item.hash()` per f32/u32 over every vertex of every mesh); copy at benches/serialization.rs:287-303
- What: SipHash is applied element by element across all geometry.
- Why it matters: Shared-shapes and optimized routes hash all geometry roughly an order of magnitude slower than necessary.
- Fix: Hash the byte view once (`bytemuck::cast_slice`) with `FxHasher`/`ahash`, or reuse `ifc_lite_geometry`'s geometry hash (`geom_hash.rs`) so dedup keys match the kernel's.
- Effort: S

### SERVER-43: Cache-key namespace definitions are scattered despite the "THE definition" policy
- Category: Maintainability
- Severity: Low
- Confidence: CONFIRMED
- Where: routes/parse/cache_keys.rs (most keys); routes/parse/stream_progress.rs:25 (`-parquet-progress-v1`); services/parquet_layout.rs:52 (`parquet-v8/v9`); data_model `DataModelEntities::cache_infix`; `OpeningFilterMode::cache_key_suffix` (processing)
- What: cache_keys.rs:108-113 explains that scattered `format!` literals caused writer/reader mismatches. The progress sidecar key still lives elsewhere.
- Why it matters: `DELETE`'s prefix logic and any future cache audit have to discover every suffix.
- Fix: Move `stream_progress_cache_key` into cache_keys.rs and list every suffix in one `enum CacheEntry` with a `key(&self, cache_key)` method.
- Effort: S

### SERVER-44: Error-type sprawl
- Category: Best-practice
- Severity: Low
- Confidence: CONFIRMED
- Where:
  - error.rs:17-50 (`ApiError` with string-flattened `Processing/Cache/Internal/Parquet(String)`)
  - services/parquet.rs:31-40 (`ParquetError`), parquet_data_model.rs:30-39 (`DataModelParquetError`, an overlapping Arrow/Parquet/Io set plus `Json`), main.rs (`anyhow`)
  - error.rs:41-42 `Join` renders as the bare "Join error"
- What: Two Parquet error enums duplicate variants, and `ApiError::Parquet(String)` erases both sources.
- Why it matters: Error sources are lost, so failures are harder to diagnose and status mapping is coarse.
- Fix: Merge into one `SerializeError` (thiserror, `#[from]`). Keep `ApiError` variants typed (`#[source]`) and render strings only in `into_response`.
- Effort: S

### SERVER-45: Minor quirks
- Category: Quirk
- Severity: Low
- Confidence: CONFIRMED / SUSPECT
- Where:
  - middleware/auth.rs:46: `strip_prefix("Bearer ")` is case-sensitive; RFC 7235 schemes are case-insensitive
  - admission.rs:283: RSS = pages × 4096 hard-coded; wrong on 64 KiB-page aarch64 kernels (SUSPECT, depends on release targets)
  - routes/parse/mod.rs:120-133: `cache_symbolic_data_off_runtime` parks a blocking-pool thread on `Handle::block_on` for the async disk write; only the JSON encode needs the blocking pool
  - routes/parse/parquet.rs:94-99: the cache-hit tuple awaits all four reads even after the first misses
  - routes/parse/mod.rs:158-166: `Vec::new()` growth for up-to-500 MB uploads (≈1.5–2× transient)
  - routes/parse/fetch.rs:252/258: `resolved_tessellation_quality()` is called twice
- What: Small correctness and efficiency issues, each local to one site.
- Why it matters: Individually minor; the auth one rejects valid clients and the RSS one makes shedding wrong on some hosts.
- Fix:
  - Compare the scheme with `eq_ignore_ascii_case`.
  - Read `AT_PAGESZ` from `/proc/self/auxv`, or use `/proc/self/status` `VmRSS`.
  - Run only the encode in `spawn_blocking` and await `set_bytes` normally.
  - Short-circuit the cache-hit reads.
  - Reserve with a `Content-Length` hint.
  - Resolve the quality once.
- Effort: S

## Concept inventory
- Vector/matrix:
  - `zup_to_yup` services/axis.rs:22; `zup_to_yup_f64` axis.rs:30; `mesh_to_yup_in_place` axis.rs:40
  - `apply_r_t` services/parquet_instancing.rs:125; `mat3_mul` parquet_instancing.rs:219; `rotation_zup_to_yup` parquet_instancing.rs:236; `P_ZUP_TO_YUP`/`_T` parquet_instancing.rs:216-217; `IDENTITY_ROTATION` parquet_instancing.rs:280 (plus an inline f64 identity at :207)
  - `verify_and_derive_placement` parquet_instancing.rs:140
  - `shape_vertices` (Y-up columns) services/parquet_vertex_columns.rs:20
- Transforms/placements:
  - `baked_basis_zup` services/parquet_instancing.rs:83 (wraps `ifc_lite_processing::native_to_baked`)
  - `collate_rotation_aware_placements` parquet_instancing.rs:307
  - `StreamEvent::Batch.baked_basis` types/response.rs:72
  - `extract_placement_elevation` services/data_model/spatial_elevation.rs:78
- Tolerances/epsilons/limits:
  - `RECOMPOSITION_TOLERANCE_M = 1e-4` parquet_instancing.rs:111; `VERTEX_MULTIPLIER = 10_000` parquet_optimized.rs:38
  - `MAX_COMPLEX_PROPERTY_DEPTH = 8` data_model/property_value.rs:18; classification walk depth 8 data_model/classifications.rs:52
  - `MAX_SPATIAL_TREE_DEPTH = 100` data_model/spatial_tree.rs:21; `CYCLE_CHECK_VISIT_BUDGET = 2_000_000` data_model/spatial_canonical_parent.rs:23
  - `RETAINED_TEMPLATE_BUDGET_BYTES = 256 MiB` services/parquet_stream_shapes.rs:41
  - `BYTES_PER_PERMIT` admission.rs:49; `BUDGET_PCT_OF_CEILING = 70` mem_policy.rs:24; cgroup unlimited sentinel `1 << 60` mem_policy.rs:64
  - `EVENT_BUFFER_EVENTS = 4` services/streaming.rs:54
  - `MAX_MESSAGE_BYTES` middleware/error_envelope.rs:31; `BODY_LIMIT_SLACK_MB` main.rs:66; `INDEX_WALK_RETRY_AFTER_SECS` services/cache_remove.rs:21
- Unit conversion:
  - `extract_length_unit_scale` use data_model/mod.rs:159; `MaterialUnitContext` (+ `scale_for` ownership walk) data_model/material_units.rs:11/94
  - storey elevation scaling data_model/spatial_elevation.rs:44
- BBox/AABB: none in this area.
- Hashing:
  - `DiskCache::generate_key` (SHA-256) services/cache.rs:77
  - `hash_u32_slice`/`hash_f32_slice`/`mesh_geometry_key`/`MeshGeometryKey` parquet_instancing.rs:40/50/61/30
  - `MaterialKey` parquet_optimized.rs:53
  - bench copies benches/serialization.rs:287-317
- Triangulation/polygon ops: none (consumes processing output).
- Entity attribute access/decoding:
  - `root_attr_indices` data_model/generated/attr_indices.rs (IFC4-only table); `relationship_slots` data_model/generated/relationship_slots.rs
  - `read_logical` data_model/mod.rs:231; `related_object_ids` data_model/mod.rs:241; `string_at`/`enum_at` data_model/metadata.rs:29/43
  - `resolve_single_value` data_model/property_value.rs:237; `fmt_number` property_value.rs:304; `logical_token` property_value.rs:229
  - `resolve_material` data_model/materials.rs:45; `resolve_classification` data_model/classifications.rs:15; `resolve_document` data_model/documents.rs:14
  - `is_spatial_type` closure data_model/spatial.rs:63; `detect_schema_version` services/streaming.rs:65; `declares_global_id` data_model/rooted.rs:117
- Colour/style:
  - `color_to_byte` parquet_optimized.rs:48; `MaterialKey::from_color` parquet_optimized.rs:62
  - `MeshData::finish_wire` types/mesh.rs:63; `finish_meshes` types/mesh.rs:90 (wraps `ifc_lite_processing::style::ModelFinishes`)
- Framing/serialization:
  - `check_u32_len` services/parquet.rs:137; `frame_sections` parquet.rs:150; `frame_combined_sections` parquet.rs:174; `assemble_optimized_output` parquet_optimized.rs:425
  - data-model framer parquet_data_model.rs:97; `take_length_prefixed` services/parquet_replay_batches.rs:243; `cached_geometry_slice` routes/parse/cached_replay.rs:127
  - `write_parquet_buffer` parquet.rs:300 and parquet_optimized.rs:466; `writer_props` parquet.rs:322; `write_parquet_batch` parquet_data_model.rs:682
- Error types:
  - `ApiError` error.rs:17; `ErrorResponse`/`error_response` error.rs:65/73; `code_for_status` middleware/error_envelope.rs:77
  - `ParquetError` services/parquet.rs:31; `DataModelParquetError` services/parquet_data_model.rs:30; `anyhow` in main.rs
