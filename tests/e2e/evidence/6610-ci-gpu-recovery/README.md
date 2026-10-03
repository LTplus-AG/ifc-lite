# #6610 takeover CI GPU-loss qualification

B head `f87e5f936`, CI run [37115047201](https://github.com/LTplus-AG/ifc-lite/actions/runs/37115047201), browser shard 1 job `111181399019`: the 1 km coplanar-plates fixture failed at `drawnHash(#38)` because the renderer had no flat color. This is a generated IFC geometry invariant (#6729), not a document layout test.

The actual trace records unknown device loss at monotonic time 562424.964, renderer halt, and `drawnHash(#38)` at 563504.045. The model decoded 47 meshes. The screenshot shows the device-loss/recovery notifications and missing scene upload. Neighboring guarded phases skipped on the same GPU failure class. The unguarded draw-owner assertion was before the existing pixel-phase guard.

The repair carries the identical `c2ed1566b` whole-body `requireLiveGpu` guard and private-server startup cleanup used by the lower #6232 work. The existing shared `gpu-device-loss.ts` is unchanged; no second loss detector or rendering implementation is introduced. All geometry/pixel assertions remain. No production source changes.

Actual WSL Chrome root-script controls on the repaired test sources:

- Healthy `E2E_GPU_STRICT=1` 1 km coplanar fixture: one passed, zero skipped; pixel/annotation/selection/override assertions executed.
- Forced unknown loss, `E2E_GPU_STRICT=0`: one skipped, exit 0, with exact injected device-loss evidence.
- Same forced loss, `E2E_GPU_STRICT=1`: one genuine failure at the renderer-color assertion, exit 1, no skip. The strict trace confirms the injected loss and failed recovery (`forced-strict-events.json`).
- Healthy strict clip-plane fixture using the private Vite server: one passed, zero skipped; near/far clipping assertions executed and server closed.

Commands used root `pnpm test:e2e:ci tests/e2e/ortho-depth-nudge.e2e.spec.ts`, private `PLAYWRIGHT_PORT=7994/7995/7996`, and `--grep 'coplanar plates.*1 km'` or `--grep 'never moves a vertex'`. Logs retain setup warnings and exact outcomes. Slow discovery/startup is included in elapsed time. Hosted loss is an explicit missing-GPU result, never a healthy-rendering claim. Required CI still must rerun green before merge.
