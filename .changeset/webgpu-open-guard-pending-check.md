---
"@ifc-lite/viewer": patch
---

When WebGPU support is still being checked, a model you drop or choose with the file input now opens by itself once the check passes. Before, the "WebGPU support is still being checked" card stayed up after a passing check. The Open picker and Start blank are not replayed, because the browser requires a fresh click for them; for those, and for Retry, a passing check clears the card and its Retry button. Pressing Retry while the check is pending opens the model once, not twice. If the resumed open fails, its error appears on the load-error card. If you switch language while a check is running, including the re-check after Retry, the card follows the new language and still changes to "WebGPU not available" when the check fails. A `?model=` URL is unchanged: it already waits for the check to finish before loading.
