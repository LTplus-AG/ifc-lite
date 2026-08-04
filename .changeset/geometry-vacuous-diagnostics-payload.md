---
"@ifc-lite/geometry": patch
---

Extract the streaming `complete` event's diagnostics payload builder (`geometry.worker.ts`'s `emitSessionEnd`) into a standalone `buildGeometryWorkerCompleteMessage` in `diagnostics.ts`, and have the worker call it instead of inlining the conditional spread. No behaviour change: the emitted payload is identical (diagnostics still omitted entirely, not sent as `undefined`, on a clean load). This lets `diagnostics.test.ts` exercise the real production logic directly — the worker module cannot be imported under vitest (it assigns `self.onmessage` at module load time), so the payload shape is now factored out where a plain unit test can reach it.
