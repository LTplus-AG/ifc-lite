---
"@ifc-lite/load-trace": minor
"@ifc-lite/geometry": patch
---

Allow worker trace hosts to complete a named span when flushing before a terminal event. Publish geometry prepass scan spans before the host terminates the worker, preserving the measured scan duration and pending counters without duplicate spans.
