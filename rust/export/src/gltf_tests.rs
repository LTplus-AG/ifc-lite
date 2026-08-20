// SPDX-License-Identifier: MPL-2.0
//! Tests for `gltf.rs`, split out under the house pattern (AGENTS.md).
//!
//! `gltf.rs` sits on the module-size ratchet's allowlist at its recorded
//! budget, and the ratchet counts non-test lines -- so tests that grow with
//! the module have to live beside it rather than inside it.

use super::*;
// The exporters route through the quality-carrying entry point now, so the
// plain one is named here rather than inherited from the parent module.
use ifc_lite_processing::process_geometry;
use ifc_lite_processing::TessellationQuality;

/// Parse a GLB and return (json: Value, bin: Vec<u8>).
fn parse_glb(glb: &[u8]) -> (Value, Vec<u8>) {
    // Assert the literal magic bytes (not a derived constant) so a wrong magic
    // constant in pack_glb can't pass the test self-consistently.
    assert_eq!(&glb[0..4], b"glTF", "glTF magic");
    assert_eq!(u32::from_le_bytes(glb[4..8].try_into().unwrap()), 2, "version 2");
    let total = u32::from_le_bytes(glb[8..12].try_into().unwrap()) as usize;
    assert_eq!(total, glb.len(), "header total length matches");

    let json_len = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
    assert_eq!(&glb[16..20], b"JSON", "JSON chunk tag");
    let json_start = 20;
    let json_end = json_start + json_len;
    let json: Value = serde_json::from_slice(&glb[json_start..json_end]).expect("valid JSON");

    let bin_len = u32::from_le_bytes(glb[json_end..json_end + 4].try_into().unwrap()) as usize;
    assert_eq!(&glb[json_end + 4..json_end + 8], b"BIN\0", "BIN tag");
    let bin = glb[json_end + 8..json_end + 8 + bin_len].to_vec();
    (json, bin)
}

// ── geom_color_key: dedup-key properties (fixture-free) ───────────────
//
// No test elsewhere touches `geom_color_key` directly — every existing
// test exercises it only indirectly through fixture models, where
// near-identical parts happen not to occur. These pin the exact
// properties the flat-remainder dedup depends on: distinct inputs must
// not collapse to the same key, bit-identical inputs must, and the
// length frame written before each attribute run must actually stop
// differently-split buffers from aliasing.

#[test]
fn geom_color_key_distinguishes_one_position_bit() {
    let positions_a = [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let mut positions_b = positions_a;
    // Flip the least-significant bit of one coordinate: the smallest
    // possible perturbation a real mesh could carry.
    positions_b[0] = f32::from_bits(positions_a[0].to_bits() ^ 1);
    let normals = [0.0f32, 0.0, 1.0];
    let indices = [0u32, 1, 2];
    let color = [1.0f32, 0.0, 0.0, 1.0];
    let key_a = geom_color_key(&positions_a, &normals, &indices, color);
    let key_b = geom_color_key(&positions_b, &normals, &indices, color);
    assert_ne!(key_a, key_b, "a one-bit position difference must not collapse the dedup key");
}

#[test]
fn geom_color_key_distinguishes_color_only() {
    let positions = [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let normals = [0.0f32, 0.0, 1.0];
    let indices = [0u32, 1, 2];
    let color_a = [1.0f32, 0.0, 0.0, 1.0];
    let color_b = [0.0f32, 1.0, 0.0, 1.0];
    let key_a = geom_color_key(&positions, &normals, &indices, color_a);
    let key_b = geom_color_key(&positions, &normals, &indices, color_b);
    assert_ne!(key_a, key_b, "colour is part of the key: material rides the primitive, not the node");
}

#[test]
fn geom_color_key_distinguishes_normals_only() {
    let positions = [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let normals_a = [0.0f32, 0.0, 1.0];
    let normals_b = [0.0f32, 0.0, -1.0];
    let indices = [0u32, 1, 2];
    let color = [1.0f32, 0.0, 0.0, 1.0];
    let key_a = geom_color_key(&positions, &normals_a, &indices, color);
    let key_b = geom_color_key(&positions, &normals_b, &indices, color);
    assert_ne!(key_a, key_b, "a normals-only difference must not collapse the dedup key");
}

#[test]
fn geom_color_key_distinguishes_indices_only() {
    let positions = [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let normals = [0.0f32, 0.0, 1.0];
    let indices_a = [0u32, 1, 2];
    let indices_b = [0u32, 2, 1]; // reversed winding, same vertex set
    let color = [1.0f32, 0.0, 0.0, 1.0];
    let key_a = geom_color_key(&positions, &normals, &indices_a, color);
    let key_b = geom_color_key(&positions, &normals, &indices_b, color);
    assert_ne!(key_a, key_b, "an indices-only difference must not collapse the dedup key");
}

#[test]
fn geom_color_key_is_stable_for_bit_identical_meshes() {
    let positions = [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let normals = [0.0f32, 0.0, 1.0];
    let indices = [0u32, 1, 2];
    let color = [1.0f32, 0.0, 0.0, 1.0];
    let key_a = geom_color_key(&positions, &normals, &indices, color);
    // Independently constructed but bit-identical buffers, hashed again.
    let positions_b = positions;
    let normals_b = normals;
    let indices_b = indices;
    let key_b = geom_color_key(&positions_b, &normals_b, &indices_b, color);
    assert_eq!(key_a, key_b, "bit-identical meshes must collapse to the same dedup key");
}

#[test]
fn geom_color_key_length_frame_prevents_split_aliasing() {
    // The function writes a `u64` LENGTH before each attribute run,
    // exactly so the byte string hashed for one (normals, indices)
    // split can never equal the byte string hashed for a different
    // split. This constructs the two inputs whose *hashed byte
    // strings* are engineered to coincide if that length frame were
    // dropped: `positions` is identical on both sides, so it's the
    // `normals`/`indices` boundary under test.
    //
    // Side A: normals = [] (0 elements), indices = [1, 0, 777].
    //   Frame-less tail bytes (LE u32/u64): the real indices-length
    //   frame for len=3 is `03 00 00 00 00 00 00 00`, followed by
    //   `01 00 00 00 | 00 00 00 00 | (777 as u32 LE)`.
    // Side B: normals = [bits(3), bits(0)] (2 elements chosen so their
    //   raw bytes equal A's indices-length frame), indices = [777]
    //   (1 element).
    //   Frame-less tail bytes: `03 00 00 00 00 00 00 00` (normals) then
    //   the real indices-length frame for len=1, `01 00 00 00 00 00 00
    //   00`, then `(777 as u32 LE)`.
    //
    // Byte-for-byte these two tails are IDENTICAL once the normals
    // length frame is removed — the indices-length frame from A lands
    // exactly where B's normals payload sits, and each side's own
    // indices-length frame absorbs the other's leftover indices
    // element. With the frame present, the extra 8 bytes it
    // contributes (normals.len() = 0 for A, 2 for B) break that
    // alignment and the keys must differ.
    let positions = [9.0f32];
    let color = [1.0f32, 0.0, 0.0, 1.0];

    let normals_a: [f32; 0] = [];
    let indices_a = [1u32, 0, 777];
    let key_a = geom_color_key(&positions, &normals_a, &indices_a, color);

    let normals_b = [f32::from_bits(3), f32::from_bits(0)];
    let indices_b = [777u32];
    let key_b = geom_color_key(&positions, &normals_b, &indices_b, color);

    assert_ne!(
        key_a, key_b,
        "different (normals, indices) splits engineered to alias without the length \
         frame must still produce different keys with the frame present"
    );
}

#[test]
fn with_index_glb_is_byte_identical() {
    // The shared-index path must emit byte-for-byte the same GLB as the
    // self-indexing path — it only injects an index equal to the one
    // `export_glb_with_stats` builds internally. Guards the two from drifting.
    let bytes = fixture_or_skip!("ara3d/duplex.ifc");
    let opts = GltfOptions::default();
    let (plain, _) = export_glb_with_stats(&bytes, &opts);
    let idx = Arc::new(crate::build_entity_index(&bytes));
    let (shared, _) = export_glb_with_stats_with_index(&bytes, &opts, idx);
    assert_eq!(plain, shared, "shared-index GLB must equal self-indexed GLB");
}

#[test]
fn tessellation_quality_reaches_the_exporter_and_changes_the_mesh() {
    // The feature this PR adds, pinned end to end rather than at the seam.
    //
    // `GltfOptions::default()` is Medium and is the golden-output identity, so
    // a test that only exercises the default cannot tell whether the option is
    // wired at all - it would pass identically against the old
    // `process_geometry` call that ignored quality entirely. Coarse must
    // therefore produce a DIFFERENT GLB, and the direction matters too: a
    // coarser tessellation on a curve-bearing model emits fewer vertices, so
    // asserting merely "not equal" would also pass if the option were routed
    // to the wrong parameter and produced some other change.
    // `fixture_opt`, not `fixture`: the house rule is to SKIP when the corpus
    // is not fetched rather than throw. The eprintln keeps a zero-coverage run
    // visible instead of masquerading as a pass (the Greptile #1511 lesson).
    let Some(bytes) = crate::test_support::fixture_opt("ara3d/duplex.ifc") else {
        eprintln!("skipping tessellation_quality_reaches_the_exporter: corpus not fetched");
        return;
    };

    let (medium, medium_stats) = export_glb_with_stats(&bytes, &GltfOptions::default());
    let (coarse, coarse_stats) = export_glb_with_stats(
        &bytes,
        &GltfOptions { tessellation_quality: TessellationQuality::Low, ..Default::default() },
    );

    assert_ne!(
        medium, coarse,
        "Low tessellation must not produce the Medium GLB - the option is not reaching \
         `process_geometry_filtered_with_quality` if these are equal"
    );
    assert!(
        coarse.len() < medium.len(),
        "coarser tessellation should emit a SMALLER GLB (medium {} bytes, coarse {} bytes); \
         a difference in the other direction means the quality was routed somewhere unintended",
        medium.len(),
        coarse.len()
    );
    // Both must still be real exports: a quality value that broke meshing
    // would also satisfy the two assertions above by emitting nothing.
    assert!(medium_stats.meshes > 0, "medium export produced no meshes");
    assert!(coarse_stats.meshes > 0, "coarse export produced no meshes");
}

#[test]
fn default_tessellation_quality_is_the_golden_medium() {
    // Guards the identity the rest of the golden tests rest on: adding the
    // option must not have moved the default output.
    let Some(bytes) = crate::test_support::fixture_opt("ara3d/duplex.ifc") else {
        eprintln!("skipping default_tessellation_quality_is_the_golden_medium: corpus not fetched");
        return;
    };
    let (implicit, _) = export_glb_with_stats(&bytes, &GltfOptions::default());
    let (explicit, _) = export_glb_with_stats(
        &bytes,
        &GltfOptions { tessellation_quality: TessellationQuality::Medium, ..Default::default() },
    );
    assert_eq!(implicit, explicit, "default must be byte-identical to explicit Medium");
}

// ── #1516: streaming shared-index + fail-fast size ────────────────────

/// The container-size math is u64 end-to-end so an oversize model does NOT
/// truncate on wasm32 (32-bit `usize`) — the regression the projection guards.
#[test]
fn glb_container_size_does_not_truncate() {
    // 12 header + 8 json-chunk hdr + padded json + 8 bin-chunk hdr + padded bin.
    // json 10 -> pad to 12; bin 20 already aligned.
    assert_eq!(glb_container_size(10, 20), 12 + 8 + 12 + 8 + 20);
    // A > 4 GiB BIN payload must stay > u32::MAX (not wrap to a small usize).
    let big = 5_000_000_000u64; // > u32::MAX (4_294_967_295)
    let total = glb_container_size(100, big);
    assert_eq!(total, 12 + 8 + 100 + 8 + big, "no truncation, exact u64 sum");
    assert!(total > u32::MAX as u64, "oversize total must exceed 4 GiB, got {total}");
}


/// The shared-index BOUNDED GLB path must emit byte-for-byte the same GLB as
/// the self-indexing one — the injected index equals the one the bounded
/// assembler builds internally, so only the redundant scan is removed.
#[test]
fn bounded_glb_with_index_is_byte_identical() {
    let bytes = fixture_or_skip!("ara3d/duplex.ifc");
    for quantize in [false, true] {
        let opts = GltfOptions { quantize, ..GltfOptions::default() };
        let (plain, ps) = export_glb_streaming_bounded(&bytes, &opts);
        let idx = Arc::new(crate::build_entity_index(&bytes));
        let (shared, ss) = export_glb_streaming_bounded_with_index(&bytes, &opts, idx);
        assert_eq!(plain, shared, "shared-index bounded GLB must match (quantize={quantize})");
        assert_eq!(ps, ss, "stats must match");
    }
}

/// The shared-index MULTI-BUFFER path must produce an identical `.gltf` JSON
/// and identical external buffers as the self-indexing one.
#[test]
fn gltf_streaming_with_index_is_byte_identical() {
    let bytes = fixture_or_skip!("ara3d/duplex.ifc");
    let opts = GltfOptions::default();
    let cap = 256 * 1024;

    let mut plain_bufs: Vec<Vec<u8>> = Vec::new();
    let plain_json = export_gltf_streaming(&bytes, &opts, cap, |b| plain_bufs.push(b.bytes));

    let idx = Arc::new(crate::build_entity_index(&bytes));
    let mut shared_bufs: Vec<Vec<u8>> = Vec::new();
    let shared_json =
        export_gltf_streaming_with_index(&bytes, &opts, idx, cap, |b| shared_bufs.push(b.bytes));

    assert_eq!(plain_json, shared_json, "shared-index .gltf JSON must match");
    assert_eq!(plain_bufs, shared_bufs, "shared-index buffers must match");
}

/// `project_glb_size` (pass 1 only) must return the EXACT byte size of the GLB
/// the bounded assembler actually produces, plus matching coverage stats and
/// `fits_single_glb = true` for a normal model — so a caller can pick single
/// GLB vs multi-buffer without meshing to completion twice.
#[test]
fn project_glb_size_matches_bounded_output() {
    let bytes = fixture_or_skip!("ara3d/duplex.ifc");
    for quantize in [false, true] {
        let opts = GltfOptions { quantize, ..GltfOptions::default() };
        let proj = project_glb_size(&bytes, &opts);
        let (glb, stats) = export_glb_streaming_bounded(&bytes, &opts);
        assert_eq!(
            proj.total_bytes as usize,
            glb.len(),
            "projected size must equal the real GLB length (quantize={quantize})"
        );
        assert!(proj.fits_single_glb, "duplex fits a single GLB");
        assert_eq!(proj.stats, stats, "projected stats must match the export");
        // Shared-index projection must agree with the self-indexed one.
        let idx = Arc::new(crate::build_entity_index(&bytes));
        let proj_idx = project_glb_size_with_index(&bytes, &opts, idx);
        assert_eq!(proj_idx.total_bytes, proj.total_bytes);
        assert_eq!(proj_idx.bin_bytes, proj.bin_bytes);
    }
}

/// The checked bounded export returns the SAME bytes as the panicking one for
/// a model that fits (the common case), so `try_*` is a drop-in that only
/// changes the oversize behaviour (typed error vs panic).
#[test]
fn try_export_bounded_matches_export_for_fitting_model() {
    let bytes = fixture_or_skip!("ara3d/duplex.ifc");
    let opts = GltfOptions::default();
    let (want, wstats) = export_glb_streaming_bounded(&bytes, &opts);
    let (got, gstats) = try_export_glb_streaming_bounded(&bytes, &opts)
        .expect("duplex fits — must not be TooLarge");
    assert_eq!(want, got, "checked bounded GLB must equal the panicking one");
    assert_eq!(wstats, gstats);

    // The top-level fail-closed API agrees with the in-memory export for a
    // small model and still guards the empty case.
    let (glb, _) = try_export_glb_with_stats(&bytes, &opts).expect("has geometry");
    let (want2, _) = export_glb_with_stats(&bytes, &opts);
    assert_eq!(glb, want2, "try_export_glb_with_stats must match export_glb_with_stats");
}

// ── KHR_mesh_quantization ────────────────────────────────────────────

/// Column-major 4x4 multiply, `a * b`.
fn mat_mul(a: &[f64; 16], b: &[f64; 16]) -> [f64; 16] {
    let mut c = [0.0; 16];
    for col in 0..4 {
        for row in 0..4 {
            c[col * 4 + row] = (0..4).map(|k| a[k * 4 + row] * b[col * 4 + k]).sum();
        }
    }
    c
}
fn transform_point(m: &[f64; 16], p: [f64; 3]) -> [f64; 3] {
    [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    ]
}
/// Local transform of a glTF node from its `matrix`, or its `translation`/`scale` TRS.
fn node_local(node: &Value) -> [f64; 16] {
    if let Some(m) = node.get("matrix").and_then(Value::as_array) {
        let mut out = [0.0; 16];
        for (i, v) in m.iter().enumerate() {
            out[i] = v.as_f64().unwrap();
        }
        return out;
    }
    let t = node.get("translation").and_then(Value::as_array);
    let s = node.get("scale").and_then(Value::as_array);
    let g = |a: Option<&Vec<Value>>, i: usize, d: f64| {
        a.and_then(|a| a.get(i)).and_then(Value::as_f64).unwrap_or(d)
    };
    [
        g(s, 0, 1.0), 0.0, 0.0, 0.0,
        0.0, g(s, 1, 1.0), 0.0, 0.0,
        0.0, 0.0, g(s, 2, 1.0), 0.0,
        g(t, 0, 0.0), g(t, 1, 0.0), g(t, 2, 0.0), 1.0,
    ]
}
/// Decode one POSITION accessor (f32 or normalized SHORT) to local-space points.
fn decode_positions(json: &Value, bufs: &[&[u8]], acc_idx: usize) -> Vec<[f64; 3]> {
    let acc = &json["accessors"][acc_idx];
    let bv = &json["bufferViews"][acc["bufferView"].as_u64().unwrap() as usize];
    let bin = bufs[bv["buffer"].as_u64().unwrap() as usize];
    let base = bv["byteOffset"].as_u64().unwrap_or(0) as usize
        + acc["byteOffset"].as_u64().unwrap_or(0) as usize;
    let count = acc["count"].as_u64().unwrap() as usize;
    let ct = acc["componentType"].as_u64().unwrap();
    // Respect the declared byteStride (don't assume tight packing — the quantized
    // SHORT VEC3 attrs are padded to an 8-byte stride).
    let csz = if ct == 5126 { 4 } else { 2 };
    let stride = bv["byteStride"].as_u64().map(|s| s as usize).unwrap_or(csz * 3);
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let comp = |k: usize| -> f64 {
            let o = base + i * stride + k * csz;
            match ct {
                5126 => f32::from_le_bytes(bin[o..o + 4].try_into().unwrap()) as f64,
                5122 => {
                    let s = i16::from_le_bytes(bin[o..o + 2].try_into().unwrap());
                    (s as f64 / 32767.0).max(-1.0) // normalized SHORT
                }
                other => panic!("unexpected POSITION componentType {other}"),
            }
        };
        out.push([comp(0), comp(1), comp(2)]);
    }
    out
}
/// World-space AABB over every mesh node, walking the scene graph (handles the
/// quantized nested dequant child nodes via the accumulated transform).
fn world_aabb(json: &Value, bufs: &[&[u8]]) -> ([f64; 3], [f64; 3]) {
    let nodes = json["nodes"].as_array().unwrap();
    let ident = {
        let mut m = [0.0; 16];
        m[0] = 1.0; m[5] = 1.0; m[10] = 1.0; m[15] = 1.0;
        m
    };
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    let mut stack: Vec<(usize, [f64; 16])> = json["scenes"][0]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| (n.as_u64().unwrap() as usize, ident))
        .collect();
    while let Some((ni, parent)) = stack.pop() {
        let node = &nodes[ni];
        let world = mat_mul(&parent, &node_local(node));
        if let Some(mi) = node.get("mesh").and_then(Value::as_u64) {
            let acc = json["meshes"][mi as usize]["primitives"][0]["attributes"]["POSITION"]
                .as_u64()
                .unwrap() as usize;
            for p in decode_positions(json, bufs, acc) {
                let w = transform_point(&world, p);
                for k in 0..3 {
                    lo[k] = lo[k].min(w[k]);
                    hi[k] = hi[k].max(w[k]);
                }
            }
        }
        if let Some(children) = node.get("children").and_then(Value::as_array) {
            for c in children {
                stack.push((c.as_u64().unwrap() as usize, world));
            }
        }
    }
    (lo, hi)
}

#[test]
fn quantized_glb_matches_f32_world_bounds() {
    // The quantized path reconstructs the same WORLD geometry as f32 — proves the
    // per-mesh dequant + placement (incl. the nested instanced dequant nodes)
    // compose correctly. Compared via world-space AABB within a few mm.
    let bytes = fixture_or_skip!("ara3d/duplex.ifc");
    let (f32_glb, _) = export_glb_with_stats(&bytes, &GltfOptions::default());
    let (q_glb, _) = export_glb_with_stats(
        &bytes,
        &GltfOptions { quantize: true, ..Default::default() },
    );
    let (j0, b0) = parse_glb(&f32_glb);
    let (j1, b1) = parse_glb(&q_glb);
    let (lo0, hi0) = world_aabb(&j0, &[&b0]);
    let (lo1, hi1) = world_aabb(&j1, &[&b1]);
    for k in 0..3 {
        assert!(
            (lo0[k] - lo1[k]).abs() < 0.01 && (hi0[k] - hi1[k]).abs() < 0.01,
            "world AABB axis {k} drifted: f32 [{},{}] vs quant [{},{}]",
            lo0[k], hi0[k], lo1[k], hi1[k]
        );
    }
}

// ── multi-buffer glTF ────────────────────────────────────────────────

/// Run a streaming export and collect the buffers in index order.
fn streaming_export(bytes: &[u8], opts: &GltfOptions, cap: usize) -> (Value, Vec<Vec<u8>>) {
    let mut buffers: Vec<Vec<u8>> = Vec::new();
    let json = export_gltf_streaming(bytes, opts, cap, |b| {
        // Buffers are flushed in order buffer0.bin, buffer1.bin, ...
        assert_eq!(b.name, format!("buffer{}.bin", buffers.len()));
        buffers.push(b.bytes);
    });
    (serde_json::from_slice(&json).unwrap(), buffers)
}

#[test]
fn multibuffer_splits_and_matches_single_glb() {
    // A tiny cap forces the geometry across several < cap buffers; the reconstructed
    // world geometry must equal the single-GLB output exactly (f32, same bytes, just
    // split). Proves the chunked bufferView/accessor reindexing is correct.
    let bytes = fixture_or_skip!("ara3d/duplex.ifc");
    let opts = GltfOptions::default();
    let (glb, _) = export_glb_with_stats(&bytes, &opts);
    let (gj, gb) = parse_glb(&glb);
    let (lo0, hi0) = world_aabb(&gj, &[&gb]);

    // Above duplex's largest single mesh (~67 KB) so the cap is respected, but small
    // enough to force a multi-buffer split. (A single mesh over the cap legitimately
    // gets its own over-cap buffer — geometry can't span buffers.)
    let cap = 256 * 1024;
    let (j, bufs) = streaming_export(&bytes, &opts, cap);
    assert!(bufs.len() >= 2, "cap must split; got {} buffers", bufs.len());
    for b in &bufs {
        assert!(b.len() <= cap, "buffer {} exceeds cap {cap}", b.len());
    }
    // The .gltf declares one buffer per chunk, each with an external uri.
    let decl = j["buffers"].as_array().unwrap();
    assert_eq!(decl.len(), bufs.len());
    for (k, b) in decl.iter().enumerate() {
        assert_eq!(b["uri"], Value::String(format!("buffer{k}.bin")));
        assert_eq!(b["byteLength"].as_u64().unwrap() as usize, bufs[k].len());
    }
    let refs: Vec<&[u8]> = bufs.iter().map(Vec::as_slice).collect();
    let (lo1, hi1) = world_aabb(&j, &refs);
    for k in 0..3 {
        assert!(
            (lo0[k] - lo1[k]).abs() < 1e-4 && (hi0[k] - hi1[k]).abs() < 1e-4,
            "multi-buffer world AABB axis {k} drifted from single GLB"
        );
    }
}

#[test]
fn multibuffer_quantized_roundtrips() {
    // Quantization + multi-buffer compose: quantized geometry split across chunks
    // still reconstructs the f32 world bounds (within mm) and stays < cap.
    let bytes = fixture_or_skip!("ara3d/duplex.ifc");
    let (glb, _) = export_glb_with_stats(&bytes, &GltfOptions::default());
    let (gj, gb) = parse_glb(&glb);
    let (lo0, hi0) = world_aabb(&gj, &[&gb]);

    let cap = 64 * 1024;
    let (j, bufs) = streaming_export(&bytes, &GltfOptions { quantize: true, ..Default::default() }, cap);
    assert!(bufs.len() >= 2);
    assert!(j["extensionsRequired"].as_array().unwrap().iter().any(|e| e == "KHR_mesh_quantization"));
    let refs: Vec<&[u8]> = bufs.iter().map(Vec::as_slice).collect();
    let (lo1, hi1) = world_aabb(&j, &refs);
    for k in 0..3 {
        assert!((lo0[k] - lo1[k]).abs() < 0.01 && (hi0[k] - hi1[k]).abs() < 0.01);
    }
}

#[test]
fn quantized_normal_compensation_survives_nonuniform_scale() {
    // The bug Greptile caught: a normal stored raw is distorted by the node's
    // non-uniform dequant scale. Verify the compensation — store `normalize(half⊙N)`,
    // and after the renderer applies `S(1/half)` (inverse-transpose of the node
    // scale) the rendered direction is the original N. Includes the 10×10×0.3 m slab.
    let cases: [([f64; 3], [f64; 3]); 3] = [
        ([5.0, 5.0, 0.15], [0.70710678, 0.0, 0.70710678]), // slab, 45° face
        ([5.0, 5.0, 0.15], [0.0, 0.0, 1.0]),               // axis-aligned (already ok)
        ([3.0, 0.2, 7.0], [0.3, 0.5, 0.81]),               // arbitrary beam-ish
    ];
    for (half, n_in) in cases {
        // normalize input
        let l = (n_in[0] * n_in[0] + n_in[1] * n_in[1] + n_in[2] * n_in[2]).sqrt();
        let n = [n_in[0] / l, n_in[1] / l, n_in[2] / l];
        // stored = normalize(half ⊙ N)  (what push_mesh_quantized writes)
        let mut s = [n[0] * half[0], n[1] * half[1], n[2] * half[2]];
        let sl = (s[0] * s[0] + s[1] * s[1] + s[2] * s[2]).sqrt();
        s = [s[0] / sl, s[1] / sl, s[2] / sl];
        // rendered = normalize(S(1/half) · stored)  (renderer's normal-matrix step)
        let mut r = [s[0] / half[0], s[1] / half[1], s[2] / half[2]];
        let rl = (r[0] * r[0] + r[1] * r[1] + r[2] * r[2]).sqrt();
        r = [r[0] / rl, r[1] / rl, r[2] / rl];
        for k in 0..3 {
            assert!(
                (r[k] - n[k]).abs() < 1e-6,
                "normal {n:?} under half {half:?} rendered {r:?}, not the original"
            );
        }
    }
}

#[test]
fn multibuffer_is_deterministic() {
    let bytes = fixture_or_skip!("ara3d/duplex.ifc");
    let opts = GltfOptions::default();
    let (j1, b1) = streaming_export(&bytes, &opts, 64 * 1024);
    let (j2, b2) = streaming_export(&bytes, &opts, 64 * 1024);
    assert_eq!(j1, j2, "multi-buffer JSON must be deterministic");
    assert_eq!(b1, b2, "multi-buffer .bin set must be deterministic");
}

#[test]
fn quantized_glb_is_structurally_valid() {
    let bytes = fixture_or_skip!("ara3d/duplex.ifc");
    let (glb, stats) = export_glb_with_stats(
        &bytes,
        &GltfOptions { quantize: true, ..Default::default() },
    );
    let (json, bin) = parse_glb(&glb);
    assert!(stats.meshes > 0);
    // Extension declared and required.
    let req = json["extensionsRequired"].as_array().expect("extensionsRequired");
    assert!(req.iter().any(|e| e == "KHR_mesh_quantization"));
    // Positions/normals are normalized SHORT; indices are u16 or u32.
    for acc in json["accessors"].as_array().unwrap() {
        let ct = acc["componentType"].as_u64().unwrap();
        if acc["type"] == "VEC3" {
            assert_eq!(ct, 5122, "VEC3 attrs must be SHORT when quantized");
            assert_eq!(acc["normalized"], Value::Bool(true));
        } else {
            assert!(ct == 5123 || ct == 5125, "indices must be u16/u32, got {ct}");
        }
    }
    // Vertex-attribute bufferViews must declare a byteStride that is a multiple of 4
    // (glTF requirement for a bufferView shared by multiple accessors). SHORT VEC3 is
    // padded to 8.
    for bv in json["bufferViews"].as_array().unwrap() {
        if let Some(stride) = bv["byteStride"].as_u64() {
            assert_eq!(stride, 8, "quantized SHORT VEC3 stride must be 8");
            assert!(stride % 4 == 0, "byteStride must be a multiple of 4");
        }
    }
    // Every accessor fits its bufferView (component sizes incl. the quantized types).
    let comp_size = |ct: u64| match ct {
        5126 | 5125 => 4,
        5122 | 5123 => 2,
        5120 | 5121 => 1,
        other => panic!("size for {other}"),
    };
    let n_per = |t: &str| if t == "VEC3" { 3 } else { 1 };
    for acc in json["accessors"].as_array().unwrap() {
        let bv = &json["bufferViews"][acc["bufferView"].as_u64().unwrap() as usize];
        let end = acc["byteOffset"].as_u64().unwrap_or(0)
            + acc["count"].as_u64().unwrap()
                * n_per(acc["type"].as_str().unwrap())
                * comp_size(acc["componentType"].as_u64().unwrap());
        assert!(end <= bv["byteLength"].as_u64().unwrap(), "accessor overruns bufferView");
    }
    assert_eq!(bin.len() as u64, json["buffers"][0]["byteLength"].as_u64().unwrap());
}

#[test]
fn quantized_glb_is_byte_deterministic() {
    let bytes = fixture_or_skip!("ara3d/duplex.ifc");
    let opts = GltfOptions { quantize: true, ..Default::default() };
    let (a, _) = export_glb_with_stats(&bytes, &opts);
    let (b, _) = export_glb_with_stats(&bytes, &opts);
    assert_eq!(a, b, "quantized GLB must be byte-deterministic");
}

#[test]
fn quantization_roundtrip_precision() {
    // Per-mesh 16-bit quantize -> dequantize keeps error within one bin (extent /
    // 65534 per axis). Synthetic 10 m mesh: error must be well under a mm.
    let mut pos = Vec::new();
    for i in 0..200u32 {
        let t = i as f32 / 199.0;
        pos.extend_from_slice(&[t * 10.0, t * 3.0, 5.0 - t * 5.0]);
    }
    let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for p in pos.chunks_exact(3) {
        for k in 0..3 {
            lo[k] = lo[k].min(p[k] as f64);
            hi[k] = hi[k].max(p[k] as f64);
        }
    }
    let center: Vec<f64> = (0..3).map(|k| (lo[k] + hi[k]) * 0.5).collect();
    let half: Vec<f64> = (0..3).map(|k| ((hi[k] - lo[k]) * 0.5).max(f64::MIN_POSITIVE)).collect();
    let mut worst = 0.0f64;
    for p in pos.chunks_exact(3) {
        for k in 0..3 {
            let n = ((p[k] as f64 - center[k]) / half[k]).clamp(-1.0, 1.0);
            let q = (n * 32767.0).round();
            let deq = q / 32767.0 * half[k] + center[k];
            worst = worst.max((deq - p[k] as f64).abs());
        }
    }
    assert!(worst < 0.001, "per-axis quant error {worst} m exceeds 1 mm on a 10 m mesh");
}

#[test]
fn duplex_exports_valid_glb() {
    let (glb, stats) =
        export_glb_with_stats(&fixture_or_skip!("ara3d/duplex.ifc"), &GltfOptions::default());
    assert!(stats.meshes > 0 && stats.triangles > 0);

    let (json, bin) = parse_glb(&glb);
    assert_eq!(json["asset"]["version"], "2.0");
    assert_eq!(json["asset"]["generator"], "IFC-Lite");
    assert_eq!(json["scene"], 0);

    let nodes = json["nodes"].as_array().unwrap();
    let meshes = json["meshes"].as_array().unwrap();
    // Instancing: one node per element OCCURRENCE + a single root that parents
    // them all. `meshes` is the DEDUPED unique-geometry count (repeated shapes
    // share one mesh), so meshes <= occurrences and json meshes == stats.meshes.
    let occurrences = nodes.len() - 1;
    assert_eq!(meshes.len(), stats.meshes, "json meshes == deduped mesh count");
    assert!(stats.meshes <= occurrences, "unique meshes <= occurrences");

    // Scene has exactly one top-level node: the root. It carries the model
    // centre translation and parents every occurrence node.
    let scene_nodes = json["scenes"][0]["nodes"].as_array().unwrap();
    assert_eq!(scene_nodes.len(), 1, "single root node");
    let root_idx = scene_nodes[0].as_u64().unwrap() as usize;
    let root = &nodes[root_idx];
    assert!(root.get("mesh").is_none(), "root is a transform node, no mesh");
    assert_eq!(
        root["children"].as_array().unwrap().len(),
        occurrences,
        "root parents every occurrence node"
    );
    // Every non-root node references a mesh. An element node is one of:
    //   - flat singleton: placement baked into vertices, no transform;
    //   - flat content-hash share: a node TRANSLATION places the shared mesh;
    //   - rep-instanced: a node MATRIX places the shared template.
    // glTF forbids both `matrix` and `translation` on one node — assert that.
    let mut instanced_nodes = 0usize;
    for (i, n) in nodes.iter().enumerate() {
        if i != root_idx {
            assert!(n["mesh"].is_number(), "element nodes reference a mesh");
            assert!(
                !(n.get("matrix").is_some() && n.get("translation").is_some()),
                "a node never carries both matrix and translation"
            );
            if let Some(m) = n.get("matrix") {
                assert_eq!(m.as_array().unwrap().len(), 16, "node matrix is a 4x4");
                instanced_nodes += 1;
            }
        }
    }
    // duplex repeats geometry, so instancing must have fired: fewer unique meshes
    // than occurrences AND at least one occurrence placed via a node matrix.
    assert!(stats.meshes < occurrences, "duplex repeats geometry -> dedup fired");
    assert!(instanced_nodes > 0, "shared templates are placed via node matrix");

    // Materials present + LIT by default (#1321: no KHR_materials_unlit) +
    // double-sided.
    assert!(!json["materials"].as_array().unwrap().is_empty());
    assert!(
        json.get("extensionsUsed").is_none(),
        "lit by default: no extensionsUsed / unlit extension"
    );
    assert!(
        json["materials"].as_array().unwrap().iter().all(|m| m.get("extensions").is_none()),
        "lit materials carry no extensions"
    );
    assert!(
        json["materials"].as_array().unwrap().iter().all(|m| m["doubleSided"] == true),
        "materials double-sided (IFC winding isn't reliably outward)"
    );

    // Every accessor must fit inside its bufferView (validator-critical).
    let bvs = json["bufferViews"].as_array().unwrap();
    for acc in json["accessors"].as_array().unwrap() {
        let bv = &bvs[acc["bufferView"].as_u64().unwrap() as usize];
        let comp = match acc["componentType"].as_u64().unwrap() {
            5126 | 5125 => 4,
            5123 => 2,
            other => panic!("unexpected componentType {other}"),
        };
        let per = match acc["type"].as_str().unwrap() {
            "VEC3" => 3,
            "SCALAR" => 1,
            other => panic!("unexpected type {other}"),
        };
        let len = acc["count"].as_u64().unwrap() * per * comp;
        let end = acc["byteOffset"].as_u64().unwrap() + len;
        assert!(end <= bv["byteLength"].as_u64().unwrap(), "accessor overruns bufferView");
    }

    // Binary buffer length matches the declared buffer.
    assert_eq!(bin.len(), json["buffers"][0]["byteLength"].as_u64().unwrap() as usize);
}

#[test]
fn from_meshes_glb_preserves_source_welded_vertices() {
    // The faceted-brep per-face vertex duplication is now welded at the mesh
    // SOURCE (`ifc_lite_processing::element::build_mesh_data`), so the
    // viewer's `MeshData` reaches `export_glb_from_meshes` already welded and
    // this path must NOT re-weld — it is a faithful pass-through. Feed a
    // PRE-WELDED GxG plate (unique grid points, shared indices) and assert
    // the export preserves its vertex count and extent exactly. The
    // per-face-duplicated form and its collapse are covered at the source
    // (processing `source_vertex_weld` + geometry `mesh_weld` unit tests).
    const G: usize = 4;
    // (G+1)^2 unique grid vertices, all +Z.
    let mut positions: Vec<f32> = Vec::new();
    let mut normals: Vec<f32> = Vec::new();
    for x in 0..=G {
        for y in 0..=G {
            positions.extend_from_slice(&[x as f32, y as f32, 0.0]);
            normals.extend_from_slice(&[0.0, 0.0, 1.0]);
        }
    }
    let welded_verts = (G + 1) * (G + 1); // 25
    assert_eq!(positions.len() / 3, welded_verts);
    // Two triangles per cell, indexing the shared grid vertices.
    let vid = |x: usize, y: usize| (x * (G + 1) + y) as u32;
    let mut indices: Vec<u32> = Vec::new();
    for x in 0..G {
        for y in 0..G {
            let (a, b, c, d) = (vid(x, y), vid(x + 1, y), vid(x + 1, y + 1), vid(x, y + 1));
            indices.extend_from_slice(&[a, b, c, a, c, d]);
        }
    }

    let (glb, stats) = export_glb_from_meshes(
        &positions,
        &normals,
        &indices,
        &[welded_verts as u32],
        &[indices.len() as u32],
        &[0.5, 0.5, 0.5, 1.0],
        &[0.0, 0.0, 0.0],
        &[1u32],
        true,
        false,
        false, // emissive off (#1427 added the emissive param)
    );
    assert_eq!(stats.triangles, 2 * G * G, "triangles unchanged");

    let (json, _bin) = parse_glb(&glb);
    let pos_acc = json["accessors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["type"] == "VEC3" && a["min"].is_array())
        .expect("position accessor");
    let pos_count = pos_acc["count"].as_u64().unwrap() as usize;
    assert_eq!(
        pos_count, welded_verts,
        "pre-welded source vertices pass through unchanged (no export re-weld / inflation)"
    );

    // World extent preserved: the plate is still GxG and flat (one axis span
    // is 0, the other two are G), regardless of the Y-up axis order.
    let mn: Vec<f64> = pos_acc["min"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
    let mx: Vec<f64> = pos_acc["max"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
    let mut spans: Vec<f64> = (0..3).map(|i| mx[i] - mn[i]).collect();
    spans.sort_by(|a, b| a.partial_cmp(b).unwrap());
    assert!(
        spans[0].abs() < 1e-4 && (spans[1] - G as f64).abs() < 1e-4 && (spans[2] - G as f64).abs() < 1e-4,
        "welded plate keeps its GxG flat extent (spans {spans:?})"
    );
}

#[test]
fn from_meshes_assembles_valid_glb() {
    // Two meshes (a quad each) supplied as already-produced buffers — no re-meshing.
    // Mesh 0: unit quad at origin; Mesh 1: same quad with a non-zero RTC origin.
    let positions: Vec<f32> = vec![
        0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, // mesh 0
        0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, // mesh 1
    ];
    let normals: Vec<f32> = std::iter::repeat_n([0.0f32, 0.0, 1.0], 8).flatten().collect();
    let indices: Vec<u32> = vec![0, 1, 2, 0, 2, 3, 0, 1, 2, 0, 2, 3];
    let vertex_counts = vec![4u32, 4];
    let index_counts = vec![6u32, 6];
    let colors = vec![1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.5]; // red opaque, green translucent
    let origins = vec![0.0, 0.0, 0.0, 1000.0, 2000.0, 3000.0]; // mesh 1 has RTC offset
    let express_ids = vec![10u32, 20];

    let (glb, stats) = export_glb_from_meshes(
        &positions, &normals, &indices, &vertex_counts, &index_counts, &colors, &origins,
        &express_ids, true, true, false,
    );
    assert_eq!(stats.meshes, 2);
    assert_eq!(stats.triangles, 4);
    assert_eq!(stats.materials, 2, "two distinct colors → two materials");

    let (json, bin) = parse_glb(&glb);
    assert_eq!(json["asset"]["generator"], "IFC-Lite");
    let nodes = json["nodes"].as_array().unwrap();
    // 2 element nodes + 1 root.
    assert_eq!(nodes.len(), 3);

    // Exactly ONE node carries a translation — the single root. Per-element
    // node.translation (the "all centre aligned" failure mode) is gone.
    let translated: Vec<&Value> =
        nodes.iter().filter(|n| n.get("translation").is_some()).collect();
    assert_eq!(translated.len(), 1, "only the root node is translated");
    let scene_nodes = json["scenes"][0]["nodes"].as_array().unwrap();
    assert_eq!(scene_nodes.len(), 1);
    let root = &nodes[scene_nodes[0].as_u64().unwrap() as usize];
    let root_t = root["translation"].as_array().unwrap();
    let center = [
        root_t[0].as_f64().unwrap(),
        root_t[1].as_f64().unwrap(),
        root_t[2].as_f64().unwrap(),
    ];

    // SELF-CONTAINED placement: the two quads are ~3000 apart in mesh 1's farthest
    // axis. Their baked (translation-dropped) accessor bounds must preserve that
    // separation — i.e. dropping the root translation does NOT collapse them onto
    // each other (which is exactly what per-element node.translation did wrong).
    let accs = json["accessors"].as_array().unwrap();
    let mut bmin = [f64::INFINITY; 3];
    let mut bmax = [f64::NEG_INFINITY; 3];
    for mesh in json["meshes"].as_array().unwrap() {
        let pa = mesh["primitives"][0]["attributes"]["POSITION"].as_u64().unwrap() as usize;
        for k in 0..3 {
            let lo = accs[pa]["min"][k].as_f64().unwrap();
            let hi = accs[pa]["max"][k].as_f64().unwrap();
            if lo < bmin[k] { bmin[k] = lo; }
            if hi > bmax[k] { bmax[k] = hi; }
        }
    }
    assert!(
        (bmax[2] - bmin[2]) > 2999.0,
        "baked geometry retains the ~3000 element separation (no centre-collapse): got {}",
        bmax[2] - bmin[2]
    );

    // World reconstruction: root.translation + baked bounds recover the true AABB
    // (~[0,0,0]..[1001,2001,3000]).
    for k in 0..3 {
        let wmax = center[k] + bmax[k];
        let wmin = center[k] + bmin[k];
        assert!(wmin.abs() < 1.0, "world min ~0 on axis {k}: {wmin}");
        let expect = [1001.0, 2001.0, 3000.0][k];
        assert!((wmax - expect).abs() < 1.0, "world max ~{expect} on axis {k}: {wmax}");
    }

    // Translucent material → BLEND.
    assert!(json["materials"].as_array().unwrap().iter().any(|m| m["alphaMode"] == "BLEND"));
    assert_eq!(bin.len(), json["buffers"][0]["byteLength"].as_u64().unwrap() as usize);

    // Lit (the call above passed lit = true): no unlit extension anywhere.
    assert!(json.get("extensionsUsed").is_none(), "lit export omits extensionsUsed");
    assert!(
        json["materials"].as_array().unwrap().iter().all(|m| m.get("extensions").is_none()),
        "lit materials carry no extensions"
    );
}

#[test]
fn try_from_meshes_matches_infallible_on_valid_input() {
    // A single unit quad supplied as flat buffers. The fail-closed variant must
    // return byte-for-byte the same GLB as the infallible one when counts are valid.
    let positions: Vec<f32> = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0];
    let normals: Vec<f32> = vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
    let indices: Vec<u32> = vec![0, 1, 2, 0, 2, 3];
    let (vc, ic) = (vec![4u32], vec![6u32]);
    let color = vec![0.5, 0.5, 0.5, 1.0];
    let origin = vec![0.0, 0.0, 0.0];
    let ids = vec![1u32];
    let (want, _) = export_glb_from_meshes(
        &positions, &normals, &indices, &vc, &ic, &color, &origin, &ids, false, true, false,
    );
    let (got, _) = try_export_glb_from_meshes(
        &positions, &normals, &indices, &vc, &ic, &color, &origin, &ids, false, true, false,
    )
    .expect("valid counts must not be MalformedMeshInput");
    assert_eq!(want, got, "try_ path equals infallible path on valid input");
}

#[test]
fn try_from_meshes_rejects_counts_past_buffers() {
    // Buffers hold one quad (4 verts / 6 indices) but the counts claim two meshes —
    // the second runs past the end. The infallible path silently drops it (returns
    // only the valid prefix); the fail-closed path must reject.
    let positions: Vec<f32> = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0];
    let normals: Vec<f32> = vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
    let indices: Vec<u32> = vec![0, 1, 2, 0, 2, 3];
    // Two meshes of 4 verts each, but only 4 verts of positions exist.
    let (vc, ic) = (vec![4u32, 4u32], vec![6u32, 6u32]);
    let color = vec![0.5, 0.5, 0.5, 1.0, 0.5, 0.5, 0.5, 1.0];
    let origin = vec![0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
    let ids = vec![1u32, 2u32];

    // Infallible: silently truncates to the first (valid) mesh — the data-loss bug.
    let (_, stats) = export_glb_from_meshes(
        &positions, &normals, &indices, &vc, &ic, &color, &origin, &ids, false, true, false,
    );
    assert_eq!(stats.meshes, 1, "infallible path drops the un-backed second mesh silently");

    // Fail-closed: surfaces it as a typed error the caller can act on.
    let err = try_export_glb_from_meshes(
        &positions, &normals, &indices, &vc, &ic, &color, &origin, &ids, false, true, false,
    )
    .expect_err("counts past the buffers must be MalformedMeshInput");
    assert!(matches!(err, ExportError::MalformedMeshInput { .. }), "got {err:?}");
    assert_eq!(err.code(), "MALFORMED_MESH_INPUT");
}

#[test]
fn try_from_meshes_rejects_short_normals() {
    // One quad (4 verts) needs 12 normal floats, but only 6 are supplied — the
    // under-covered mesh would fall back to an empty normal slice and vanish.
    let positions: Vec<f32> = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0];
    let normals: Vec<f32> = vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0]; // short of vsum*3 = 12
    let indices: Vec<u32> = vec![0, 1, 2, 0, 2, 3];
    let (vc, ic) = (vec![4u32], vec![6u32]);
    let color = vec![0.5, 0.5, 0.5, 1.0];
    let origin = vec![0.0, 0.0, 0.0];
    let ids = vec![1u32];
    let err = try_export_glb_from_meshes(
        &positions, &normals, &indices, &vc, &ic, &color, &origin, &ids, false, true, false,
    )
    .expect_err("short normals must be MalformedMeshInput");
    assert!(matches!(err, ExportError::MalformedMeshInput { .. }), "got {err:?}");

    // Empty normals is the degenerate case that would drop the WHOLE model.
    let err_empty = try_export_glb_from_meshes(
        &positions, &[], &indices, &vc, &ic, &color, &origin, &ids, false, true, false,
    )
    .expect_err("empty normals must be MalformedMeshInput");
    assert!(matches!(err_empty, ExportError::MalformedMeshInput { .. }), "got {err_empty:?}");
}

#[test]
fn try_from_meshes_rejects_index_counts_past_buffer() {
    // `index_counts` declares more indices than `indices` holds — the overrun the
    // infallible path's per-mesh `break` would silently truncate at.
    let positions: Vec<f32> = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0];
    let normals: Vec<f32> = vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
    let indices: Vec<u32> = vec![0, 1, 2, 0, 2, 3];
    let (vc, ic) = (vec![4u32], vec![12u32]); // 12 > indices.len() == 6
    let color = vec![0.5, 0.5, 0.5, 1.0];
    let origin = vec![0.0, 0.0, 0.0];
    let ids = vec![1u32];
    let err = try_export_glb_from_meshes(
        &positions, &normals, &indices, &vc, &ic, &color, &origin, &ids, false, true, false,
    )
    .expect_err("index_counts past `indices` must be MalformedMeshInput");
    assert!(matches!(err, ExportError::MalformedMeshInput { .. }), "got {err:?}");
}

#[test]
fn try_from_meshes_rejects_empty_input() {
    // Zero meshes (e.g. a viewer selection whose visible set filtered to
    // nothing) passes every per-count-consistency check trivially — vsum=0,
    // isum=0, index_counts.len() 0 >= n 0 — so the checked path fell through
    // to the infallible assembler and returned Ok with a "successful" GLB.
    //
    // glTF-Validator (npm `gltf-validator`, the reference implementation)
    // rejects that GLB outright: `accessors`/`bufferViews`/`meshes`/`nodes`
    // are EMPTY_ENTITY (glTF schema requires each `minItems: 1` when
    // present) and `buffers[0].byteLength` is 0 (schema `minimum: 1`).
    // `try_export_glb` (the from-bytes sibling, #1438/#1516) already fails
    // closed on an empty visible-mesh set with `ExportError::NoRenderGeometry`
    // for exactly this reason; this from-meshes entry point — reachable from
    // the viewer's `exportGlbFromMeshes` — did not.
    let err = try_export_glb_from_meshes(&[], &[], &[], &[], &[], &[], &[], &[], false, true, false)
        .expect_err("zero meshes must be NoRenderGeometry, not a spec-invalid empty GLB");
    assert!(matches!(err, ExportError::NoRenderGeometry), "got {err:?}");
    assert_eq!(err.code(), "NO_RENDER_GEOMETRY");
}

#[test]
fn export_is_byte_deterministic() {
    // Instancing groups by HashMap keys (rep colour buckets, material dedup);
    // emission order must be fixed so repeated exports are byte-identical.
    let content = fixture_or_skip!("ara3d/C20-Institute-Var-2.ifc");
    let a = export_glb(&content, &GltfOptions { include_metadata: true, ..Default::default() });
    let b = export_glb(&content, &GltfOptions { include_metadata: true, ..Default::default() });
    assert_eq!(a, b, "repeated GLB exports must be byte-identical");
}

#[test]
fn nodes_carry_global_id_and_model_id() {
    // From-bytes export with metadata + a model id: every element node carries
    // `modelId`, and elements with an IFC GlobalId carry `GlobalId`.
    let content = fixture_or_skip!("ara3d/duplex.ifc");
    let opts = GltfOptions {
        include_metadata: true,
        model_id: Some("model-42".to_string()),
        ..GltfOptions::default()
    };
    let (glb, _stats) = export_glb_with_stats(&content, &opts);
    let (json, _bin) = parse_glb(&glb);
    let nodes = json["nodes"].as_array().unwrap();

    let mut saw_global = false;
    let mut element_nodes = 0;
    for n in nodes {
        let Some(extras) = n.get("extras") else { continue };
        if extras.get("expressId").is_none() {
            continue; // structural node (e.g. root), not an element
        }
        element_nodes += 1;
        assert_eq!(
            extras["modelId"].as_str(),
            Some("model-42"),
            "every element node carries the model id"
        );
        if let Some(g) = extras.get("GlobalId").and_then(|v| v.as_str()) {
            assert!(!g.is_empty(), "GlobalId is non-empty when present");
            saw_global = true;
        }
    }
    assert!(element_nodes > 0, "expected element nodes with metadata");
    assert!(saw_global, "at least one node carries an IFC GlobalId");

    // Without a model id, no `modelId` key is emitted.
    let plain = GltfOptions { include_metadata: true, ..GltfOptions::default() };
    let (glb2, _) = export_glb_with_stats(&content, &plain);
    let (json2, _) = parse_glb(&glb2);
    for n in json2["nodes"].as_array().unwrap() {
        if let Some(extras) = n.get("extras") {
            assert!(extras.get("modelId").is_none(), "no modelId without a model id");
        }
    }
}

/// #1496 regression — the join contract: every meshed GLB node's `expressId`
/// must resolve to an export-model row, so a viewer can always look up
/// attributes on pick. The whole legacy-entity class (`IfcProxy`,
/// `IfcSolidStratum`, and the common IFC2x3 `*StandardCase`/`*ElementedCase`
/// entities) used to render *without* a row: the geometry pass meshes them via
/// the legacy table, but the attribute pass tested a bare `from_str`
/// (→ `Unknown`) against `IfcProduct`. Both now use `legacy_aware_ifc_type`.
/// These fixtures cover the proxy + geoscience cases; the mechanism generalises
/// to every legacy product. (Type-only geometry — `IfcBoilerType` in the
/// tessellation-with-*-texture fixtures — is a separate, harder case tracked as
/// a follow-up and intentionally NOT covered here.)
#[test]
fn glb_nodes_have_export_rows_for_legacy_products() {
    let mut found = 0;
    for rel in [
        "ifcopenshell/1030-sphere.ifc",
        "ifcopenshell/1032-curve.ifc",
        "issues/860_solid_stratum.ifc",
    ] {
        let Some(content) = crate::test_support::fixture_opt(rel) else { continue };
        found += 1;
        let opts = GltfOptions {
            include_metadata: true,
            ..GltfOptions::default()
        };
        let (glb, _stats) = export_glb_with_stats(&content, &opts);
        let (json, _bin) = parse_glb(&glb);
        let rows: std::collections::HashSet<u32> = crate::model::build_export_model(&content)
            .entities
            .iter()
            .map(|e| e.express_id)
            .collect();
        let mut checked = 0;
        for n in json["nodes"].as_array().unwrap() {
            let Some(extras) = n.get("extras") else { continue };
            let Some(eid) = extras.get("expressId").and_then(|v| v.as_u64()) else {
                continue;
            };
            checked += 1;
            assert!(
                rows.contains(&(eid as u32)),
                "{rel}: GLB node expressId {eid} (ifcType {:?}) has no export-model row (#1496)",
                extras.get("ifcType")
            );
        }
        assert!(checked > 0, "{rel}: expected at least one meshed element node");
    }
    // Per the fixture_opt house rule the test is green when the corpus isn't
    // fetched — but say so, so a silent zero-coverage run (Greptile #1511) is
    // visible rather than masquerading as a real pass. CI fetches the corpus,
    // so `found` is 3 there and the join contract is actually exercised.
    if found == 0 {
        eprintln!(
            "skipping glb_nodes_have_export_rows: no legacy fixtures fetched \
             (run `pnpm fixtures`)"
        );
    }
}

#[test]
fn instanced_occurrences_reconstruct_world_positions() {
    // Decisive precision round-trip on a REAL repetitive model: every instanced
    // occurrence must reconstruct its true baked world geometry via
    //   world = root.translation + node.matrix · template_local_vertex
    // matching `process_geometry`'s per-occurrence baked Y-up world (origin +
    // position). This exercises the full chain — rep-identity grouping, the
    // Z-up→Y-up conjugation, scene-center folding, and the f32 node matrix — on
    // genuinely rotated, placed occurrences, so any frame/RTC error surfaces.
    let content = fixture_or_skip!("ara3d/C20-Institute-Var-2.ifc");
    let opts = GltfOptions { include_metadata: true, ..GltfOptions::default() };
    let (glb, _stats) = export_glb_with_stats(&content, &opts);
    let (json, bin) = parse_glb(&glb);

    // Truth: express id -> the occurrence's baked Y-up world vertices.
    let result = process_geometry(&content[..]);
    let default_opts = GltfOptions::default();
    let mut truth: HashMap<u32, Vec<[f64; 3]>> = HashMap::new();
    let mut dup_ids: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let mut yscratch = crate::frame::YUpScratch::new();
    for m in &result.meshes {
        if !super::mesh_visible(m, &default_opts) || m.positions.len() < 9 {
            continue;
        }
        crate::frame::to_yup_into(&mut yscratch, &m.positions, &m.normals, &m.indices, m.origin);
        let y = &yscratch;
        let verts: Vec<[f64; 3]> = y
            .positions
            .chunks_exact(3)
            .map(|c| {
                [
                    c[0] as f64 + y.origin[0],
                    c[1] as f64 + y.origin[1],
                    c[2] as f64 + y.origin[2],
                ]
            })
            .collect();
        // An express id with >1 visible mesh (submeshes) is ambiguous to match
        // 1:1 against a single template, so exclude it from the check.
        if truth.insert(m.express_id, verts).is_some() {
            dup_ids.insert(m.express_id);
        }
    }

    let nodes = json["nodes"].as_array().unwrap();
    let accs = json["accessors"].as_array().unwrap();
    let bviews = json["bufferViews"].as_array().unwrap();
    let meshes_j = json["meshes"].as_array().unwrap();
    let scene_nodes = json["scenes"][0]["nodes"].as_array().unwrap();
    let root = &nodes[scene_nodes[0].as_u64().unwrap() as usize];
    let root_t = root
        .get("translation")
        .map(|v| {
            let a = v.as_array().unwrap();
            [a[0].as_f64().unwrap(), a[1].as_f64().unwrap(), a[2].as_f64().unwrap()]
        })
        .unwrap_or([0.0; 3]);

    // Read a mesh's POSITION accessor floats straight out of the BIN chunk.
    let read_positions = |mesh_idx: usize| -> Vec<[f32; 3]> {
        let pa = meshes_j[mesh_idx]["primitives"][0]["attributes"]["POSITION"]
            .as_u64()
            .unwrap() as usize;
        let acc = &accs[pa];
        let count = acc["count"].as_u64().unwrap() as usize;
        let bv = &bviews[acc["bufferView"].as_u64().unwrap() as usize];
        let base = bv["byteOffset"].as_u64().unwrap() as usize
            + acc["byteOffset"].as_u64().unwrap() as usize;
        (0..count)
            .map(|i| {
                let o = base + i * 12;
                [
                    f32::from_le_bytes(bin[o..o + 4].try_into().unwrap()),
                    f32::from_le_bytes(bin[o + 4..o + 8].try_into().unwrap()),
                    f32::from_le_bytes(bin[o + 8..o + 12].try_into().unwrap()),
                ]
            })
            .collect()
    };

    let mut checked = 0usize;
    let mut max_err = 0.0f64;
    for child in root["children"].as_array().unwrap() {
        let node = &nodes[child.as_u64().unwrap() as usize];
        // Instanced occurrences carry a node matrix; flat ones do not.
        let Some(mv) = node.get("matrix") else { continue };
        let express = node["extras"]["expressId"].as_u64().unwrap() as u32;
        if dup_ids.contains(&express) {
            continue;
        }
        let Some(truth_verts) = truth.get(&express) else { continue };
        let locals = read_positions(node["mesh"].as_u64().unwrap() as usize);
        if locals.len() != truth_verts.len() {
            continue;
        }
        // Column-major 4x4: element (row r, col c) = m[c*4 + r].
        let m: Vec<f64> = mv.as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect();
        for (lv, t) in locals.iter().zip(truth_verts) {
            let (lx, ly, lz) = (lv[0] as f64, lv[1] as f64, lv[2] as f64);
            let world = [
                root_t[0] + m[0] * lx + m[4] * ly + m[8] * lz + m[12],
                root_t[1] + m[1] * lx + m[5] * ly + m[9] * lz + m[13],
                root_t[2] + m[2] * lx + m[6] * ly + m[10] * lz + m[14],
            ];
            for k in 0..3 {
                max_err = max_err.max((world[k] - t[k]).abs());
            }
        }
        checked += 1;
    }
    assert!(checked > 50, "expected many instanced occurrences to verify, got {checked}");
    // f32 vertex/matrix precision at building scale: well under a millimetre.
    assert!(max_err < 1e-3, "instanced world reconstruction error {max_err} m too large");
}

#[test]
fn unlit_option_emits_khr_materials_unlit() {
    // #1321: lit = false reproduces the historical flat material — every
    // material tagged KHR_materials_unlit and the extension declared globally.
    let positions: Vec<f32> = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0];
    let normals: Vec<f32> = std::iter::repeat_n([0.0f32, 0.0, 1.0], 4).flatten().collect();
    let indices: Vec<u32> = vec![0, 1, 2, 0, 2, 3];
    let (glb, _) = export_glb_from_meshes(
        &positions,
        &normals,
        &indices,
        &[4],
        &[6],
        &[0.5, 0.5, 0.5, 1.0],
        &[0.0, 0.0, 0.0],
        &[10],
        false,
        false, // lit = false ⇒ unlit
        false, // emissive off
    );
    let (json, _) = parse_glb(&glb);
    assert_eq!(json["extensionsUsed"][0], "KHR_materials_unlit");
    assert!(
        json["materials"].as_array().unwrap().iter().all(|m| m["extensions"]
            ["KHR_materials_unlit"]
            .is_object()),
        "unlit materials carry the KHR_materials_unlit extension"
    );
}

#[test]
fn emissive_option_sets_emissive_factor_to_base_colour() {
    // #1427: emissive = true self-illuminates every material at its base colour
    // so Google Earth (no ambient/IBL, hard sun) shows the true colour instead of
    // a near-black shaded surface. emissiveFactor is core glTF 2.0 — no extension.
    let positions: Vec<f32> = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0];
    let normals: Vec<f32> = std::iter::repeat_n([0.0f32, 0.0, 1.0], 4).flatten().collect();
    let indices: Vec<u32> = vec![0, 1, 2, 0, 2, 3];
    let (glb, _) = export_glb_from_meshes(
        &positions,
        &normals,
        &indices,
        &[4],
        &[6],
        &[0.25, 0.5, 0.75, 1.0],
        &[0.0, 0.0, 0.0],
        &[10],
        true, // include_metadata
        true, // lit (no unlit extension — mutually exclusive with emissive)
        true, // emissive on
    );
    let (json, _) = parse_glb(&glb);
    let mats = json["materials"].as_array().unwrap();
    // emissiveFactor == base colour RGB; base colour is preserved (safe fallback).
    let m = &mats[0];
    let ef = m["emissiveFactor"].as_array().unwrap();
    assert!((ef[0].as_f64().unwrap() - 0.25).abs() < 1e-6);
    assert!((ef[1].as_f64().unwrap() - 0.5).abs() < 1e-6);
    assert!((ef[2].as_f64().unwrap() - 0.75).abs() < 1e-6);
    let bc = m["pbrMetallicRoughness"]["baseColorFactor"].as_array().unwrap();
    assert!((bc[0].as_f64().unwrap() - 0.25).abs() < 1e-6, "base colour kept (no regression)");
    // emissive is core glTF: no extension is declared for it.
    assert!(json.get("extensionsUsed").is_none(), "emissive needs no extension");
}

#[test]
fn emissive_takes_precedence_over_unlit() {
    // #1427: emissive and KHR_materials_unlit are mutually exclusive (the unlit
    // spec mandates emissiveFactor = 0). If a caller asks for BOTH (lit = false
    // AND emissive = true), emissive must win — never emit a material that
    // declares unlit alongside a non-zero emissiveFactor (a spec violation).
    let positions: Vec<f32> = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0];
    let normals: Vec<f32> = std::iter::repeat_n([0.0f32, 0.0, 1.0], 4).flatten().collect();
    let indices: Vec<u32> = vec![0, 1, 2, 0, 2, 3];
    let (glb, _) = export_glb_from_meshes(
        &positions,
        &normals,
        &indices,
        &[4],
        &[6],
        &[0.5, 0.5, 0.5, 1.0],
        &[0.0, 0.0, 0.0],
        &[10],
        false,
        false, // lit = false (would normally request unlit)…
        true,  // …but emissive = true wins.
    );
    let (json, _) = parse_glb(&glb);
    assert!(json.get("extensionsUsed").is_none(), "emissive suppresses the unlit extension");
    assert!(
        json["materials"].as_array().unwrap().iter().all(|m| m.get("extensions").is_none()),
        "no material carries KHR_materials_unlit when emissive is on"
    );
    assert!(
        json["materials"].as_array().unwrap().iter().all(|m| m["emissiveFactor"].is_array()),
        "materials carry emissiveFactor"
    );
}

#[test]
fn metadata_and_isolation() {
    let with_meta = export_glb_with_stats(
        &fixture_or_skip!("ara3d/duplex.ifc"),
        &GltfOptions { include_metadata: true, ..GltfOptions::default() },
    )
    .0;
    let (json, _) = parse_glb(&with_meta);
    assert!(json["asset"]["extras"]["meshCount"].as_u64().unwrap() >= 1);
    assert!(json["nodes"][0]["extras"]["expressId"].is_number());

    // Isolate one id ⇒ fewer or equal meshes than the full export.
    let full = export_glb_with_stats(&fixture_or_skip!("ara3d/duplex.ifc"), &GltfOptions::default()).1;
    let some_id = process_geometry(&fixture_or_skip!("ara3d/duplex.ifc")[..])
        .meshes
        .iter()
        .find(|m| super::mesh_visible(m, &GltfOptions::default()))
        .map(|m| m.express_id)
        .unwrap();
    let iso = export_glb_with_stats(
        &fixture_or_skip!("ara3d/duplex.ifc"),
        &GltfOptions { isolated: vec![some_id], ..GltfOptions::default() },
    )
    .1;
    assert!(iso.meshes >= 1 && iso.meshes <= full.meshes);
}

/// A minimal but valid triangulated mesh (one triangle, matching normals),
/// so `mesh_visible`'s geometry-sanity checks pass and only the filter under
/// test can flip the result.
fn synthetic_mesh(express_id: u32, ifc_type: &str) -> MeshData {
    MeshData::new(
        express_id,
        ifc_type.to_string(),
        vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
        vec![0, 1, 2],
        [1.0, 0.0, 0.0, 1.0],
    )
}

#[test]
fn mesh_visible_hidden_excludes_only_the_listed_express_id() {
    // `hidden` is the per-element hide list (viewer "hide selection"): only the
    // express ids it names must be dropped, everything else stays visible.
    let hidden_mesh = synthetic_mesh(42, "IfcWall");
    let other_mesh = synthetic_mesh(43, "IfcWall");
    let opts = GltfOptions { hidden: vec![42], ..GltfOptions::default() };
    assert!(!mesh_visible(&hidden_mesh, &opts), "express id 42 is in `hidden` and must be excluded");
    assert!(mesh_visible(&other_mesh, &opts), "express id 43 is not in `hidden` and must stay visible");

    // With an empty hidden list both are visible again (no accidental default-hide).
    let none_hidden = GltfOptions::default();
    assert!(mesh_visible(&hidden_mesh, &none_hidden));
    assert!(mesh_visible(&other_mesh, &none_hidden));
}

#[test]
fn mesh_visible_hidden_types_excludes_the_whole_class() {
    // `hidden_types` is the class-level visibility toggle (viewer "hide IfcWall"):
    // every mesh of a hidden IFC type is dropped regardless of express id, and
    // meshes of other types are unaffected.
    let wall = synthetic_mesh(1, "IfcWall");
    let slab = synthetic_mesh(2, "IfcSlab");
    let opts = GltfOptions { hidden_types: vec!["IfcWall".to_string()], ..GltfOptions::default() };
    assert!(!mesh_visible(&wall, &opts), "IfcWall is in `hidden_types` and must be excluded");
    assert!(mesh_visible(&slab, &opts), "IfcSlab is not in `hidden_types` and must stay visible");

    // A different express id of the same hidden type is still excluded (the
    // filter is class-level, not per-instance).
    let another_wall = synthetic_mesh(3, "IfcWall");
    assert!(!mesh_visible(&another_wall, &opts));
}

/// A structurally valid IFC with zero products (no render geometry).
const GEOMETRYLESS_IFC: &str = "ISO-10303-21;\n\
HEADER;\n\
FILE_DESCRIPTION((''),'2;1');\n\
FILE_NAME('empty.ifc','2026-01-01T00:00:00',(''),(''),'','','');\n\
FILE_SCHEMA(('IFC4'));\n\
ENDSEC;\n\
DATA;\n\
#1=IFCPROJECT('0000000000000000000001',$,'Empty',$,$,$,$,$,#2);\n\
#2=IFCUNITASSIGNMENT((#3));\n\
#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n\
ENDSEC;\n\
END-ISO-10303-21;\n";

#[test]
fn try_export_glb_fails_closed_on_geometryless_model() {
    let err = try_export_glb(GEOMETRYLESS_IFC.as_bytes(), &GltfOptions::default())
        .expect_err("a zero-mesh export must be an error, not a valid empty GLB");
    assert_eq!(err, ExportError::NoRenderGeometry);
    assert_eq!(err.code(), "NO_RENDER_GEOMETRY");
    // The fail-open path still exists for callers that explicitly want it.
    let (glb, stats) = export_glb_with_stats(GEOMETRYLESS_IFC.as_bytes(), &GltfOptions::default());
    assert_eq!(stats.meshes, 0);
    let (json, _) = parse_glb(&glb);
    assert!(json["meshes"].as_array().is_none_or(|m| m.is_empty()));
}

/// The #1516 TooLarge variant carries the projected size and a stable code the
/// wasm/TS boundary can match on (mirroring NO_RENDER_GEOMETRY).
#[test]
fn too_large_error_code_and_message() {
    let err = ExportError::TooLarge { bytes: 5_000_000_000 };
    assert_eq!(err.code(), "TOO_LARGE");
    assert!(err.to_string().contains("5000000000"), "message carries the byte size");
    assert!(err.to_string().starts_with("TOO_LARGE"), "code prefixes the message");
}

#[test]
fn try_export_glb_matches_fail_open_path_when_nonempty() {
    let Some(content) = crate::test_support::fixture_opt("ifcopenshell/1019-column.ifc") else { return };
    let (glb, stats) =
        try_export_glb_with_stats(&content, &GltfOptions::default()).expect("has geometry");
    assert!(stats.meshes >= 1);
    let (baseline, _) = export_glb_with_stats(&content, &GltfOptions::default());
    assert_eq!(glb, baseline, "try_ path must be byte-identical to export_glb");
}

/// Sum of world triangles: every node instance of a mesh counts its index
/// accessor, so dedup/instancing differences between assemblers cancel out.
fn world_triangles(json: &Value) -> u64 {
    let empty = vec![];
    let nodes = json["nodes"].as_array().unwrap_or(&empty);
    let mut tris = 0u64;
    for node in nodes {
        let Some(mi) = node["mesh"].as_u64() else { continue };
        let prim = &json["meshes"][mi as usize]["primitives"][0];
        let ai = prim["indices"].as_u64().expect("indices accessor") as usize;
        tris += json["accessors"][ai]["count"].as_u64().expect("count") / 3;
    }
    tris
}

#[test]
fn streaming_bounded_is_byte_identical_on_flat_models() {
    // Models with no instanceable groups exercise exactly the code the two
    // assemblers share (flat emission + content dedup); their output must be
    // byte-for-byte identical, JSON and BIN.
    for rel in ["ifcopenshell/1019-column.ifc", "ifcopenshell/1030-sphere.ifc"] {
        let Some(content) = crate::test_support::fixture_opt(rel) else { continue };
        let opts = GltfOptions { include_metadata: true, ..GltfOptions::default() };
        let (in_memory, mem_stats) = export_glb_from_result(process_geometry(&content), &opts);
        let (streamed, stream_stats) = export_glb_streaming_bounded(&content, &opts);
        assert_eq!(mem_stats.meshes, stream_stats.meshes, "{rel}: mesh stats");
        assert_eq!(in_memory, streamed, "{rel}: bounded assembler must be byte-identical");
    }
}

#[test]
fn streaming_bounded_preserves_world_geometry_on_instanced_model() {
    // duplex has rep-identity groups the streaming path deliberately skips
    // (bounded memory cannot hold every occurrence). World geometry must be
    // identical anyway: same element nodes, same total placed triangles.
    let Some(content) = crate::test_support::fixture_opt("ara3d/duplex.ifc") else { return };
    let opts = GltfOptions::default();
    let (in_memory, _) = export_glb_from_result(process_geometry(&content), &opts);
    let (streamed, stream_stats) = export_glb_streaming_bounded(&content, &opts);
    assert!(stream_stats.meshes > 0);
    let (mem_json, _) = parse_glb(&in_memory);
    let (str_json, str_bin) = parse_glb(&streamed);
    // One element node per visible mesh occurrence on both paths (+1 root each).
    assert_eq!(
        mem_json["nodes"].as_array().unwrap().len(),
        str_json["nodes"].as_array().unwrap().len(),
        "element node count must match",
    );
    assert_eq!(
        world_triangles(&mem_json),
        world_triangles(&str_json),
        "world triangle count must match",
    );
    // The BIN must be exactly the three runs the JSON declares.
    let declared: u64 = str_json["bufferViews"]
        .as_array()
        .unwrap()
        .iter()
        .map(|bv| bv["byteLength"].as_u64().unwrap())
        .sum();
    // pos/norm are 12-byte and idx 4-byte multiples, so the BIN needs no padding
    // and must be exactly the three declared runs.
    assert_eq!(declared as usize, str_bin.len(), "BIN length matches declared runs");
}

#[test]
fn streaming_bounded_quantized_is_byte_identical_on_flat_models() {
    for rel in ["ifcopenshell/1019-column.ifc", "ifcopenshell/1030-sphere.ifc"] {
        let Some(content) = crate::test_support::fixture_opt(rel) else { continue };
        let opts = GltfOptions {
            quantize: true,
            include_metadata: true,
            ..GltfOptions::default()
        };
        let (in_memory, mem_stats) = export_glb_from_result(process_geometry(&content), &opts);
        let (streamed, stream_stats) = export_glb_streaming_bounded(&content, &opts);
        assert_eq!(mem_stats.meshes, stream_stats.meshes, "{rel}: mesh stats");
        assert_eq!(in_memory, streamed, "{rel}: quantized bounded must be byte-identical");
    }
}

#[test]
fn streaming_bounded_quantized_preserves_world_geometry_on_instanced_model() {
    let Some(content) = crate::test_support::fixture_opt("ara3d/duplex.ifc") else { return };
    let opts = GltfOptions { quantize: true, ..GltfOptions::default() };
    let (in_memory, _) = export_glb_from_result(process_geometry(&content), &opts);
    let (streamed, stream_stats) = export_glb_streaming_bounded(&content, &opts);
    assert!(stream_stats.meshes > 0);
    let (mem_json, _) = parse_glb(&in_memory);
    let (str_json, _) = parse_glb(&streamed);
    // Node counts legitimately differ (the in-memory instanced quantized path
    // nests a dequant child under a placement parent), but each occurrence
    // carries exactly one mesh node on both paths, so placed triangles agree.
    assert_eq!(
        world_triangles(&mem_json),
        world_triangles(&str_json),
        "world triangle count must match",
    );
    assert_eq!(
        str_json["extensionsRequired"][0].as_str(),
        Some("KHR_mesh_quantization"),
    );
}

#[test]
fn streaming_bounded_matches_in_memory_on_empty_model() {
    let empty = GEOMETRYLESS_IFC.as_bytes();
    let opts = GltfOptions::default();
    let (in_memory, _) = export_glb_from_result(process_geometry(empty), &opts);
    let (streamed, stats) = export_glb_streaming_bounded(empty, &opts);
    assert_eq!(stats.meshes, 0);
    assert_eq!(in_memory, streamed, "empty-model GLB must be byte-identical");
}

// ── glTF quantized index componentType: u16 / u32 threshold (issue #2802) ──
//
// `push_mesh_quantized` (gltf.rs, in-memory quantized assembler) and the
// bounded streaming assembler's two independent copies of the same
// expression (one deciding the accessor's declared `componentType`, one
// deciding the actual byte width the second pass writes) all switch on
// `nverts <= u16::MAX as u32 + 1` (i.e. `nverts <= 65536`). No existing
// fixture straddled that boundary, so an off-by-one there would silently
// truncate index 65536 into a `u16` (wraps to 0 -- `65536 % 65536 == 0`)
// while every other assertion in the 228-test suite stayed green.
//
// These pin BOTH sides with a REAL round trip: the primitive's index buffer
// bytes are decoded per the accessor's DECLARED componentType and checked
// against the untruncated original values, not just the type tag.

/// A single-face `IfcFacetedBrep` with exactly `n` loop points, arranged as a
/// (very slightly non-planar-safe) convex polygon. `triangulate_face`
/// (gltf.rs's neighbour in `brep/faceted.rs`) emits EXACTLY one output
/// vertex per input loop point -- unlike `IfcTriangulatedFaceSet` /
/// `IfcPolygonalFaceSet`, which flat-shade (duplicate 3 vertices per
/// triangle, forcing the output vertex count to always be a multiple of 3).
/// That's the only geometry type in the pipeline that lets a test land on an
/// EXACT vertex count -- needed here because 65536 and 65537 are not
/// multiples of any small tessellation quantum.
fn faceted_brep_fixture(n: u32) -> String {
    assert!(n >= 3);
    let mut points = String::with_capacity(n as usize * 40);
    let mut refs = String::with_capacity(n as usize * 8);
    for i in 0..n {
        let id = 1000 + i;
        // Points on a slowly-growing-radius circle: convex (fast, robust
        // earcut) and no three points exactly collinear.
        let angle = std::f64::consts::TAU * (i as f64) / (n as f64);
        let r = 1000.0 + (i as f64) * 1e-6;
        let x = r * angle.cos();
        let y = r * angle.sin();
        points.push_str(&format!("#{id}=IFCCARTESIANPOINT(({x:.9},{y:.9},0.));\n"));
        refs.push_str(&format!("#{id},"));
    }
    refs.pop(); // trailing comma
    let loop_id = 1000 + n;
    let ob_id = loop_id + 1;
    let face_id = loop_id + 2;
    let shell_id = loop_id + 3;
    let brep_id = loop_id + 4;
    format!(
        "ISO-10303-21;\n\
HEADER;\n\
FILE_DESCRIPTION((''),'2;1');\n\
FILE_NAME('','',(''),(''),'','','');\n\
FILE_SCHEMA(('IFC4'));\n\
ENDSEC;\n\
DATA;\n\
#1=IFCPROJECT('0project00000000000001',$,'P',$,$,$,$,(#20),#30);\n\
#30=IFCUNITASSIGNMENT((#31));\n\
#31=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n\
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);\n\
#21=IFCAXIS2PLACEMENT3D(#22,$,$);\n\
#22=IFCCARTESIANPOINT((0.,0.,0.));\n\
#40=IFCLOCALPLACEMENT($,#21);\n\
#50=IFCBUILDINGELEMENTPROXY('0elem00000000000000001',$,'E',$,$,#40,#60,$,$);\n\
#60=IFCPRODUCTDEFINITIONSHAPE($,$,(#61));\n\
#61=IFCSHAPEREPRESENTATION(#20,'Body','Brep',(#{brep_id}));\n\
{points}\
#{loop_id}=IFCPOLYLOOP(({refs}));\n\
#{ob_id}=IFCFACEOUTERBOUND(#{loop_id},.T.);\n\
#{face_id}=IFCFACE((#{ob_id}));\n\
#{shell_id}=IFCCLOSEDSHELL((#{face_id}));\n\
#{brep_id}=IFCFACETEDBREP(#{shell_id});\n\
ENDSEC;\n\
END-ISO-10303-21;\n"
    )
}

/// Decode a SCALAR index accessor per its DECLARED `componentType` (5123 =
/// `UNSIGNED_SHORT`, 5125 = `UNSIGNED_INT`) -- proves the type tag and the
/// actual byte width written agree, rather than trusting one alone.
fn decode_indices(json: &Value, bin: &[u8], acc_idx: usize) -> Vec<u64> {
    let acc = &json["accessors"][acc_idx];
    let ct = acc["componentType"].as_u64().unwrap();
    let count = acc["count"].as_u64().unwrap() as usize;
    let bv_idx = acc["bufferView"].as_u64().unwrap() as usize;
    let bv = &json["bufferViews"][bv_idx];
    let base = bv["byteOffset"].as_u64().unwrap_or(0) as usize
        + acc["byteOffset"].as_u64().unwrap_or(0) as usize;
    // Cross-check the DECLARED componentType against the bufferView's actual
    // byteLength: a byte-width mismatch between "what pass 1 declared" and
    // "what pass 2 actually wrote" (the two-pass streaming path's two
    // SEPARATE copies of the `small` expression disagreeing) would otherwise
    // go undetected here -- reading a stream of real u32s as u16s still
    // happens to surface the expected values at SOME offset (each u32's low
    // half is its low 16 bits), so a membership check on the decoded values
    // alone is not sufficient evidence.
    let width = match ct {
        5123 => 2u64,
        5125 => 4u64,
        other => panic!("unexpected index componentType {other}"),
    };
    let declared_len = (count as u64 * width).div_ceil(4) * 4;
    let actual_len = bv["byteLength"].as_u64().unwrap();
    assert_eq!(
        actual_len, declared_len,
        "index bufferView byteLength ({actual_len}) doesn't match count*declared-width \
         ({declared_len}) -- the declared componentType disagrees with the bytes actually written"
    );
    (0..count)
        .map(|i| match ct {
            5123 => {
                let o = base + i * 2;
                u16::from_le_bytes(bin[o..o + 2].try_into().unwrap()) as u64
            }
            5125 => {
                let o = base + i * 4;
                u32::from_le_bytes(bin[o..o + 4].try_into().unwrap()) as u64
            }
            other => panic!("unexpected index componentType {other}"),
        })
        .collect()
}

/// The single element's mesh's index accessor id, plus its declared vertex count.
fn index_acc_and_nverts(json: &Value) -> (usize, u64) {
    let prim = &json["meshes"][0]["primitives"][0];
    let idx_acc = prim["indices"].as_u64().expect("indices accessor") as usize;
    let pos_acc = prim["attributes"]["POSITION"].as_u64().expect("position accessor") as usize;
    (idx_acc, json["accessors"][pos_acc]["count"].as_u64().unwrap())
}

/// nverts == u16::MAX + 1 (65536): the LARGEST vertex count that still fits a
/// `u16` index (max index = nverts - 1 = 65535 = u16::MAX exactly). Through
/// the IN-MEMORY quantized assembler -- reaches `push_mesh_quantized`'s
/// threshold (gltf.rs, `let small = nverts <= u16::MAX as u32 + 1`, near
/// line 805). Runs unconditionally: the fixture is synthetic STEP text, no
/// downloaded fixture involved.
#[test]
fn index_u16_boundary_in_memory() {
    let content = faceted_brep_fixture(65536);
    let opts = GltfOptions { quantize: true, ..GltfOptions::default() };
    let (glb, _) = export_glb_from_result(process_geometry(content.as_bytes()), &opts);
    let (json, bin) = parse_glb(&glb);
    let (idx_acc, nverts) = index_acc_and_nverts(&json);
    assert_eq!(nverts, 65536, "fixture must actually reach the boundary vertex count");
    assert_eq!(
        json["accessors"][idx_acc]["componentType"], 5123,
        "65536 verts must still fit UNSIGNED_SHORT (5123)"
    );
    let idx = decode_indices(&json, &bin, idx_acc);
    assert!(idx.iter().min() == Some(&0), "index 0 must be present: {idx:?}");
    assert!(idx.contains(&65535), "the max index (65535) must round-trip untruncated: {idx:?}");
}

/// nverts == u16::MAX + 2 (65537): ONE past the boundary -- max index =
/// 65536, which does NOT fit a `u16` (65536 % 65536 == 0 is exactly the
/// silent-wrap failure mode an off-by-one comparison would produce). Same
/// site as above.
#[test]
fn index_u32_promote_in_memory() {
    let content = faceted_brep_fixture(65537);
    let opts = GltfOptions { quantize: true, ..GltfOptions::default() };
    let (glb, _) = export_glb_from_result(process_geometry(content.as_bytes()), &opts);
    let (json, bin) = parse_glb(&glb);
    let (idx_acc, nverts) = index_acc_and_nverts(&json);
    assert_eq!(nverts, 65537, "fixture must actually reach one past the boundary");
    assert_eq!(
        json["accessors"][idx_acc]["componentType"], 5125,
        "65537 verts must promote to UNSIGNED_INT (5125)"
    );
    let idx = decode_indices(&json, &bin, idx_acc);
    assert!(idx.iter().min() == Some(&0), "index 0 must be present: {idx:?}");
    assert!(
        idx.contains(&65536),
        "the max index (65536) must survive as 65536, not wrap to 0: {idx:?}"
    );
}

/// Same boundary through the BOUNDED TWO-PASS streaming assembler: pass 1
/// declares the accessor's `componentType` (gltf.rs, near line 2295), pass 2
/// writes the actual index bytes using a SEPARATELY re-evaluated copy of the
/// same expression stashed on `StreamedWrite.quant` (near line 2367,
/// consumed near line 2618). Both duplicated copies have to agree with pass
/// 1 AND with the untruncated value for this to pass.
#[test]
fn index_u16_boundary_streaming_bounded() {
    let content = faceted_brep_fixture(65536);
    let opts = GltfOptions { quantize: true, ..GltfOptions::default() };
    let (glb, _) = export_glb_streaming_bounded(content.as_bytes(), &opts);
    let (json, bin) = parse_glb(&glb);
    let (idx_acc, nverts) = index_acc_and_nverts(&json);
    assert_eq!(nverts, 65536);
    assert_eq!(json["accessors"][idx_acc]["componentType"], 5123);
    let idx = decode_indices(&json, &bin, idx_acc);
    assert!(idx.iter().min() == Some(&0), "index 0 must be present: {idx:?}");
    assert!(idx.contains(&65535), "{idx:?}");
}

/// See [`index_u16_boundary_streaming_bounded`]; the promote side.
#[test]
fn index_u32_promote_streaming_bounded() {
    let content = faceted_brep_fixture(65537);
    let opts = GltfOptions { quantize: true, ..GltfOptions::default() };
    let (glb, _) = export_glb_streaming_bounded(content.as_bytes(), &opts);
    let (json, bin) = parse_glb(&glb);
    let (idx_acc, nverts) = index_acc_and_nverts(&json);
    assert_eq!(nverts, 65537);
    assert_eq!(json["accessors"][idx_acc]["componentType"], 5125);
    let idx = decode_indices(&json, &bin, idx_acc);
    assert!(idx.iter().min() == Some(&0), "index 0 must be present: {idx:?}");
    assert!(idx.contains(&65536), "{idx:?}");
}
