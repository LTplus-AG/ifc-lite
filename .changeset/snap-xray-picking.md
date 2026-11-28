---
"@ifc-lite/viewer": minor
---

X-ray while picking points (#11518). In Measure and during a Reposition pick, the `O` key or the X-ray toggle renders every model see-through and lets the corner snap reach corners hidden behind other geometry. It is derived from the store rather than written into the ghost channel, so turning it off restores the previous appearance.
