---
"@ifc-lite/parser": minor
"@ifc-lite/cli": patch
"@ifc-lite/mcp": minor
---

Add validated STEP/IFCZIP loading with structured record-scan completeness and diagnostic codes. Reuse the parser input validation in the CLI and MCP while preserving tolerant low-level parsing and existing diagnostic messages.

MCP loaders now explicitly refuse truncated or DATA-less STEP envelopes with structured errors instead of returning a prefix model. Recovery tools can continue using the tolerant low-level parser.
