---
"@ifc-lite/export": patch
---

Fix `visibleOnly` export keeping an opening whose host wall was hidden, when the host wall's `IfcRelVoidsElement` was an overlay-created relation that got edited (e.g. `RelatingBuildingElement` repointed) after creation.

`propagateOpeningExclusions` identified an `IfcRelVoidsElement`'s ends by taking the last two entries of `OverlayIndex.refsOf`, which is documented as the UNION of the creation payload and every queued mutation ref, not a positional readout — a mutation ref is appended after both creation-payload refs regardless of which attribute it overrides. Editing the relation after creation therefore shifted "last two" off `(RelatingBuildingElement, RelatedOpeningElement)`, so hiding the new host failed to hide the opening. Overlay-created relations now resolve each end by attribute name (`EffectiveEntityIndex.effectiveAttributeRef`) instead of by position; the byte-scanned (parsed-from-file) path is unchanged.
