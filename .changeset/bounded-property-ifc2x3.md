---
"@ifc-lite/export": patch
"@ifc-lite/wasm": patch
---

Reject IFC2X3 conversion of an IfcPropertyBoundedValue when neither bound can be carried, and identify the affected record and WR22 rule in the error. Keep a supported bound if its counterpart is dropped (#11117).

Rust callers can use `ifc_lite_export::try_export_merged` to receive the refusal as an error while retaining the existing string-returning merge API.
