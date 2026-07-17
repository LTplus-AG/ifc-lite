---
'@ifc-lite/pointcloud': minor
'@ifc-lite/renderer': minor
---

Point cloud classification toggles (#1783). `@ifc-lite/pointcloud` now aggregates a per-class point histogram during streaming decode (`streamPointCloud`'s `onComplete` gains a `classCounts` argument) and exports the ASPRS class-name table plus aggregation helpers (`lasClassificationName`, `createClassificationCounts`, `accumulateClassificationCounts`, `classificationCountEntries`). `@ifc-lite/renderer` extends the splat shader's class-visibility mask from 32 bits to the full 256-bit LAS code range, so user-defined classes (64-255) can be hidden too; `PointCloudRenderOptions.classMask` accepts either the legacy 32-bit number or up to 8 mask words.
