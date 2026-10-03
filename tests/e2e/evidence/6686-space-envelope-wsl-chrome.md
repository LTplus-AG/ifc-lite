# Space envelope browser evidence (#6686)

Verified with local Google Chrome 153 in WSL, using WebGPU/SwiftShader and
the viewer dev server on port 5190. The real Archicad model was loaded through
the file input: `tests/models/ara3d/AC20-FZK-Haus.ifc`.

Created a 4 × 6 m space on Dachgeschoss, opened **Edit space envelope** from
the command palette, switched to a side section/right view and **Pitched**,
then clicked and moved the ridge handle onto the roof. The shared solver
reported a mesh `endpoint` at storey-local `[5, 3.3867514610290526]`.
A second click committed the two ceiling faces. Reopening the command retained
the pitched shape, with Height 3.386751461 m and GrossVolume/NetVolume
64.641017532 m³. Floor areas stayed 24 m². The JSON records the actual snap,
saved planes and quantities read from the running browser.

![Committed pitched space in the side section](6686-space-envelope-wsl-chrome.png)

Capture note: Chrome's screenshot compositor left the WebGPU canvas transparent,
although the renderer submitted successful draws. For this screenshot only,
the renderer's `captureColorFrame()` pixels were copied into a temporary canvas
background at the same size, retaining the browser's real editor overlay.
The building image is the actual GPU framebuffer; no geometry was illustrated
or reconstructed. This workaround is not a production change.
