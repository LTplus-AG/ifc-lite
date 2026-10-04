# #6232 D5 hosted editing and browser qualification

`bim.store.editHostedElement` and `edit_hosted_element` expose the existing Model workspace slide/inspector core. Lengths are host-local metres; width/height change the physical source occurrence and opening together. Shared source type geometry, identity and relationships survive. Viewer remeshing covers the host, opening and filling; both hosts record one compound Undo.

Ground truth: the unmodified committed Bonsai `hello-wall.ifc`, with imported windows #1262/#1407 and cuts #1299/#1443. SDK and actual MCP JSON-RPC tests resize #1262 to 1.2 x 1.4 m, retain #1407, slide the cut, reject out-of-host/invalid changes without allocating IDs or journal entries, and restore the preceding graph. Native-WASM viewer controls pass at one and two models, with exact original/edited mesh restoration and independent Undo.

Final restored qualification: 3 SDK, 6 MCP, 2 real-WASM viewer controls pass, no skips. Full SDK/MCP: 312/547 passes, 6/5 optional fixture skips. Root typecheck covers 3,336 test files; lint, documentation samples (433), API snapshot, module size, source-text and test-wiring checks pass. The surgical inverse restores only three producer handlers to the parent commit: one new SDK, one MCP and both viewer controls fail on assertions; seven preceding creation controls still pass. All three files were restored byte-for-byte and the focused suites rerun green. Logs and hashes are adjacent.

## Actual browser proof

At the maintainer’s request the browser qualification uses WSL Google Chrome, headed, with WebGPU over SwiftShader/Vulkan. The Mac T3 browser could not reach the host. These screenshots claim rendered behavior, not hardware-GPU performance. Both runs canonically load the Bonsai file through the actual file inputs and enter Model through the Author tab. Public `BroadcastTransport.send` calls reach the actual `BimHost`; keyboard Undo targets the active model.

Both one- and two-model runs render the complete 13-part curtain aggregate, a Circle-profile column on actual grid axes, the imported window resize/slide, a 16-riser stair, stair removal/restoration, and railing posts/handrail. One Undo removes each creation or restores the previous physical hosted edit. The final target has zero active new records and the original eight meshes. The peer’s complete captured records, geometry and history are identical at every stage. Raw model/mesh receipts are in `1-browser.json.gz` and `2-browser.json.gz`; `capture.cjs` is the actual producer.

| Stage | One model | Two models |
| --- | --- | --- |
| Baseline | [Bonsai](1-baseline.png) | [Bonsai federation](2-baseline.png) |
| Curtain | [Created](1-curtain.png) | [Created](2-curtain.png) |
| Curtain Undo | [Removed](1-curtain-undo.png) | [Removed](2-curtain-undo.png) |
| Bound column | [Grid/column](1-grid-column.png) | [Grid/column](2-grid-column.png) |
| Window size | [Resized](1-hosted-resize.png) | [Resized](2-hosted-resize.png) |
| Hosted slide | [Moved](1-hosted-slide.png) | [Moved](2-hosted-slide.png) |
| Slide Undo | [Size retained](1-hosted-slide-undo.png) | [Size retained](2-hosted-slide-undo.png) |
| Resize Undo | [Imported restored](1-hosted-resize-undo.png) | [Imported restored](2-hosted-resize-undo.png) |
| Stair | [Created](1-stair.png) | [Created](2-stair.png) |
| Removal | [Removed](1-stair-removed.png) | [Removed](2-stair-removed.png) |
| Removal Undo | [Restored](1-stair-restored.png) | [Restored](2-stair-restored.png) |
| Railing | [Created](1-railing.png) | [Created](2-railing.png) |
| Railing Undo | [Removed](1-railing-undo.png) | [Removed](2-railing-undo.png) |

Two earlier harness mistakes are retained as diagnostics, not green runs: STEP references were compared as numeric IDs, and a command targeted the inactive second model while keyboard Undo targeted the active first. The corrected run normalizes references and targets the active model. The diagnostic curtain screenshot and receipts show that its native parts were already present.

This slice does not close D5 or #6232. Remaining transform/size, topology, copy/array and Room command parity needs separate shared-core work. The browser stair creation here is a public SDK call, not a two-coordinate gesture proof.
