# Device loss after a completed pick map (#6881)

On 2026-10-12, controlled regular Windows Chrome on the physical console reproduced
an `OperationError` from `GPUBuffer.getMappedRange` on main
`41e8fb44d8d542fa60d0f9ecbe3585a49e7efb6e`. The real public AC20-FZK-Haus IFC
was loaded through the viewer. Two real GPU maps completed; their delivery was
held while the actual GPUDevice was destroyed, then released. Both promises should
return no selection. `before.json` preserves the failure; camera-motion and viewport
resize cancellation already passed.

`after.json` repeats the same three cases on production source
`25fb5cc840ab88c54d4166430e800062c8ec5e15`. Both overlapping picks return null in
each case without an error. Only map completion delivery was gated; GPU rendering,
mapping, device destruction, and the model were real. The owned Chrome cleanup
initially conservatively refused incomplete process observations; the receipts retain
that refusal and the independent successful ownership check and cleanup.

`real-model-oracle.json` records 28 same-submission comparisons on that fixed source:
FZK and buildingSMART Building-Architecture, each at controlled DPR 1 and 2. Five
serial samples (including both canvas borders) and two overlapping picks per run
matched independently copied full-depth and ID texels, decoded IDs and world positions.
This uses the real NVIDIA Blackwell adapter, not a software adapter. Source hashes,
actual viewport/DPR, camera poses, and completed load traces are in the receipt.

The WASM runtime is the official npm `@ifc-lite/wasm@10.4.0` fetched with
`pnpm build:wasm:fetch`, SHA-256
`3912d1046cf6507e7ef6f85a0492a0e54fbb31ae711b85c6e46b6313ffd63312`.
It is not a Rust rebuild of this checkout. Vite served current renderer sources;
unchanged dependency dist trees were reused only where their complete package Git
tree identity matched the previously root-Turbo-built tree.

Bounded root `pnpm test --filter=@ifc-lite/renderer --only --concurrency=1` passed
102 tests, with the renderer test script temporarily narrowed to
`tsx --test src/renderer-render-paths.test.ts` and restored byte-for-byte afterward.
The two new tests cover point and rectangle readbacks plus exactly-once cleanup;
existing tests preserve propagation of live-device OperationError. Changed-file
oxlint and module-size checks passed. Full root typecheck and CI remain pending.

Performance verdict: no speedup claimed or measured. This lifecycle-only follow-up
adds one loss observer per picker and boolean guards, with unchanged shaders, GPU
copy sizes, sampling, and ordinary map submission. It does not qualify the broader
#6881 mounted-hover A/B performance acceptance or close that issue.
