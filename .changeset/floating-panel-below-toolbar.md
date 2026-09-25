---
"@ifc-lite/viewer": patch
---

A floating panel can no longer end up with its title bar hidden under the main toolbar. Panels reopened with a saved position above the window, or taller than the window, and panels dragged up by their header, now stop at the toolbar's bottom edge so the drag handle, dock and close buttons stay reachable (#5957). The Customize sidebar's Reset now resets the whole layout like every other Reset layout entry point, Reset layout on mobile no longer pops the hierarchy sheet open, and the bottom strip keeps its resized height when it reopens after an earlier reset.
