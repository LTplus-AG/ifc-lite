---
"@ifc-lite/renderer": minor
---

The selection outline and the hover pre-highlight now cover GPU-instanced elements (repeated windows, doors, furniture, fasteners), not just flat meshes ([#5745](https://github.com/LTplus-AG/ifc-lite/issues/5745)). Before, a selected instanced element got the blue fill but no outline on its visible silhouette, no dimmed outline where it was hidden behind other geometry, and hovering one drew nothing.

The selection/hover mask pass gains an instanced variant. It draws each template once with the same vertex stage and instance buffer layout as the main instanced draw, and its fragment stage keeps only the selected occurrences (the per-instance selected flag) or those whose entity id matches the hovered id (a small uniform). It writes into the same `maskVisible` / `maskAll` targets, so the outline composite is unchanged. It keeps the same section-plane / clip-box cut and the same slope-tolerant depth test as the flat mask, and skips hidden occurrences.
