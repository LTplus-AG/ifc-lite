# Empty-export rule (#7695)

`refusal.oracle.patch` is the revert-oracle mutation for the empty-export rule of #7695 (EXPORT-GEOM-9/15). The step that applies it is "Prove the changed tests observe the production change" in `.github/workflows/test.yml`.

The PR changes five public return types to `Result` (`export_gltf_streaming`, `export_gltf_streaming_with_index`, `export_obj`, `export_obj_with_stats` and `export_usd`), and the tests it changes call them that way. A whole-change revert therefore stops those tests compiling, and the oracle reports REVERT-BROKE-BUILD. This patch keeps every type and new item. It disables ONLY the behaviour each test pins:

| guard disabled | where | tests that turn red |
|---|---|---|
| `require_render_geometry` never refuses, so no render-geometry writer does | `rust/export/src/error.rs` | `empty_export_parity.rs`, the OBJ and USD unit tests |
| `countUsdMeshes` counts the `/World` Xform, so an empty stage reads as non-empty | `packages/export/src/zero-content.ts` | `zero-content.parity.test.ts` |
| the CLI stops mapping `NO_RENDER_GEOMETRY` to its operator message | `packages/cli/src/commands/export-rust-formats.ts` | `export.empty-model.test.ts` |
| the MCP tools stop mapping it to a tool error | `packages/mcp/src/tools/export.ts` | `export-usd.test.ts`, `export-init-dispose.test.ts` |
| the viewer's USD dialog shows the raw engine error | `apps/viewer/src/components/viewer/UsdExportDialog.tsx` | `UsdExportDialog.test.tsx` |

Once `empty_export_parity.rs` is on `main`, the ordinary whole-change revert resumes automatically, because the `elif` matches only while the PR adds that file.
