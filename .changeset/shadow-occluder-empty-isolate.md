---
"@ifc-lite/renderer": patch
---

Fix sun shadow occluder collection treating an active-but-empty isolation set the same as no isolation, which let a fully isolated-out textured mesh or standalone mesh keep casting a phantom shadow instead of casting nothing.
