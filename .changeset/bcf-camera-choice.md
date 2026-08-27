---
'@ifc-lite/bcf': patch
---

Write BCF viewpoint cameras in the order and cardinality each schema declares, and refuse non-finite numbers rather than writing them.

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

Separately, every number the writer emits under an XSD numeric type is now
required to be finite. `Camera/AspectRatio` was guarded with `!(aspectRatio > 0)`,
and `Infinity > 0` is `true`, so `Infinity` was written verbatim and xmllint
rejected the archive: "Element 'AspectRatio': 'Infinity' is not a valid value of
the atomic type 'PositiveDouble'". The same gap was unguarded on `FieldOfView`,
`ViewToWorldScale`, `Bitmap/Height`, `Topic/Index` and every camera, line,
clipping-plane and bitmap coordinate. `NaN` needs the same guard for a different
reason: `xs:double` accepts the lexical form `"NaN"`, so those archives validate
while carrying a number the reader drops on the way back in. All of these now
throw, naming the field and the viewpoint or topic.

**BCF 3.0 impact on `createBCFFromIDSReport`.** At `version: '3.0'` this
function now has no working configuration. Nothing in this repository populates
`aspectRatio` — `computeCameraFromBounds` sets `fieldOfView` but no aspect
ratio, and `ViewerCameraState` carries none — so a report exported with
`entityBounds` throws on the required `AspectRatio`, and one exported without
them throws on the required camera. Before this change the second case did not
throw; it wrote one schema-invalid `.bcfv` per topic instead. Callers at 3.0
must supply an `aspectRatio` on the camera; BCF 2.1 export is unaffected, and
whether the reporter should synthesise a default aspect ratio is left open
rather than decided here.
