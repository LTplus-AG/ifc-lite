---
"@ifc-lite/bcf": patch
---

Fix a zip-slip hazard in `writeBCF`: a viewpoint GUID is parsed unvalidated from untrusted markup XML on read, and was used verbatim in the `Viewpoint_<guid>.bcfv` / `Snapshot_<guid>.*` zip entry names. A crafted GUID containing `../` on a read-modify-save (e.g. `ifc-lite bcf add-comment`) could write a zip entry outside the archive root. The topic GUID already went through a sanitizer for the same reason; the viewpoint GUID now goes through the same sanitizer, computed once per viewpoint so the markup `<Viewpoint>` filename reference and the actual zip entry always agree.

ifc-lite's own reader is in-memory and unaffected by this; the risk is a re-exported `.bcfzip` containing entries with literal `../` segments that could escape the archive root in a downstream tool that extracts entries by joining names onto a directory.
