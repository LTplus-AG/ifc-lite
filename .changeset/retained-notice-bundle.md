---
"@ifc-lite/wasm": patch
"@ifc-lite/cli": patch
---

Ship a generated THIRD_PARTY_NOTICES.txt in the @ifc-lite/wasm and @ifc-lite/cli
packages. It is a conservative superset that also covers the opt-in retained
engine (NVIDIA SMLib, Emscripten runtime); the retained runtime assets themselves
are still not included in these packages and remain separately deployed. Refs #7955.
A retained engine directory staged before this change lacks THIRD_PARTY_NOTICES.txt
and is rejected with a message naming it; re-stage it with the current
`scripts/stage-cli-retained-engine.mjs`.
