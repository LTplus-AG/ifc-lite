---
"@ifc-lite/mutations": patch
---

Declare `CsvConnector.import` with a computed method name so Vite 8's dev-time import-analysis no longer rewrites the method head as a dynamic import (which broke the viewer dev server with a SyntaxError). No API change: the method is still called `import`.
