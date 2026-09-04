---
'@ifc-lite/bcf': patch
'@ifc-lite/renderer': patch
---

Let a caller supply the viewport aspect ratio a BCF 3.0 camera requires.

`v3_0/visinfo.xsd` makes `<AspectRatio>` a required child of both camera types
and the writer refuses to invent one, but `ViewerCameraState` had no field for
it. Every viewpoint `createViewpoint` produced was therefore unwritable as BCF
3.0, and `writeBCF` throws for the whole archive on the first such camera, so a
single captured viewpoint meant no export at all. `ViewerCameraState` now
carries an optional `aspectRatio` that `cameraToPerspective`/`cameraToOrthogonal`
pass through and `perspectiveToCamera`/`orthogonalToCamera` return, and
`Camera.getAspect()` exposes the live viewport ratio the viewer feeds it. A
caller that supplies nothing still gets no `AspectRatio`, as BCF 2.1 requires.
