---
"@ifc-lite/server-bin": minor
"@ifc-lite/server-client": minor
---

Expand the Server data model with **classifications**, **structured materials**,
and **documents**, continuing the `@ifc-lite/parse` parity work (issue #900).

The browser parser exposes these via `extractClassifications` / `extractMaterials`
/ `extractDocumentsOnDemand`, but the server's data model only recorded the bare
`IfcRelAssociatesMaterial` relationship triple (and nothing for classifications or
documents). Now each is resolved into a flat, element-keyed shape on the data
model fetched from `GET /api/v1/parse/data-model/{cache_key}`.

Server (shipped in the `@ifc-lite/server-bin` binary), in `extract_data_model`:

- **Classifications** (`IfcRelAssociatesClassification` → `IfcClassificationReference`):
  element id, code (`Identification`), reference name, location, and the owning
  system name (resolved by walking `ReferencedSource` to `IfcClassification`).
- **Materials** (`IfcRelAssociatesMaterial`): resolves `IfcMaterial`,
  `IfcMaterialLayerSet(Usage)`, `IfcMaterialList`, and `IfcMaterialConstituentSet`
  into per-layer rows — set name, layer index, material name, **thickness in
  metres** (unit-scaled), `IsVentilated`, and category.
- **Documents** (`IfcRelAssociatesDocument` → `IfcDocumentReference` /
  `IfcDocumentInformation`): identification, name, location, description.

Each becomes a new Parquet table appended to the data-model payload. The tables
are appended **after** the existing five, so the format stays backward
compatible — older clients ignore the trailing bytes, and the updated decoder
reads them only when present (no data-model cache-version bump, so no stale-cache
`202` trap; new data appears once a file is reprocessed).

Client (`@ifc-lite/server-client`):

- New `ClassificationAssociation`, `MaterialAssociation`, `DocumentAssociation`
  types; `DataModel` gains `classifications`, `materials`, `documents` (empty when
  served by an older server/cache).

Regression coverage: `data_model.rs` unit tests assert a wall with a two-layer
material set (mm → metre thickness scaling), a Uniclass classification reference
(system name resolved through `ReferencedSource`), and a document reference are
all extracted and element-keyed.
