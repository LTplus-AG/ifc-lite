---
'@ifc-lite/bcf': patch
---

Write BCF viewpoint cameras in the order and cardinality each schema declares.

`visinfo.xsd` disagrees between versions, and the writer followed neither:

- BCF 2.1 lists `OrthogonalCamera` before `PerspectiveCamera` in
  `VisualizationInfo`'s `xs:sequence`. The writer emitted the perspective
  camera first, so a viewpoint carrying both cameras produced a `.bcfv` that
  fails 2.1 validation ("Element 'OrthogonalCamera': This element is not
  expected"). Both cameras are now written orthogonal-first.
- BCF 3.0 replaced that pair with an `xs:choice` carrying no `minOccurs` and no
  `maxOccurs` — exactly one camera, required. The writer emitted both when both
  were set, and none when neither was; the latter is what `createBCFFromIDSReport`
  produces for every failing entity whenever no `entityBounds` are supplied.
  Writing a 3.0 archive now fails with an error naming the viewpoint rather than
  producing markup no conforming reader has to accept.
