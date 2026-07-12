---
"@ifc-lite/collab-server": patch
---

The registry merge route accepts edit-in-place resolutions (`{ path, component_key, choice: "edited", attributes }`), strictly validated, with the engine's edited-target rules surfaced as 400s. Completes the conflict-queue spec (08-review.md §8.3) alongside the viewer's new edit choice and bulk actions.
