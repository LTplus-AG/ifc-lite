---
"@ifc-lite/create": patch
"@ifc-lite/cli": patch
---

`derive-structural` guesses fewer supports on flat members at the lowest level. When at least two bearing points hold a flat run (apart, and not all on one line unless the run is), only they get supports, so a truss tie rests on its heels and its overhangs stay cantilevers. A column drawn from a ground beam's top face (more than the tolerance above the lowest level) does not make its node a bearing point. If two other bearing points hold the beam and nothing holds that node from below, the node gets no guessed support. Check columns on ground beams.
