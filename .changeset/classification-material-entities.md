---
"@ifc-lite/viewer": patch
---

"Add Classification" and "Add Material" now create real IFC entities (#5876).

Both dialogs used to store their input as look-alike property sets ("Classification [Uniclass]", "Material [Concrete]"). No exporter, IDS check or downstream tool recognises those as a classification or a material. The dialogs now create an `IfcClassificationReference` (under an `IfcClassification`, reused by name within the session) with an `IfcRelAssociatesClassification`, or an `IfcMaterial` with an `IfcRelAssociatesMaterial`. The attribute layout follows the model's schema (IFC2X3 or IFC4/IFC4X3).

The Properties panel shows the new classification or material straight away, and the exported file carries them as proper relationships. One Undo removes everything a single add created.

Some adds are refused, each with a message:
- a second material on an element that already has one;
- an IFC2X3 model with no `IfcOwnerHistory`, which that schema requires on the new relationship;
- text that would be written as a STEP token (`$`, `#12`, `.ENUM.`).
