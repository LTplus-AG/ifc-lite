---
"@ifc-lite/viewer": minor
---

Linked-records assistance (#6920). Linked records is now an assistant source. Attach a specification or the current records as text and the assistant quotes exact passages with source spans. Typed answers appear as native review cards: a SPARQL query that is linted (read-only, declared columns, outer LIMIT) and runs only with the endpoint grant you exercised in the panel, with the credential never shown or sent to the assistant; IFC-to-ontology mappings checked against the revision's model and the profile, saved with a revision pin and shown as historical when that context changes; record projections previewed and applied by the existing projection service; and extracted requirements whose spans are verified character for character, with ambiguous statements kept as unsupported. Saved mappings and requirements live in the native content library, backups and imports.
