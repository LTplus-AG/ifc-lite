---
"@ifc-lite/renderer": minor
---

New `@ifc-lite/renderer/core` entry: the same `Renderer` without point-cloud rendering and BIM ↔ scan deviation, for pages that only draw IFC meshes. A bundle that imports only this entry leaves out the point splat pipeline and shader, the per-asset spatial index, the point picker, eye-dome lighting and the deviation compute pipeline. Its point-cloud and deviation methods throw an error naming `@ifc-lite/renderer`. `import { Renderer } from '@ifc-lite/renderer'` is unchanged and keeps every point-cloud API.
