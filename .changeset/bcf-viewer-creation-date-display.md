---
'@ifc-lite/viewer': patch
---

BCF topics and comments read from a file that omitted `CreationDate`/`Date` no longer show the import time as their creation date. They now show no date and sort as oldest in the topic list. Exporting a project that contains such a topic now fails with a message naming the topic, rather than writing a `.bcfzip` other BCF tools can reject.
