---
"@ifc-lite/create": patch
---

Auto Spaces: a wall created in this session now bounds rooms only on the storey it is contained in. `extractWallSegmentsForStorey` used to add every overlay-created divider to whichever storey was being processed, so a wall authored on one storey split rooms on every storey (#5642).
