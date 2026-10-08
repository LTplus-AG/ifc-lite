# 05: "Identifiers should be unique", but nothing checks it

**Upstream:** buildingSMART/IDS#339 "Specification short code/identifier"
(open; resolved as documentation by PR #369).

## The ambiguity

#339 asked for a user-facing short code per specification. The outcome was
documentation: the existing `identifier` attribute is that code, and the
user manual (`ids-metadata.md`) now says it "should be unique within an IDS
file". "Should" leaves two questions open: is a file with duplicates valid,
and may tools rely on uniqueness? #339 itself notes that identifiers stop
being unique as soon as specifications are copied between files.

```xml
<specification name="Doors rated" ifcVersion="IFC4" identifier="FIRE-01">…</specification>
<specification name="Walls rated" ifcVersion="IFC4" identifier="FIRE-01">…</specification>
```

## What ifc-lite does, and why

- The IDS 1.0 audit accepts the file: the XSD has no uniqueness constraint
  and the manual says "should".
- The IDS 1.1 preview audit adds a **warning**,
  `W_IDS11_IDENTIFIER_DUPLICATE`, on the second use
  (`packages/ids/src/preview/ids11-preview.test.ts`).
- A finding for ifc-lite itself: `parseIDS` uses `identifier` as the
  in-memory specification id when present, so two specifications sharing an
  identifier also share an id. That is safe only while no consumer keys on
  it; it is recorded as a follow-up in the P-12 work log rather than changed
  here, because the default parse must stay as it is.

## Proposed resolution

1. Keep "should": a duplicate does not make a file invalid.
2. Say in the implementers' documentation that audit tools may report a
   duplicate as a warning, and that reports must not identify specifications
   by `identifier` alone.
3. No corpus case: the corpus convention is one specification per file, and a
   warning has no verdict to test.
