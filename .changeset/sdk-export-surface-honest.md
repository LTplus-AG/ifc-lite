---
"@ifc-lite/sdk": patch
---

`bim.export` is documented as what it is. The README and the scripting guide advertised "CSV, glTF, STEP, HBJSON": there is no glTF or GLB method at all, and STEP is spelled `ifc()`. The real set is `csv`, `json`, `ifc` (STEP), `hbjson`, `dfjson`, `download`, and `json`/`dfjson` were not mentioned at all.

The README's only usage snippet was also unrunnable: `createBimContext({ backend: myLocalBackend })` never said where `myLocalBackend` comes from, and `BimBackend` is a 16-namespace interface nobody writes by hand. It now names `HeadlessLikeBackend` from `@ifc-lite/mcp`, the one exported headless backend, with its real arity.
