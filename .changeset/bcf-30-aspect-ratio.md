---
'@ifc-lite/bcf': patch
'@ifc-lite/renderer': minor
---

Let a caller supply the viewport aspect ratio a BCF 3.0 camera requires.

`v3_0/visinfo.xsd` makes `<AspectRatio>` a required child of both camera types
and the writer refuses to invent one, but `ViewerCameraState` had no field for
it. Every viewpoint `createViewpoint` produced was therefore unwritable as BCF
3.0, and `writeBCF` throws for the whole archive on the first such camera, so a
single captured viewpoint meant no export at all. `ViewerCameraState` now
carries an optional `aspectRatio` that `cameraToPerspective`/`cameraToOrthogonal`
pass through and `perspectiveToCamera`/`orthogonalToCamera` return. A caller
that supplies nothing still gets no `AspectRatio`, as BCF 2.1 requires.

`@ifc-lite/renderer` gains `Camera.getAspect()`, which reports the ratio the
projection is built from. That is the drawing buffer's ratio, not the CSS box's
(the render loop floors canvas width to a multiple of 64 for WebGPU texture row
alignment), and it is the one BCF wants: a viewpoint's snapshot PNG comes from
the same buffer, so the written ratio describes the image actually in the
archive.
