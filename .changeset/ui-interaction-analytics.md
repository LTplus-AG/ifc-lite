---
"@ifc-lite/viewer": patch
---

The hosted viewer's anonymous product analytics now record which UI surface was used, so the UX refactor can be measured (#5618): command-palette commands, panel opens and replacements, tool activation and exit, view resets (Home, A, Show all), load errors shown, rejected file opens and onboarding dismissals. Each event carries fixed ids only, and the `before_send` scrubber drops any other property or any value that is not a plain id. Autocapture stays off. Picking an unsupported file through the Open button now explains why, as dropping one already did.
