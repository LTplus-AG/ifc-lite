---
'@ifc-lite/renderer': patch
---

`Renderer.pick()` / `pickRect()` no longer drive a destroyed or lost GPU device.

`render()` and `getGPUDevice()` both early-return once the device is gone; the
pick path skipped that contract entirely. A pick is a full GPU round trip that
ends in a `mapAsync` readback, so on a dead device the readback rejects with
`AbortError: Failed to execute 'mapAsync' on 'GPUBuffer': A valid external
Instance reference no longer exists.` Nothing on the pick path is in a position
to handle it — the DOM click/contextmenu listeners that reach it are `async`
functions whose promise nobody awaits — so it escaped as an unhandled
rejection. And because the picker stayed dead, this was not a one-shot teardown
race: it fired again on every subsequent click at a frozen viewport.

`pick()` now resolves `null` and `pickRect()` an empty set once
`isDeviceLost()` is true or the device is uninitialised, mirroring how
`render()` degrades to skipping the frame. The GPU call is never issued, so no
error is being hidden — consumers that want to react to the loss still
subscribe to `onDeviceLost()`.

The entry guard cannot close the window between `queue.submit()` and the map
settling: a pick that was legal when it started is still aborted if the canvas
unmounts, the model reloads (`Renderer.destroy()` ends in `device.destroy()`)
or the driver resets while the readback is in flight — same `AbortError`, same
escaping rejection. `Picker` now treats an `AbortError` from its own readback
as "the device went away" and degrades to no hit. Only `AbortError` is caught:
a validation fault rejects with `OperationError` and still propagates.

Two supporting leaks are closed: `Renderer.destroy()` now also clears the
picker reference held by the internal picking manager (it previously nulled
only its own, leaving the manager pointing at a destroyed picker), and `Picker`
— a public export usable standalone — now honours its own `destroyed` flag in
`pick()` / `pickRect()` instead of only in `destroy()`.
