# Material cursor test correction

Investigated the actual failed `presentation_one_material_cursor_crosses_real_instance_only_and_materialized_parts` assertion in job3f4fe221-d5a8-43c9-95d6-dbd116545dc6. Its immutable receipt identifies clean source082aab27df3b2a2550d29510798c0a7cea5a9b23 and terminal101. The log records failure at the body-color assertion, not the observed color values; no missing runtime values are invented here.

Cause established from canonical source: resolve_submesh_color starts mat_color_idx at0 and selects prefer_transparent for even indices. With RED alpha1 and GLASS alpha0.3, the first eligible part receives GLASS, the next RED, alternating across both instance-only and materialized channels. List order[RED,GLASS] does not make the first part RED: pick_material_style_for_submesh searches by opacity before using the first entry as fallback. The complete resolver function is byte-identical at base8acd0715a, failed082 and current source. Original pre-phase assembly and current presentation_source each initialize one collection cursor to0 and pass that same cursor through both actual empty-instance and body branches. The fixture contains no direct style overriding these supplied material colors. Current product collection merge appends reached child collections without reordering them.

The failing test asserted the inverse policy. For items32,600,39,601, the two mapped instances occupy even positions and receive GLASS; bodies600/601 receive RED. For600,32,601,39, the two bodies receive GLASS and the instances RED. No production cursor or shared appearance resolver change is justified by this source evidence.

Changed ONLY `rust/processing/src/element/presentation_tests.rs`, left uncommitted:

- Corrected the expected body/instance tuples to transparent-first canonical policy, with an explanatory comment.
- Replaced broad all-equal boolean assertions with exact two-entry color-list equality and fixture-order failure messages, preserving and strengthening both material and instance-color assertions.
- Preserved the actual mapped fixture and both original interleavings, all material/instance geometry counts, item IDs, world transforms, metadata and hash assertions. No fixture replacement, test weakening, callback mock or alternate producer was introduced.

Production presentation modules, canonical Rust styling, late-source lookup, frame/hash processing, session/accounting and other agents' files remain unchanged by this correction. The change addresses an unsupported authored test premise; it does not manufacture an actual new runtime pass or establish that every newly integrated inner path is correct.

Validation performed: rustfmt --emit stdout --config skip_children=true on the touched test file, and git diff --check for that path, both exit0. No formatting edits, Cargo/build/test/numerical run, fleet submission or guard bypass. Runtime remains UNRUN for the corrected test and current integrated source; the next admitted workspace run must verify both color lists together with all unchanged geometry/metadata assertions.

Exact source/fixture/receipt hashes and the byte-identical canonical function hash are in `/tmp/ifclite-material-cursor-correction-hashes.json`. Parse log: `/tmp/ifclite-material-cursor-test-parse.log`.
