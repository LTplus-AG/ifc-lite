---
"@ifc-lite/cli": minor
---

Commands that read an IFC model accept `oci://host/repository[:tag][@sha256:...]` references and pull the model layer from an OCI registry through `@ifc-lite/oci`. Loopback hosts use plain http, every other host https. Credentials come only from `IFC_LITE_OCI_USERNAME`/`IFC_LITE_OCI_PASSWORD` or `IFC_LITE_OCI_TOKEN`; the layer is capped at 1 GiB (`IFC_LITE_OCI_MAX_BYTES`) and verified against its digest. `clash`, `export` and the retained export no longer fall back to re-reading the model path when the parsed store holds no source bytes.
