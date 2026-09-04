---
'@ifc-lite/bcf': patch
---

`createBCFFromIDSReport({ version: '3.0' })` now produces a writable archive.
Computed cameras carry an `AspectRatio` (required by BCF 3.0's `visinfo.xsd`),
taken from a new `aspectRatio` export option that defaults to 16/9, the
convention when no viewport exists. Per-specification grouping frames the union
of the failing entities' bounds instead of getting no camera at all. Without
`entityBounds` there is nothing to compute a camera from, so the export is
refused up front, naming the topic and the option that fixes it, rather than
failing later inside `writeBCF` with only a generated viewpoint GUID to go on.
