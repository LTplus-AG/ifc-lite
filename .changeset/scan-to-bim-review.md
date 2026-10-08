---
"@ifc-lite/viewer": minor
---

Scan to BIM review (#6894): the Point Clouds panel's "Detect elements" runs plane and cylinder detection on a loaded scan (its retained sample, or the section-box crop) in a cancellable, latest-wins worker and proposes IFC walls, slabs, columns and pipes in the active IFC model's coordinates. The detections are drawn over the scan coloured by proposed class, and a review list accepts or rejects each proposal, or everything shown after filtering by class and confidence.
