---
'@ifc-lite/bcf': patch
---

The reader treated an omitted `<Visibility>`/`DefaultVisibility` attribute as `true` for every BCF archive, but visinfo.xsd only leaves that undefined for 2.1 — 3.0 declares `default="false"`. A spec-legal 3.0 viewpoint that omits the attribute (meaning "show only the listed exceptions") was silently read as "show everything," inverting the archive's actual visibility state on import. The reader now resolves the omitted-attribute default per the archive's own `bcf.version`; a 2.1 archive with the same omission is unaffected. ifc-lite's own writer always emits the attribute explicitly, so this could not surface from a self-round-trip — only from a third-party BCF 3.0 file.
