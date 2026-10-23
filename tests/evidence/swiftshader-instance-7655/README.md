# SwiftShader external-instance loss (#7655)

The reproduced hosted failure starts when WebGPU acquires a canvas swap
texture. The launch configuration selected SwiftShader for Vulkan but left
ANGLE attempting an unavailable X display. Shared-image creation failed;
the browser destroyed the live device and pending Dawn callbacks reported
the missing external instance. Adding only `--use-angle=swiftshader` removed
the failure in the initial isolated comparison.

This is correctness evidence, not a throughput claim. Both runs below used
source `c8e80011cf8846db8c1430e86de9a2aa8fb56762` and Chrome Headless Shell
`156.0.8078.4` on the hosted Linux runner. Their artifacts and browser stderr
are attached to the linked workflow runs.

## Observed sequence

[Full-viewer diagnostic run 39803665116](https://github.com/LTplus-AG/ifc-lite/actions/runs/39803665116)
loaded FZK and Snowdon through the ordinary frame rig. The compact
[device-events.json](./device-events.json) copies the recorded device events
for both attempts, without changing timestamps or IDs. Each page has its own
device-ID sequence.

For **both** fixtures, the trace records one requested and created device
(ID 1), a quantized pipeline request on device 1, device 1 lost with reason
`destroyed`, and then that pipeline rejected with the external-instance
message. There is **no JavaScript device-destroy call** before those events;
capture ends before context teardown. The browser stderr records ANGLE's
failure to open the default X display, followed by failure to find a
`SharedImageBackingFactory` for `WebGPUSwapBufferProvider` and
`SharedImageStub: Unable to create shared image` immediately before device
loss.

This disproves the stale, deliberately destroyed probe-device explanation
for these attempts: the failed probe belongs to the same live device used by
the renderer. It does not establish that every historical external-instance
message had this cause.

[Isolated diagnostic run 39803660353](https://github.com/LTplus-AG/ifc-lite/actions/runs/39803660353)
used a 64-by-64 canvas, no IFC loader, no React, and no renderer recovery.
With the original flags, a simple asynchronous pipeline and validation scope
succeeded before canvas acquisition. After `getCurrentTexture()`, the device
was lost; simple, f32 and quantized pipelines, queue completion and buffer
readback failed. With only `--use-angle=swiftshader` added, every step passed,
including exact same-device readback of `0x7655`. Both arms reported the
Google SwiftShader adapter. The script snapshots loss and events **before**
its final `device.destroy()`, excluding cleanup as the cause.

The reproducer is [swiftshader-instance.mts](../../../scripts/perf/diagnostics/swiftshader-instance.mts).
Its successful pre-canvas pipeline and failing post-canvas pipeline isolate
presentation setup rather than quantized shader contents as the trigger.

## Browser implementation supporting the causal chain

These are version-pinned implementation references, not an assertion that
every internal transition was separately instrumented. Chrome
[`156.0.8078.4/DEPS`](https://chromium.googlesource.com/chromium/src/+/156.0.8078.4/DEPS)
pins Dawn to `0a2c7df818e285d6db0f085135139cda04cee8bb`.

- [Shared-image factory initialization](https://chromium.googlesource.com/chromium/src/+/156.0.8078.4/gpu/command_buffer/service/shared_image/shared_image_factory.cc#266)
  depends on the GL context for relevant backing factories. A failed image
  creation reaches [SharedImageStub's error path](https://chromium.googlesource.com/chromium/src/+/156.0.8078.4/gpu/ipc/service/shared_image_stub.cc#220),
  whose [OnError stops the channel](https://chromium.googlesource.com/chromium/src/+/156.0.8078.4/gpu/ipc/service/shared_image_stub.cc#623).
- [GpuChannel::Stop](https://chromium.googlesource.com/chromium/src/+/156.0.8078.4/gpu/ipc/service/gpu_channel.cc#796)
  destroys the channel. [WebGPUDecoderImpl::Destroy](https://chromium.googlesource.com/chromium/src/+/156.0.8078.4/gpu/command_buffer/service/webgpu_decoder_impl.cc#1211)
  destroys known devices without requiring a JavaScript `GPUDevice.destroy()`
  call. [Dawn device destruction](https://dawn.googlesource.com/dawn/+/0a2c7df818e285d6db0f085135139cda04cee8bb/src/dawn/native/Device.cpp#570)
  reports the `Destroyed` reason.
- [Dawn wire disconnection](https://dawn.googlesource.com/dawn/+/0a2c7df818e285d6db0f085135139cda04cee8bb/src/dawn/wire/client/Client.cpp#159)
  destroys event managers. [Event-manager shutdown](https://dawn.googlesource.com/dawn/+/0a2c7df818e285d6db0f085135139cda04cee8bb/src/dawn/wire/client/EventManager.cpp#114)
  completes pending events; [pipeline cancellation](https://dawn.googlesource.com/dawn/+/0a2c7df818e285d6db0f085135139cda04cee8bb/src/dawn/wire/client/Device.cpp#134)
  supplies the external-instance message. [Blink's callback handling](https://chromium.googlesource.com/chromium/src/+/156.0.8078.4/third_party/blink/renderer/modules/webgpu/gpu_device.cc#455)
  exposes that cancellation as a pipeline error.

## Why the old health verdict was wrong

The baseline viewer artifact reported `completed: true`,
`gpuHealth.contaminated: false`, `deviceLost: 0`, and `deviceReplacements: 0`
for both fixtures, despite the directly observed device losses. Both the
renderer callback and health metering excluded any loss with reason
`destroyed`, treating the reason as proof of application-owned teardown.
The browser can destroy the device too.

The fix uses the owning wrapper's lifetime to exclude intentional teardown
and stale callbacks. A loss of its current device now notifies recovery and
counts as contamination even when the reason is `destroyed`. The console
classifier now counts every renderer loss line, including that reason;
owned teardown is suppressed at the source by its retired lifetime. The
forwarded Renderer/Viewport loss signals and ownership-aware counter also
identify unexpected destruction.

Diagnostic frame output is explicitly ineligible for the performance ratchet.
Neither passing frame assertions nor absence of page errors proves the GPU
remained usable; the baseline above demonstrates why device ownership and
actual readback matter. Historical contamination rates based on the old
classifier are undercounts, not comparable corrected rates.

## Repeated isolated comparison

[Run 39807126499](https://github.com/LTplus-AG/ifc-lite/actions/runs/39807126499)
ran five interleaved original/fixed pairs on source
`d4c1b43b5906f8c6211eee75128cee1a1eaa982c`, Chrome Headless Shell
`156.0.8078.4`. All five original cases lost the device after canvas
acquisition; all five fixed cases passed every pipeline, queue and exact
readback check with no loss. [isolated-comparison.json](./isolated-comparison.json)
preserves every result field, normalizing the common browser and flags once,
and records the original artifact SHA-256. The fixed arm uses the production
frame-rig flags; the original arm removes only the ANGLE selection.

An earlier repeat [39806705474](https://github.com/LTplus-AG/ifc-lite/actions/runs/39806705474)
stopped when the original configuration failed before returning an adapter.
The reproducer now retains such early original-arm failures and continues
the comparison; any fixed-arm failure still fails the workflow.

## Regression checks

[CI run 39807116812](https://github.com/LTplus-AG/ifc-lite/actions/runs/39807116812)
on `d4c1b43b5906f8c6211eee75128cee1a1eaa982c` passed typecheck and
[package-test shard 2](https://github.com/LTplus-AG/ifc-lite/actions/runs/39807116812/job/119928987302),
including the #7655 renderer tests for unexpected destruction, quiet owned
teardown, and suppression of stale loss callbacks. These unit tests exercise
the ownership contract; the isolated browser comparison above exercises real
WebGPU pipeline creation and readback.

## Post-fix frame qualification

[Run 39805007130](https://github.com/LTplus-AG/ifc-lite/actions/runs/39805007130)
on `90ceda88b24f6c23d6a1fea4bf86132927d7d152` completed five ordinary
FZK/Snowdon cohorts: **10/10 fixture attempts passed first try, 0/10
contaminated**. All ten recorded zero losses, replacements, instance errors,
uncaptured errors and page errors. There were no refused attempts. Each of
the five artifacts passed the existing complete-evidence admission check.
[frame-qualification.json](./frame-qualification.json) preserves every sample
health/readiness field and the SHA-256 of each complete artifact.

The source contains the final renderer ownership and launch-flag changes.
Later changes tightened the console-only classifier and adjusted diagnostic
orchestration; they did not change the renderer/viewer production code. The
qualified samples have no health events at all, so none rely on the old
console exclusion. This is a same-build reliability measurement, not a
base-versus-branch performance comparison or a new performance baseline.

The workflow originally requested ten cohorts. Each completed cohort took
6.6–6.9 minutes; it could not finish all ten inside the one-hour job budget.
Cancellation retained five complete artifacts. Cohort six was interrupted
and produced no result; cohorts seven through ten never ran. **The workflow
as a whole is cancelled, not green; only the ten completed attempts above
are claimed.** Future qualification requests five cohorts and bounds that
step to 45 minutes so cleanup can upload partial evidence before the job
limit. No sampling window, per-test assertion or retry rule was relaxed.

## Merge requirements

The issue's causal reproduction, fix/regressions and contamination
re-measurement are now recorded. Required checks and merge remain necessary
before closure. E2E smoke shard 1 reached its 13-minute aggregate cap after
30 passing tests, interrupting test 31; it did not report an assertion
failure. The suite is split into eight shards, preserving its assertions,
retries and time limits, and needs a green rerun. No general Chromium/Dawn
fix, zero future failure probability, or throughput improvement is claimed.
