---
"@ifc-lite/viewer": patch
"@ifc-lite/viewer-embed": patch
---

The overlay colour tokens are published wherever the viewer store exists, not only by the full viewer app (#5490). The embed's axis helper was transparent because nothing wrote the `--overlay-*` properties there; its arms, labels and origin dot now show the theme's axis colours. A focused clash pair in 3D now changes colour with the theme, so it keeps matching the Clash panel's side dots.
