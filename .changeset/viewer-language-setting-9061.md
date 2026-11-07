---
"@ifc-lite/viewer": minor
---

Choose the UI language in Settings → General → Language (#9061). The options are "Auto (browser language)" and each shipped locale under its own name. The choice applies without a reload and is remembered on this browser. "Auto" forgets the choice and follows the browser's languages again. If site data is blocked, the choice lasts for the session only. The undocumented `?lang=` URL parameter is removed: it no longer selects or pins a language.
