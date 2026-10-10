# ids-flow: canvas dropped, what we still harvest

**Decision (2026-10-08):** no node/graph canvas in IDS Studio. The visual surface is outline + inspector + grid + live 3D (ADR-007).

ids-flow (`louistrue/ids-flow`, package `idsedit`, AGPL-3.0, Next.js 15 + @xyflow/react 12) is owned by Louis. Harvesting ideas needs no relicensing. **Copying code into MPL-2.0 ifc-lite requires relicensing** those files: the owner can do this if no outside contributors hold copyright in them (check `git log` authors first). Default: re-implement, don't copy.

## Harvest list

| Item | ids-flow location | Use in Studio | How |
|---|---|---|---|
| ~25–27 spec templates (Safety, Energy, Structure, Space…) | `lib/templates.ts` | Seed the template gallery (P-03) | Re-author as `StudioDocument` op batches. Validate each against the current schema tables (some may predate the IFC4X3 tables) |
| Enumeration editors: chips, list, bulk-paste modal, import dialog | `components/enumeration-editors/` | Value editor for `enumeration` restrictions | UX pattern only |
| "Convert to restriction" hint for bracketed lists (`[a,b,c]` typed into a value) | `inspector-panel.tsx` | Inline lint `IDSL-VAL-003` + quick fix | Rule |
| Facet colour coding + R/O/P cardinality badges | `lib/facet-colors.ts`, node cards | Outline row styling | Design tokens |
| Click validation issue → jump to node + highlight field | `use-ids-validation.ts` | Diagnostics → focus field in inspector | Pattern |
| Printable HTML report | `lib/ids-report.ts` | Superseded by the readable export (P-09) | Idea |
| Docs site (`ids-docs/*.md`) on IDS concepts | `ids-docs/` | In-product "Learn" drawer + glossary | Content, if relicensed |
| Drag-and-drop IDS onto the editor | page | Same in Studio | Pattern |

## Known ids-flow defects (don't port)
- Restrictions only on `value`, and only one per facet. Restrictions on names/pset/system are lost on import.
- Likely bug: applicability facets with restrictions are dropped on export (`groupNodesBySpecification`). Unverified.
- No facet groups; sessionStorage-only persistence; manual `takeSnapshot()` undo; two lockfiles; build ignores type errors.

## Existing editor — decision D1
The existing editor remains separate from the Studio architecture. Its domain, migration and launch strategy are recorded in the owner’s private plan package (ADR-014). This public harvest note authorizes neither a redirect nor code relicensing.
