---
"@ifc-lite/wasm": minor
---

Convert solid straight PDF strokes with round caps or round joins into bounded polygonal `IfcAnnotation` contours. Arc subdivision is measured after the complete PDF-to-model affine transform, so the requested metric tolerance also covers nonuniform scale, reflection and shear; unsupported dashes, hairlines and curved centrelines retain their fidelity-report omissions.
