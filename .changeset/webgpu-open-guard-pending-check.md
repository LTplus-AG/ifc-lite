---
"@ifc-lite/viewer": patch
---

When WebGPU support is still being checked, a model you drop or pick from the file input now opens by itself once the check passes. Before, the "WebGPU support is still being checked" card stayed up after a passing check. The Open picker and Start blank are not replayed, because the browser requires a fresh click for them; for those the card just clears. Pressing Retry while the check is pending opens the model once, not twice. If you switch language while the check is pending, the card follows the new language and still changes to "WebGPU not available" when the check fails.
