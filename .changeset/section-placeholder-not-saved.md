---
"@ifc-lite/viewer": patch
---

Opening the Section tool no longer makes a cut on its own. With the tool open and no cut yet, the background 2D drawing saved the untouched placeholder plane as the model's cut. Resizing the window across a layout breakpoint, or reloading, then restored it as a real, cutting plane A. The placeholder is no longer saved; a cut you make still is.
