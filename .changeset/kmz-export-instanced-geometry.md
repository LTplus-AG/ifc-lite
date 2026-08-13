---
"@ifc-lite/viewer": patch
---

KMZ export no longer ships a model with its repeated geometry missing.

`buildKmzForResolvedGeoref` was handed `geometryResult.meshes`, which holds only part of the model: GPU-instanced occurrences render from compact shards and are deliberately absent from that flat list. Both surfaces that export a KMZ — the Export KMZ dialog and the Location panel's "Google Earth" button — passed it, so a tower whose facade is repeated panels exported to Google Earth as bare floor slabs. Same defect #2576 fixed for the on-screen world view, in the file the user hands to someone else.

The complete set is now derived inside the shared builder, from a `geometryResult` rather than a mesh array, so there is no way for a call site to pass a pre-flattened list — the same reason the builder refuses a pre-guarded conversion. Callers pass `isPrimaryModel` alongside it, since instanced shard occurrences live in the primary model's id space and a federated model must not adopt them.
