---
"@ifc-lite/viewer": patch
---

Adding a property no longer loses the properties already there (#5672). If an element's properties were opened while a large file was still loading, the edit layer kept reading the half-loaded model, where no element has any property sets yet. The first edit then acted as if the element had only the new property. Adding a property in a new property set hid every other set. Adding a property to an existing set left that set, in the panel and in the exported IFC, with only the new property. Editing and deleting properties were affected the same way. The edit layer now switches to the fully loaded model as soon as it arrives. Views created by scripts and authoring tools also pick up a type's own property sets, as the properties panel always did.
