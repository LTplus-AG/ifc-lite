# Gaussian Splat Captures

The web viewer opens Gaussian splat captures beside IFC models: a photogrammetry or radiance-field reconstruction of a site, a room or an existing building. Load one as the only model or add it to a federation, then hide, isolate, clip and fit it like any other model.

Captures are a released feature with disclosed limits. They are not perfect, and the sections below say where they fall short.

## Formats

| Format | Extension | Notes |
| --- | --- | --- |
| Gaussian PLY | `.ply` | Binary little- or big-endian, with the standard `x y z`, `f_dc_*`, `opacity`, `scale_*` and `rot_*` vertex properties. Spherical-harmonics bands `f_rest_*` up to degree 3. |
| Antimatter15 `.splat` | `.splat` | 32-byte records (position, scale, colour, rotation), degree 0. |

A `.ply` file is told apart by its content, not its name: an ordinary point-cloud PLY (positions and colours) still opens as a point cloud, and a Gaussian PLY opens as a capture whatever it is called. Compressed PLY (`packed_position`), SPZ, SOG and KSPLAT files are not supported.

## Opening a capture

Use any of the usual entry points: **Open**, drag and drop onto the window, **Add model** in the model list, a `?model=` link, or a saved federation setup. All of them go through the same loader and the same checks. The capture is decoded in a background worker and appears in the model list with its splat count.

Select the capture in the model list to see its details in the properties panel: format, file size, splat count, spherical-harmonics degree, placement, calibration, renderer state and the limitations below.

## Orientation and model origin

Captures without an explicit placement default to **Z up**, like point clouds: `(x, y, z)` becomes `(x, z, −y)` in the viewer. The supported Gaussian PLY and `.splat` formats do not declare a standard up-axis. Select a capture in the model list and change **Source up-axis** to **Y up** if its authoring tool already exported Y-up coordinates. The setting affects the whole Gaussian, including its covariance and spherical harmonics. Earlier versions displayed captures without explicit placement using raw identity coordinates. Old saved setups without a placement or axis override now reopen with the Z-up rotation; choose **Source up-axis → Y up** to recover their earlier orientation, then save the setup again.

Ingest subtracts the current IFC/federation render-frame offset after orientation and placement. This includes both the IFC origin shift and WASM RTC offset, through the same shared frame helpers used by IFC and scans. Resident captures follow changes to the shared frame, including when the IFC reference loads after the capture or is removed. Load order in a saved setup does not affect capture placement. This reconciles the render origin; it does not register unrelated coordinate systems, infer units, or fit a reconstruction to the model.

For loader callers, `gaussianUpAxis` selects `z` or `y`. `gaussianPlacement` is an optional column-major adjustment after axis conversion and before automatic origin subtraction. An explicit matrix without an axis option retains its own axis mapping for compatibility with earlier saved placements. Callers must not include the IFC origin subtraction themselves. Saved setups and capture reload preserve the source axes and original placement, then recompute the origin offset on ingest rather than applying the saved render shift twice.

## Limits

These limits are checked before a capture is decoded, so an oversized file is refused straight away with a message saying which limit it exceeds.

| Limit | Value |
| --- | --- |
| Capture file size | 500 MB |
| Splats in one scene (all captures together) | 1,000,000 |
| Spherical-harmonics degree | 3 |
| Graphics | A WebGPU device, as for the rest of the 3D view ([Browser Requirements](browser-requirements.md)) |

The scene limit bounds **logical scene splats**: one share per capture, loaded or still loading. A reload counts once at the larger of its old and replacement counts until the swap commits or rolls back. Temporary renderer allocations can overlap during reload; this is not a strict bound on simultaneous renderer allocations. If opening a capture would take the scene past 1,000,000 splats, it is refused and the message gives the total it would have reached; remove a capture and try again. Removing a capture frees its share straight away.

## Limitations

- **Composition with glass and X-ray is approximate.** Captures are composited after the main pass, over transparent IFC surfaces, so a capture can show through glass or X-rayed elements that should hide it.
- **Clipping is by Gaussian centre.** Section planes and section boxes cull whole Gaussians by their centre. There are no section caps, and a Gaussian's footprint can cross the plane.
- **Captures are uncalibrated.** Axis conversion and render-origin reconciliation do not establish units or survey alignment, and the viewer makes no metric claim about it. With only captures visible, the scale overlay says the scale is unknown.
- **Not pickable.** Clicking a capture in the 3D view does not select it; select it in the model list.
- **No measurement or snapping.** The measure and snapping tools ignore captures.
- **Not included in exports.** IFC, glTF/GLB, USD, KMZ, energy model, PDF, Cesium ion exports leave capture data out; a capture is never offered as an export source, and a merged IFC export skips it. While a capture is loaded, the export dialogs say that captures are not included. BCF viewpoints keep the camera and clipping but do not embed capture data; their snapshot images can show visible captures. Screenshots show what is on screen, captures included.

A saved federation setup records a capture's slot, visibility, source up-axis and an explicitly chosen placement, but not its contents: reopen the setup and select the capture file again.

## When the graphics device is lost

If the browser loses the GPU device, captures wait and upload again once the 3D view recovers. If a capture cannot be restored, its row offers **Reload capture**, which reads it again from the file it was opened from.

## Privacy

The viewer's anonymous usage diagnostics record only the outcome of a capture load (completed, failed, cancelled or refused), a fixed failure code, the format, coarse size and splat-count ranges, and how often the GPU device was lost or recovered while a capture was loaded. They never include file names, paths, URLs, coordinates or capture contents. See [Privacy](privacy.md).
