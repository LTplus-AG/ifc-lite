---
'@ifc-lite/source-autodesk': patch
---

Explain when no Autodesk hub has authorized the app instead of showing an empty project list. APS reports these hubs as 403 warnings in a successful response; the provider now raises an `app-not-authorized` error pointing to Custom Integrations, while linked Forma Site Design projects stay listed.
