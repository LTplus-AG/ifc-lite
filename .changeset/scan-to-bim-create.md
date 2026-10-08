---
"@ifc-lite/viewer": minor
---

Scan to BIM creation (#6894): "Create accepted elements" writes the wall, slab, column and pipe proposals that are accepted and shown by the review filter into the IFC model as one undoable batch through the modelling command stack. Each element goes on the storey it stands on, is placed through that storey's workplane, and carries an `IfcLite_ScanDetection` property set with its provenance (source scan, detection id, basis, confidence, fit RMS, inlier points). The elements appear in the tree and properties panel and export with the model. Created proposals stay marked by GlobalId, also in a reopened export; after "Detect again" the bar warns before creating what this scan already created this session. Create refuses once the scan or the workspace anchor has moved since detection. Without an IFC model, a blank one can be created to hold them.
