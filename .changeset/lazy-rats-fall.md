---
"@ifc-lite/sdk": minor
"@ifc-lite/export": minor
---

Add optional IFC datatype declarations to direct SDK property mutations, validated against the exporter's existing IfcValue schema and domain rules. Specific measures, including whole-number IfcThermalTransmittanceMeasure values, retain their declarations through headless/viewer overlays and STEP export. Existing four-argument calls retain their original primitive inference. Expose the shared declaration validator for the SDK and collaboration adapter consumers.
