---
"@ifc-lite/parser": patch
"@ifc-lite/viewer": patch
---

Inherited type quantities now show on large models such as a 170 MB tower with 80,276 typing and definition relationships, or a 340 MB building with 92,432 (#9192). The current type-quantities read refused any model past 65,536 such relationships, so the Properties panel said inherited quantities were unavailable there. Since it now reads them from the parsed relationship graph, a first read on those models takes about 0.1 s, and the limit is raised to 131,072. The 262,144 reference budget is unchanged: the largest model needs 140,475. A model past either bound still refuses, and the reason now names the bound it crossed.
