---
"@ifc-lite/viewer": patch
---

The hosted viewer's anonymous product analytics now record which UI surface was used, so the UX refactor can be measured (#5618): command-palette commands, panel opens (from the ribbon, classic toolbar, sidebar rail, palette or a shortcut) and replacements, tool activation and exit, view resets (Home, A, Show all), load errors shown, rejected file opens and onboarding dismissals. Panels and tools the app opens by itself (tours, loads, drawings) are not counted. Each event carries fixed ids only, and the `before_send` scrubber drops any other property, any person-property update, and any value outside the event's vocabulary. Autocapture stays off. Picking an unsupported file through the Open button now explains why, as dropping one already did.
