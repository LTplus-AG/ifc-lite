---
"@ifc-lite/renderer": patch
---

Fix models not rendering on WebGPU implementations that still require a bind group at every slot of a pipeline layout, including empty ones (#9060). Pipeline layouts are padded with empty bind group layouts so that the section-exclusions table sits at group 3. The render, shadow, pick and selection-mask passes now bind an empty group to every padded slot. Previously every frame failed with "No bind group set at group index 2", so nothing appeared.
