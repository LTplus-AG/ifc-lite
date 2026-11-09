---
"@ifc-lite/viewer": patch
---

When WebGPU support is still being checked, a model you drop or choose with the file input now opens by itself once the check passes. Before, the "WebGPU support is still being checked" card stayed up after a passing check. The Open picker and Start blank are never replayed after a wait, because the browser requires a fresh click for them. For those, a passing check clears the card and its Retry button and you click Open again; this also applies when you pressed Retry and the check passed later. Pressing Retry on a dropped or input-selected file, or on a `?model=` URL, opens it once, not twice. If the resumed open fails, its error appears on the load-error card. If you switch language while a check is running, including the re-check after Retry, the card follows the new language and still changes to "WebGPU not available" when the check fails. A `?model=` URL still waits for the check to finish before loading.
