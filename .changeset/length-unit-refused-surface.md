---
'@ifc-lite/geometry': patch
'@ifc-lite/server-client': patch
---

A model whose length unit is unusable (zero, negative or non-numeric factor) no longer streams as a silent empty model. The geometry stream now emits a `unitRefused` event right after `rtcOffset`, and the viewer shows an error naming the file. Server `ModelMetadata` reports the refusal as `length_unit_refused` (the offending unit's express id) and omits `length_unit_scale` instead of reporting `1`.
