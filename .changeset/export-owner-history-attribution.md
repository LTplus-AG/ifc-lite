---
"@ifc-lite/wasm": patch
---

Export plans and skeletons can attribute their changes to the exporting application. Set `PlanContext::application` (an `ExportingApplication`) and added objects get an `ADDED` owner history owned by it, patched objects get one `MODIFIED` history per original (original owner and creation date kept, last modifier set to the application), untouched objects stay byte-identical, and the header names the application as `originating_system`, `ifc-lite <version>` as `preprocessor_version`, and the change time as `time_stamp`. Relationships an Add extends count as modified. Without an application the output is unchanged and a finding says so.
