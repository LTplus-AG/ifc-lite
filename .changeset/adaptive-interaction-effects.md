---
"@ifc-lite/renderer": minor
---

Keep contact shading and separation lines visible during camera interaction
(orbit/zoom/pan and camera animations) instead of unconditionally disabling
them and popping them back on a settle frame. Adds the optional
`RenderOptions.interactionFrameIntervalMs` so apps that intentionally cap
continuous render cadence (large-model throttles) are judged against their
own schedule rather than display refresh.

An adaptive governor (`InteractionEffectsGovernor`) measures the cadence of
interactive frames: effects stay on while the renderer keeps up with the
display refresh (the post pass costs well under a millisecond on
discrete/Apple GPUs at CSS resolution — Autodesk's viewer likewise keeps
effects on during desktop navigation). On GPUs that measurably miss frames
(integrated GPUs at large canvases), effects degrade for the rest of the
gesture — the previous behaviour — with up to three re-probes before
settling on degraded mode for the session.

Edge contrast is no longer interaction-gated at all: its gated tail is a
handful of ALU ops (the expensive derivative work always ran), so disabling
it bought nothing and only made crease darkening pop around gestures in
orthographic mode.

The viewer app now also requests a settle frame when a camera tween
(Home / view cube / zoom-extent) completes, so the last animation frame can
no longer remain on screen at degraded quality.
