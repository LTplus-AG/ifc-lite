---
"@ifc-lite/viewer": patch
---

Ribbon: search moves to the right of the tab strip, and Cloud sources reaches a toolbar.

The inline search field sat immediately after the ribbon tabs, competing with them for the same reading position and sliding sideways whenever the tab set changed. It now docks to the right, beside the rest of the always-on chrome, where a search field is looked for. Load progress and the error line moved to the left of the spacer in the same pass — parked on the right they shoved the search field every time a model started or finished loading.

Cloud sources (CDE integrations) had the ActivityBar rail as its only entry point, the gap Location zones had before #2508. It is now a command on both toolbar styles: a **Cloud sources** button in the ribbon's File tab, where models come from, and a **Cloud Sources** item in the classic strip's Panels menu. Both go through `useWorkspacePanelControls`, so the panel's single-tenant docking, its float/pop-out re-docking and its latched state are the same code on either surface rather than two copies.

Both panels also reach the command palette now. Location zones is the cautionary case: it was wired into both toolbars at #2508 and still never reached the palette, so a fix that looked complete left a third door shut. The store-symbol parity guard cannot see this class of gap — a panel missing from *every* surface leaves the symbol sets identical — so the new test clicks the real control on each of the three surfaces and asserts the panel opened.

Testing the palette needed one harness gap closed: `vite-module-hooks` now serves Vite's `?raw` imports as file text, which is what made `CommandPalette` (via the script templates) unmountable under `tsx --test`.

Ribbon button labels were split between Title Case and sentence case; the minority is now converted (`BCF issues`, `IDS check`, `Edit mode`, `Add element`). The collab room button reads `Room`, matching the classic strip, and the entity-list button reads `Lists`, matching the panel registry and the classic Panels menu.
