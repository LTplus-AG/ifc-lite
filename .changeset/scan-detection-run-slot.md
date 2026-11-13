---
"@ifc-lite/viewer": patch
---

Scan element detection now ends with the session it started in. Loading a new model while detection was still running used to leave the detection worker running, and its proposals then appeared in the new session. Now the worker stops and the late result is dropped. The same applies when a model the run reads is replaced. Detection runs also show in the activity tray, with their stage and outcome, and the tray's Cancel stops them.
