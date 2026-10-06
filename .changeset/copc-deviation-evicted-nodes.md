---
"@ifc-lite/viewer": patch
---

COPC deviation statistics now follow the nodes that are resident. A view change that only dropped COPC octree nodes, such as the scan leaving the view, never re-ran deviation, so the Deviation panel kept reporting and exporting points that were no longer drawn. Every settled LOD pass that changed the resident chunks now re-runs deviation after its evictions, a pass that changed nothing no longer re-runs it, and a panel readback interrupted by such a re-run is replaced by the refresh instead of showing an error.
