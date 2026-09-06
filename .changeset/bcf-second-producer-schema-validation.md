---
"@ifc-lite/bcf": patch
---

Add a second, independently-produced third-party BCF archive (`test-data/AC20-FZK-Haus_BIMcollabZoom.bcf`, produced by BIMcollab Zoom) alongside the existing buildingSMART/iabi.BCF pair, and validate its `bcf.version`/`project.bcfp`/`markup.bcf`/`.bcfv` entries against the vendored BCF 2.1 XSDs. It also exercises a shape neither our writer nor either existing fixture does: a viewpoint declared only through `<Comment><Viewpoint Guid="..."/></Comment>` rather than a top-level `<Viewpoints Guid="...">` entry. New reader assertions pin that the viewpoint is still recovered and that `comment.viewpointGuid` resolves to it. No source change.
