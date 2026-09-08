// SPDX-License-Identifier: MPL-2.0
//! Spec-derived structural conformance for the GLBs `gltf.rs` writes.
//!
//! Why this exists, and why it is separate from `gltf_tests.rs`:
//!
//! Until now the only reader of a GLB this crate writes was this crate's own
//! `parse_glb` test helper (and, on the TypeScript side, our own
//! `packages/export/src/glb.ts`). A writer and a reader that agree with each
//! other prove nothing about the FORMAT — they prove they share a convention.
//! `gltf_tests.rs:try_from_meshes_rejects_empty_input` even names
//! glTF-Validator in a comment describing what it would report, without ever
//! invoking it.
//!
//! The Khronos reference validator now runs on real exporter output in
//! `scripts/test-wasm-contract.mjs` (node lane, real wasm boundary). It cannot
//! reach everything: `GltfOptions::quantize` and the multi-buffer / streaming
//! entry points have no wasm binding, so the option combinations most likely
//! to break byte layout are exactly the ones that lane cannot see. These
//! checks close that gap inside `cargo test`, and they are written against the
//! glTF 2.0 specification's own rules — not against our parser — so passing
//! them is evidence about the format rather than about ourselves.
//!
//! Each rule cites the spec requirement it encodes. What is checked here and
//! nowhere else before: accessor TOTAL byteOffset alignment (bufferView offset
//! plus accessor offset, against component size), declared accessor min/max
//! against the bytes actually written, index values against the primitive's
//! own vertex count, `mode`/`componentType` legality on the f32 path, GLB
//! chunk framing and padding bytes.

use super::*;

/// glTF 2.0 §3.6.2.2: component type enum → size in bytes.
fn component_size(ct: u64) -> usize {
    match ct {
        5120 | 5121 => 1,          // BYTE, UNSIGNED_BYTE
        5122 | 5123 => 2,          // SHORT, UNSIGNED_SHORT
        5125 | 5126 => 4,          // UNSIGNED_INT, FLOAT
        other => panic!("componentType {other} is not one of the glTF 2.0 enum values"),
    }
}

/// glTF 2.0 §3.6.2.2: accessor type → number of components.
fn type_components(t: &str) -> usize {
    match t {
        "SCALAR" => 1,
        "VEC2" => 2,
        "VEC3" => 3,
        "VEC4" => 4,
        "MAT2" => 4,
        "MAT3" => 9,
        "MAT4" => 16,
        other => panic!("accessor type {other:?} is not a glTF 2.0 accessor type"),
    }
}

/// Read one raw component out of the BIN chunk, as the spec says a consumer
/// would: `bufferView.byteOffset + accessor.byteOffset + i * stride + c * size`.
/// The value is the value as STORED (normalization is not applied), which is
/// what `accessor.min`/`max` are defined against.
fn read_component(bin: &[u8], ct: u64, at: usize) -> f64 {
    match ct {
        5120 => bin[at] as i8 as f64,
        5121 => bin[at] as f64,
        5122 => i16::from_le_bytes(bin[at..at + 2].try_into().unwrap()) as f64,
        5123 => u16::from_le_bytes(bin[at..at + 2].try_into().unwrap()) as f64,
        5125 => u32::from_le_bytes(bin[at..at + 4].try_into().unwrap()) as f64,
        5126 => f32::from_le_bytes(bin[at..at + 4].try_into().unwrap()) as f64,
        other => panic!("componentType {other}"),
    }
}

/// Split a GLB into its JSON and BIN chunks while checking the container rules
/// from glTF 2.0 §4.4 (GLB layout) — separate from `gltf_tests.rs::parse_glb`,
/// which trusts the framing it is handed.
fn split_glb_checked(glb: &[u8], label: &str) -> (Value, Vec<u8>) {
    assert!(glb.len() >= 20, "{label}: GLB shorter than a header + one chunk header");
    assert_eq!(&glb[0..4], b"glTF", "{label}: §4.4.1 magic");
    assert_eq!(u32::from_le_bytes(glb[4..8].try_into().unwrap()), 2, "{label}: §4.4.1 version");
    let total = u32::from_le_bytes(glb[8..12].try_into().unwrap()) as usize;
    assert_eq!(total, glb.len(), "{label}: §4.4.1 header length == file length");
    assert!(total.is_multiple_of(4), "{label}: §4.4.1 total length must be 4-aligned");

    // §4.4.3: chunk 0 is JSON, chunk 1 (when present) is BIN; every chunk
    // length is a multiple of 4 and the padding byte is chunk-type specific
    // (0x20 for JSON, 0x00 for BIN) — not "whatever the writer felt like".
    let json_len = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
    assert_eq!(&glb[16..20], b"JSON", "{label}: §4.4.3 first chunk must be JSON");
    assert!(json_len.is_multiple_of(4), "{label}: §4.4.3 JSON chunk length 4-aligned");
    let json_end = 20 + json_len;
    assert!(json_end <= glb.len(), "{label}: JSON chunk overruns the file");
    let json_bytes = &glb[20..json_end];
    for (i, b) in json_bytes.iter().enumerate().rev() {
        if *b != 0x20 {
            // First non-pad byte from the end must close the JSON object.
            assert_eq!(*b, b'}', "{label}: §4.4.3 JSON chunk pads with 0x20 only (byte {i})");
            break;
        }
    }
    let json: Value = serde_json::from_slice(json_bytes).expect("JSON chunk parses");

    assert!(json_end + 8 <= glb.len(), "{label}: missing BIN chunk header");
    let bin_len = u32::from_le_bytes(glb[json_end..json_end + 4].try_into().unwrap()) as usize;
    assert_eq!(&glb[json_end + 4..json_end + 8], b"BIN\0", "{label}: §4.4.3 BIN chunk tag");
    assert!(bin_len.is_multiple_of(4), "{label}: §4.4.3 BIN chunk length 4-aligned");
    let bin_start = json_end + 8;
    assert_eq!(bin_start + bin_len, glb.len(), "{label}: BIN chunk must end the file");
    (json, glb[bin_start..bin_start + bin_len].to_vec())
}

/// Assert every structural rule this file encodes over one GLB.
///
/// `label` names the export configuration so a failure says which one broke.
fn assert_gltf_conformant(glb: &[u8], label: &str) {
    let (json, bin) = split_glb_checked(glb, label);

    assert_eq!(json["asset"]["version"], "2.0", "{label}: §3.2 asset.version");

    // ── buffers (§3.6.1) ────────────────────────────────────────────────
    let buffers = json["buffers"].as_array().expect("buffers");
    assert_eq!(buffers.len(), 1, "{label}: a GLB embeds exactly one buffer");
    let buf_len = buffers[0]["byteLength"].as_u64().expect("buffer.byteLength") as usize;
    assert!(buf_len >= 1, "{label}: §3.6.1 buffer.byteLength minimum is 1");
    assert!(
        buffers[0].get("uri").is_none(),
        "{label}: §4.4.4 the GLB-stored buffer must not declare a uri"
    );
    // §4.4.4: the BIN chunk may carry up to 3 trailing pad bytes, no more.
    assert!(
        buf_len <= bin.len() && bin.len() - buf_len < 4,
        "{label}: §4.4.4 buffer.byteLength {buf_len} vs BIN chunk {} (pad must be < 4)",
        bin.len()
    );

    // ── bufferViews (§3.6.1.1) ──────────────────────────────────────────
    let views = json["bufferViews"].as_array().expect("bufferViews");
    assert!(!views.is_empty(), "{label}: §3.6.1.1 bufferViews minItems 1 when present");
    for (i, bv) in views.iter().enumerate() {
        assert_eq!(bv["buffer"].as_u64(), Some(0), "{label}: bufferViews[{i}].buffer");
        let off = bv["byteOffset"].as_u64().unwrap_or(0) as usize;
        let len = bv["byteLength"].as_u64().expect("byteLength") as usize;
        assert!(len >= 1, "{label}: §3.6.1.1 bufferViews[{i}].byteLength minimum is 1");
        assert!(
            off + len <= buf_len,
            "{label}: bufferViews[{i}] [{off}, {}) overruns buffer ({buf_len})",
            off + len
        );
        let target = bv["target"].as_u64();
        assert!(
            matches!(target, None | Some(34962) | Some(34963)),
            "{label}: §3.6.1.1 bufferViews[{i}].target {target:?} is not ARRAY_BUFFER/ELEMENT_ARRAY_BUFFER"
        );
        if let Some(stride) = bv["byteStride"].as_u64() {
            assert!(
                (4..=252).contains(&stride) && stride.is_multiple_of(4),
                "{label}: §3.6.1.1 bufferViews[{i}].byteStride {stride} must be 4..=252 and 4-aligned"
            );
            // §3.6.1.1: byteStride is for vertex attributes; it must not be
            // set on a bufferView used for indices.
            assert_ne!(
                target,
                Some(34963),
                "{label}: bufferViews[{i}] declares byteStride on an index bufferView"
            );
        }
    }

    // ── accessors (§3.6.2) ──────────────────────────────────────────────
    let accessors = json["accessors"].as_array().expect("accessors");
    assert!(!accessors.is_empty(), "{label}: §3.6.2 accessors minItems 1 when present");
    for (i, acc) in accessors.iter().enumerate() {
        let ct = acc["componentType"].as_u64().expect("componentType");
        let csize = component_size(ct);
        let ncomp = type_components(acc["type"].as_str().expect("type"));
        let count = acc["count"].as_u64().expect("count") as usize;
        assert!(count >= 1, "{label}: §3.6.2 accessors[{i}].count minimum is 1");

        let bv_idx = acc["bufferView"].as_u64().expect("bufferView") as usize;
        assert!(bv_idx < views.len(), "{label}: accessors[{i}].bufferView out of range");
        let bv = &views[bv_idx];
        let bv_off = bv["byteOffset"].as_u64().unwrap_or(0) as usize;
        let bv_len = bv["byteLength"].as_u64().unwrap() as usize;
        let acc_off = acc["byteOffset"].as_u64().unwrap_or(0) as usize;

        // §3.6.2.4: accessor.byteOffset must be a multiple of the component
        // size, AND so must (bufferView.byteOffset + accessor.byteOffset).
        // The second is the one nothing checked: a bufferView nudged off a
        // 4-byte boundary leaves every accessor's own offset innocent-looking
        // and still makes the file unreadable by a typed-array consumer.
        assert!(
            acc_off.is_multiple_of(csize),
            "{label}: §3.6.2.4 accessors[{i}].byteOffset {acc_off} % {csize} != 0"
        );
        assert!(
            (bv_off + acc_off).is_multiple_of(csize),
            "{label}: §3.6.2.4 accessors[{i}] total byteOffset {} % {csize} != 0",
            bv_off + acc_off
        );

        let element = csize * ncomp;
        let stride = bv["byteStride"].as_u64().map(|s| s as usize).unwrap_or(element);
        assert!(stride >= element, "{label}: accessors[{i}] stride {stride} < element {element}");
        // §3.6.2.4: the last element must fit; earlier ones are covered by the
        // stride, so the span is (count-1)*stride + element, not count*stride.
        let span = (count - 1) * stride + element;
        assert!(
            acc_off + span <= bv_len,
            "{label}: accessors[{i}] span {span} at +{acc_off} overruns bufferView {bv_idx} ({bv_len})"
        );

        // §3.6.2.5: min/max, when present, must have one entry per component
        // and must equal the actual extrema of the stored data. Nothing here
        // recomputed them before, so a bounds bug read as correct against our
        // own parser (which never looks at min/max) — and only shows up in a
        // consumer as culled or mis-frustum'd geometry.
        if let Some(min) = acc.get("min").and_then(|v| v.as_array()) {
            let max = acc["max"].as_array().expect("max accompanies min");
            assert_eq!(min.len(), ncomp, "{label}: accessors[{i}].min length");
            assert_eq!(max.len(), ncomp, "{label}: accessors[{i}].max length");
            let mut lo = vec![f64::INFINITY; ncomp];
            let mut hi = vec![f64::NEG_INFINITY; ncomp];
            for e in 0..count {
                for c in 0..ncomp {
                    let at = bv_off + acc_off + e * stride + c * csize;
                    let v = read_component(&bin, ct, at);
                    assert!(v.is_finite(), "{label}: accessors[{i}] element {e} comp {c} is not finite");
                    lo[c] = lo[c].min(v);
                    hi[c] = hi[c].max(v);
                }
            }
            // Compared at f32 precision, which is the precision the bounds are
            // WRITTEN at (`Accessor::min` is `[f32; 3]`, serialised as its
            // shortest round-tripping decimal). Widening that decimal to f64
            // and comparing against the f64-widened stored f32 differs in the
            // low bits for a reason that is about JSON, not about the export.
            for c in 0..ncomp {
                assert_eq!(
                    min[c].as_f64().unwrap() as f32,
                    lo[c] as f32,
                    "{label}: accessors[{i}].min[{c}] disagrees with the stored data"
                );
                assert_eq!(
                    max[c].as_f64().unwrap() as f32,
                    hi[c] as f32,
                    "{label}: accessors[{i}].max[{c}] disagrees with the stored data"
                );
            }
        }
    }

    // ── meshes / primitives (§3.7.2) ────────────────────────────────────
    let meshes = json["meshes"].as_array().expect("meshes");
    assert!(!meshes.is_empty(), "{label}: §3.7.2 meshes minItems 1 when present");
    let materials = json["materials"].as_array().map(|m| m.len()).unwrap_or(0);
    for (m, mesh) in meshes.iter().enumerate() {
        let prims = mesh["primitives"].as_array().expect("primitives");
        assert!(!prims.is_empty(), "{label}: §3.7.2 meshes[{m}].primitives minItems 1");
        for (p, prim) in prims.iter().enumerate() {
            let at = format!("{label}: meshes[{m}].primitives[{p}]");
            // §3.7.2.1: mode is one of the seven topology enums.
            let mode = prim["mode"].as_u64().unwrap_or(4);
            assert!(mode <= 6, "{at}.mode {mode} is out of the 0..=6 enum");
            assert_eq!(mode, 4, "{at}: this exporter emits TRIANGLES only");

            let pos_idx = prim["attributes"]["POSITION"]
                .as_u64()
                .expect("POSITION attribute") as usize;
            assert!(pos_idx < accessors.len(), "{at}.attributes.POSITION out of range");
            let pos = &accessors[pos_idx];
            assert_eq!(pos["type"], "VEC3", "{at}: §3.7.2.1 POSITION must be VEC3");
            assert!(
                pos.get("min").is_some() && pos.get("max").is_some(),
                "{at}: §3.7.2.1 POSITION accessor must declare min and max"
            );
            let nverts = pos["count"].as_u64().unwrap();

            if let Some(nrm_idx) = prim["attributes"]["NORMAL"].as_u64() {
                let nrm = &accessors[nrm_idx as usize];
                assert_eq!(nrm["type"], "VEC3", "{at}: §3.7.2.1 NORMAL must be VEC3");
                assert_eq!(
                    nrm["count"].as_u64().unwrap(),
                    nverts,
                    "{at}: §3.7.2.1 all attribute accessors share one count"
                );
            }

            if let Some(mat) = prim["material"].as_u64() {
                assert!((mat as usize) < materials, "{at}.material out of range");
            }

            let idx_idx = prim["indices"].as_u64().expect("indices") as usize;
            assert!(idx_idx < accessors.len(), "{at}.indices out of range");
            let idx = &accessors[idx_idx];
            assert_eq!(idx["type"], "SCALAR", "{at}: §3.7.2.1 indices must be SCALAR");
            let ict = idx["componentType"].as_u64().unwrap();
            assert!(
                matches!(ict, 5121 | 5123 | 5125),
                "{at}: §3.7.2.1 index componentType {ict} must be an UNSIGNED type"
            );
            assert!(
                idx.get("normalized").and_then(|v| v.as_bool()) != Some(true),
                "{at}: §3.7.2.1 index accessors must not be normalized"
            );
            let icount = idx["count"].as_u64().unwrap() as usize;
            assert!(
                icount.is_multiple_of(3),
                "{at}: §3.7.2.1 TRIANGLES needs a multiple of 3 indices, got {icount}"
            );

            // §3.7.2.1: "the index accessor's values must not exceed the
            // number of vertices". An out-of-range index is the single most
            // common way a mesh writer takes a consumer down, and nothing
            // here read the index bytes back before.
            let ibv = &views[idx["bufferView"].as_u64().unwrap() as usize];
            let ibase = ibv["byteOffset"].as_u64().unwrap_or(0) as usize
                + idx["byteOffset"].as_u64().unwrap_or(0) as usize;
            let isize_ = component_size(ict);
            for e in 0..icount {
                let v = read_component(&bin, ict, ibase + e * isize_);
                assert!(
                    (v as u64) < nverts,
                    "{at}: index[{e}] = {v} >= vertex count {nverts}"
                );
            }
        }
    }

    // ── scene graph (§3.5) ──────────────────────────────────────────────
    let nodes = json["nodes"].as_array().expect("nodes");
    assert!(!nodes.is_empty(), "{label}: §3.5.1 nodes minItems 1 when present");
    for (i, n) in nodes.iter().enumerate() {
        if let Some(mesh) = n["mesh"].as_u64() {
            assert!((mesh as usize) < meshes.len(), "{label}: nodes[{i}].mesh out of range");
        }
        // §3.5.2: a node uses either `matrix` or the TRS triple, never both.
        if n.get("matrix").is_some() {
            assert!(
                n.get("translation").is_none()
                    && n.get("rotation").is_none()
                    && n.get("scale").is_none(),
                "{label}: nodes[{i}] mixes matrix with TRS"
            );
            assert_eq!(
                n["matrix"].as_array().map(|a| a.len()),
                Some(16),
                "{label}: nodes[{i}].matrix must have 16 entries"
            );
        }
        for c in n["children"].as_array().into_iter().flatten() {
            assert!(
                (c.as_u64().unwrap() as usize) < nodes.len(),
                "{label}: nodes[{i}].children out of range"
            );
        }
    }
    let scene = json["scene"].as_u64().expect("scene") as usize;
    let scenes = json["scenes"].as_array().expect("scenes");
    assert!(scene < scenes.len(), "{label}: §3.5 scene index out of range");
    for r in scenes[scene]["nodes"].as_array().expect("scene nodes") {
        assert!(
            (r.as_u64().unwrap() as usize) < nodes.len(),
            "{label}: scene root node out of range"
        );
    }
}

#[test]
fn f32_export_is_structurally_conformant() {
    let content = fixture_or_skip!("ara3d/duplex.ifc");
    for (label, opts) in [
        ("default", GltfOptions::default()),
        ("metadata", GltfOptions { include_metadata: true, ..Default::default() }),
        ("unlit", GltfOptions { lit: false, ..Default::default() }),
        ("emissive", GltfOptions { emissive: true, ..Default::default() }),
    ] {
        let glb = export_glb(&content, &opts);
        assert_gltf_conformant(&glb, label);
    }
}

#[test]
fn quantized_export_is_structurally_conformant() {
    // `quantize` has no wasm binding, so the Khronos validator lane in
    // `scripts/test-wasm-contract.mjs` cannot reach it — and it is the path
    // with the unusual byte layout (SHORT attributes padded to an 8-byte
    // stride, u16-or-u32 indices chosen per mesh). This is its only
    // spec-level check.
    let content = fixture_or_skip!("ara3d/duplex.ifc");
    let glb = export_glb(&content, &GltfOptions { quantize: true, ..Default::default() });
    assert_gltf_conformant(&glb, "quantized");
}

#[test]
fn from_meshes_export_is_structurally_conformant() {
    // Fixture-free, so this leg runs even where the model corpus is absent —
    // the from-meshes assembler is a separate module (`gltf/from_meshes.rs`)
    // reachable from the viewer, not a thin wrapper over the from-bytes path.
    // Two meshes with different vertex counts, so a per-mesh offset bug cannot
    // hide behind identical strides.
    let positions: Vec<f32> = vec![
        0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, // quad
        2.0, 0.0, 0.0, 3.0, 0.0, 0.0, 2.5, 1.0, 0.5, // triangle
    ];
    let normals: Vec<f32> = vec![
        0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, //
        0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0,
    ];
    let indices: Vec<u32> = vec![0, 1, 2, 0, 2, 3, 0, 1, 2];
    let glb = try_export_glb_from_meshes(
        &positions,
        &normals,
        &indices,
        &[4, 3],
        &[6, 3],
        &[0.8, 0.2, 0.2, 1.0, 0.2, 0.8, 0.2, 1.0],
        &[0.0, 0.0, 0.0],
        &[11, 22],
        true,
        true,
        false,
    )
    .expect("valid mesh arrays export");
    assert_gltf_conformant(&glb.0, "from_meshes");
}

#[test]
fn streaming_bounded_export_is_structurally_conformant() {
    // The bounded/streaming assembler writes the same buffers under a
    // different control flow (two mesh passes, a size ceiling). It has no wasm
    // binding either.
    // Called directly rather than reached by lowering
    // `IFC_LITE_GLB_STREAM_THRESHOLD_MB`: that knob treats 0 as "disabled"
    // (`usize::MAX`), so the obvious spelling silently tests the in-memory
    // path instead — which is exactly what a mutation of the bounded
    // assembler's bufferView offsets revealed while this file was written.
    let content = fixture_or_skip!("ara3d/duplex.ifc");
    let (glb, stats) = export_glb_streaming_bounded(&content, &GltfOptions::default());
    assert!(stats.meshes > 0, "the bounded assembler produced no meshes to check");
    assert_gltf_conformant(&glb, "streaming_bounded");
}
