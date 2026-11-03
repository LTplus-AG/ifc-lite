---
'@ifc-lite/viewer': minor
---

Settings → Performance → Geometry kernel chooses Exact (default) or Retained (experimental) and is now saved per browser; `?kernel=` in the address still overrides it for one tab, and "Reload with exact kernel" switches only the current tab. A new `VITE_RETAINED_GEOMETRY=lazy` build offers this choice while keeping every retained file out of the startup bundle: the retained code, the engine and its notices are downloaded only after Retained is chosen.
