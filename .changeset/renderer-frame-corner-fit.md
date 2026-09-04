---
"@ifc-lite/renderer": patch
---

Frame Selection and Zoom Extents now frame far enough out to keep every corner of the box on screen, in both perspective and orthographic mode, and the ViewCube presets do the same in perspective. The fit came from the box's largest side measured at its centre, which ignores both the near half of the box and the direction it is seen from, so an oblique or portrait framing could crop the selection. Frame Selection also took its view direction from a mis-indexed read of the view matrix, which mirrored the camera on an ordinary orbited pose; it now uses the pose the camera is in.
