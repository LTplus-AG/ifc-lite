---
"@ifc-lite/ifcx": patch
"@ifc-lite/parser": patch
---

IFC5 system membership reaches the viewer's Groups tab: the ifcx composer now
emits AssignsToGroup relationship edges from the `bsi::ifc::system::partofsystem`
attribute (group -> member, matching STEP direction), and the on-demand group
member/relationship extractors fall back to the EntityTable when a store has no
STEP byte-span index (IFCX stores ingest with an empty entityIndex.byId).
