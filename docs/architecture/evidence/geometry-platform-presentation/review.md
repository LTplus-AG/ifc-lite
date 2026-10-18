# Owned presentation assembly review

Read-only review of immutable checkpoint `c8f5fff12e1203a25bcd5a9f7b87889067977dd5` in `/home/louistrue/.t3/worktrees/ifc-lite/t3-0ea08063`, compared with original source from `git show e2e42bbfb8`. No source edits, builds, tests, jobs, or compiler invocations were performed. The seven new tests have not been compiled or executed; this review is not qualification evidence.

## Findings

1. **Remove orphan import before Clippy.** `rust/processing/src/element.rs:41` retains `compose_instance_world_row_major`. Its only remaining call in the element subtree is `assembly_submeshes.rs:142`, which now resolves its own explicit import at line 6. No remaining consumer of the parent import was found. This is a static unused-import finding, expected to fail the required `cargo clippy --workspace --all-targets -- -D warnings`; no compiler result is claimed.
2. **Repair deleted-helper rustdoc reference.** `rust/processing/src/types/mesh.rs:328` still links `crate::element::emit_sub_meshes`, deleted by this patch. Link to the live producer or current assembly boundary. This is a dangling intra-doc link, not an observed geometry regression. Prose-only old helper names also remain in geometry/hash integration-test descriptions and geometry Mesh documentation.

No concrete behavioral regression was found in the reviewed production changes.

## Preservation reasoning

- `presentation_source::submeshes` repairs outward orientation and missing/flipped normals before resolving direct/mapped styles, matching the original order. One material cursor covers materialized and instance-only parts. Empty noninstance parts neither read source nor advance it. Instance metadata still composes through the same world-transform function, and collection-level item/material identity remains distinct.
- Submesh hashing stays after effective style resolution and before UV/palette decisions. Texture admission uses the original integer-divided UV count guard, rather than introducing stricter new malformed-input validation. Rejected texture drops UVs before palette/plain assembly. Palette split retains the original geometry/material discriminator, class and per-group normals.
- Fallback outward orientation/flip repair precedes the late indexed-colour source walk. A successful palette split hashes the unsplit body once. Rejection repairs missing normals, hashes once, and emits plain geometry without the attempted palette source identity. The removed old empty-output fallback is unreachable under the current splitter: `split_mesh_by_indexed_colour` only returns Some when at least two groups survive.
- The selected palette map key is retained separately from its embedded geometry_id. This preserves malformed-but-accepted fallback inputs where those values differ. Owned palette/frame handles refer to the captured immutable context; borrowed adapters retain references rather than copy model maps.
- Type-map colour is resolved once before inspecting/filtering its parts, including an empty vector. Geometry callbacks therefore still precede the late ancestry walk. Type texture-presence policy remains distinct from the submesh UV guard, and type parts remain excluded from hashing.
- `build_mesh_data` changes only the context argument to its actual site-local rotation dependency and switches metadata access to the shared/borrowed view. Degenerate cleanup, weld/UV remap, native-frame instance metadata, local bounds/transforms, class, source identity and site-local conversion retain their order.
- Metadata was already captured once in OwnedJob before geometry; using an Arc preserves that snapshot while avoiding copies per part. AssemblyJob no longer retains DecodedEntity. ReadyPresentation contains no decoder/router/source callback and is consumed by assembly.
- Existing session acceptance still checks session/context/sequence/stage/payload/emitter/owner before late admission or hashing, and marks the protocol accepted only after assembly. The patch does not create a second replay route or exported independently executable packet. ReadyPresentation is a private linear value, not a new transport-ready protocol.

## Qualification recommendations

Compile and execute all seven new tests plus existing actual wrong-owner/wrong-emitter/wrong-context/stale-ticket/replay rejection tests on this exact checkpoint before reporting green. Include the existing late custom mutation and scoped-worker suites. The new type-map mutation test uses the explicit compatibility model, so it does not establish future source-authenticated mutation policy.

Retain real-model scene comparison covering nonempty texture, multicolour palette, site-local rotation and instance-only output. In particular, check geometry/material ID fields and all serde-skipped frame/instance fields, not only flattened triangle buffers. A useful focused untested invariant is empty TypeMap parts whose ancestry lookup records a malformed/refused source: lookup must still occur once before returning empty. No new arbitrary resource cap or performance claim is justified by this extraction.

## Inspected hashes

Incremental patch SHA256: `c3f7c80e7765f9fcac6d77054888a20296e07da13caf7a06f9c534ecb0c415cd`.

- `rust/processing/src/element.rs`: `e94588ca7939f9b06122f88785f102288148583d309c93705887481e31eba776`
- `rust/processing/src/element/assembly_fallback.rs`: `809fd4daf11e8489b0a0e948fa9b7a9ebabda3772fb5b7927e81a06277e9d5ad`
- `rust/processing/src/element/assembly_job.rs`: `06b3fa9eebe0fb0d07a2138ec71d0a15c487abb12055cf89149fd5765715f971`
- `rust/processing/src/element/assembly_submeshes.rs`: `56c593dfa9b850ea63c67c47a78e5c3ad75418f000b1b21f021432203fd4d57d`
- `rust/processing/src/element/assembly_types.rs`: `625822ac3ae7bb46a2e24bb4c90344cb7c448e6108615284d21fee41a5a71d9b`
- `rust/processing/src/element/element_color.rs`: `af6ba301c51a788480439ad72f57e092671e16725310c5fce307156c87873624`
- `rust/processing/src/element/owned_session.rs`: `05dc99e138854f154283ba1132678ecc430af6da047e8c5de13648757dbeb059`
- `rust/processing/src/element/presentation.rs`: `4eb6b4564d0fe93d90ef074af3c445621a63865e5e86854061a3bb91eb5a78d8`
- `rust/processing/src/element/presentation_palette_tests.rs`: `3ef39858c4b7bcc9d8000cfbee9f19da4e414dac8d7ee97c2bb19eb93506d69f`
- `rust/processing/src/element/presentation_source.rs`: `8ef40fbb2125406595873e63e395100b2376345c582fba3202298549bb6b119b`
- `rust/processing/src/element/presentation_tests.rs`: `ba0d65e761f7a5cd327c1c38d2298894ec3e1fd3a05bab80ea1286e3d79ba149`
- `rust/processing/src/element/session.rs`: `ddb799ae62895725b24c7e561a5ea0a528afd1962063ec2b59cc4848ba22afed`
- `rust/processing/src/element/session_accept.rs`: `ae83ccd64da2c0eb24737199d1a7a25154cae0facf9a0c5d9f8e9a88d3fbaddf`
- `rust/processing/src/element/session_state.rs`: `c6161e45da7309b9f47e76956384eba9f0f2be5c5614facab4db3ef57d3f0b95`
- `rust/processing/src/element_mesh_build.rs`: `7731bf4b00023f717bfbe393326c0ba1ef1ecd0fad9b725ae48810f8efc553ed`
- `rust/processing/src/element_tests.rs`: `bc11a0c3552354e2cbe4d6da0c3d90448eff52556b16af54b38d90655a6e040f`
- `rust/processing/src/style/indexed_colour.rs`: `4abadb2a66404a75a1d15059aa72b36a9a856d83be0c51ee88c06a978dcf476b`
- `rust/processing/src/element/session_protocol.rs`: `48e1aeb137457e66f2ad9eb76db82f27ca92b9de44de7a3103cd6aee4b4e6e2d`
- `rust/processing/src/types/mesh.rs`: `57a95279e3e0210f9f19c3b2dc43f05f8ed23b2bee7b330d503f4a9064817be5`
- `rust/geometry/src/csg/normals.rs`: `c2ff8a3d70a02b909b95b5f39cbc33f56d6d5451440d115162f838836e82c34d`
