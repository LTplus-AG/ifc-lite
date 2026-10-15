# Fixture privacy and licence review, 15 October 2026 (#6928)

Prepared by an AI agent for a human sign-off. **This is not the human review the manifest records**: every fixture's `privacy.human.status` stays `pending` until a person confirms or overrides the findings below and adds themselves as reviewer.

Method: every IFC file was searched for `IFCPERSON`, `IFCORGANIZATION`, `IFCPOSTALADDRESS`, `IFCTELECOMADDRESS`, `IFCACTOR`, `IFCAPPLICATION`, the STEP `FILE_NAME` header, site coordinates, and e-mail or phone patterns. Pattern `=\s*IFCX(` catches both `#1=IFCX(` and ArchiCAD's `#1= IFCX(`. The IDS and native result were read in full. Licence evidence is the existing provenance receipts in this folder.

| Fixture | Personal data found | Licence evidence | Proposed decision |
|---|---|---|---|
| `sample-architecture` | `IFCPERSON` "Jan B." with organisation buildingSMART International (owner history). Abbreviated name, no contact data. STEP header author and organisation empty. Sites are fictional ("idyllic hilltop house"), no coordinates. | CC BY 4.0, byte-identical to the buildingSMART Certification-datasets download ([receipt](sketchup-licence-provenance.json)). | Accept. The name is the publisher's own attribution in a public dataset; removing it would break byte identity with the publisher file. |
| `sample-architecture-rev-b` | Same "Jan B." record, plus an empty `IFCPERSON` and organisation "ifc-lite" added by the derivation. | Derived from the CC BY 4.0 base; attribution retained ([receipt](sketchup-licence-provenance.json)). | Accept, as above. |
| `sample-ids` | None. Author is "ifc-lite". | Authored in this repository (MPL-2.0). | Accept. |
| `native-clash-rev-b` | None. Engine output: GlobalIds, element names, distances. | Derived from `sample-architecture-rev-b`. | Accept. |
| `fzk-haus` | `IFCPERSON` and `IFCORGANIZATION` are "Nicht definiert" (not defined). Descriptions credit "KHH / IAI / FZK" (publisher institute). Site at 49°6′1″N 8°26′11″E, the public Karlsruhe research campus. `FILE_NAME` path is a publisher network drive; author and organisation scrubbed. | KIT publisher terms permit unrestricted use with IAI/KIT credit ([receipt](fzk-licence-provenance.json)). | Accept, with the IAI/KIT credit wherever results are published. |

## Gap found in the automated scan

`privacyFindings` (`scripts/ai-eval/lib/manifest.mjs`) checks only the STEP `FILE_NAME` header, e-mail addresses and credential-like tokens. It does not see `IFCPERSON` or `IFCORGANIZATION` records in the data section, so the "Jan B." record above passes the automated scan. Extending the scan is a separate change.

## To complete

A maintainer reads this table, records any disagreement, and sets each fixture's `privacy.human` to `{ "status": "complete", "reviewers": ["<pseudonym>"] }` in `tests/ai-eval/manifest.json`.
