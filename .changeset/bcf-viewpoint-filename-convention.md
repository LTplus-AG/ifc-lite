---
"@ifc-lite/bcf": patch
---

Name a topic's first (or only) viewpoint `viewpoint.bcfv`/`snapshot.<ext>` instead of a GUID-prefixed `Viewpoint_<guid>.bcfv`/`Snapshot_<guid>.<ext>`; additional viewpoints in the same topic keep a GUID-qualified name, now as a suffix (`<guid>_viewpoint.bcfv`) rather than a prefix, matching the convention BIMcollab uses. Investigation on #3612 (a BCF export rejected by Solibri while the same topic re-exported by BIMcollab was accepted) narrowed the difference between the two archives to this filename convention -- both forms are schema-legal, since `markup.bcf` names the file explicitly, but a reader that assumes the conventional name rather than following the reference fails on the old prefix form. The markup `<Viewpoint>`/`<Snapshot>` reference and the archive entry are computed from one shared name so the two can never disagree.
