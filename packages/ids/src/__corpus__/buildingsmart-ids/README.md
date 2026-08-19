# buildingSMART/IDS Implementer Test Cases

The 318 IDS+IFC pairs in `attribute/`, `classification/`, `entity/`,
`ids/`, `material/`, `partof/`, `property/`, `restriction/`, `tolerance/`
are copied verbatim from
[buildingSMART/IDS](https://github.com/buildingSMART/IDS) under
`Documentation/ImplementersDocumentation/TestCases/`.

**Licence: CC BY-ND 4.0, (c) buildingSMART International Ltd** — see
`UPSTREAM_LICENSE`, which is the upstream repository's LICENSE file copied
verbatim. This paragraph previously said "MIT-licensed" while citing that same
file, which says nothing of the kind; the upstream repository carries no MIT
licence at any level. The likely origin of the error is the sibling corpus in
`src/audit/__fixtures__`, which comes from
[buildingSMART/IDS-Audit-tool](https://github.com/buildingSMART/IDS-Audit-tool)
and genuinely **is** MIT — the attribution pattern was reused and the licence
was not re-checked.

NoDerivatives is the operative term here: these fixtures are redistributed
unmodified, with attribution, and nothing in this repository may edit one. A
test needing a variant of a fixture must build it in memory.

Each pair is named with one of three prefixes:

| Prefix | Meaning | Checked by |
|--------|---------|------------|
| `pass-`    | applicability matches and all requirements satisfy | `validateIDS` -> `status === 'pass'` |
| `fail-`    | applicability matches but at least one requirement fails | `validateIDS` -> `status === 'fail'` |
| `invalid-` | the IDS **document** is not conforming IDS | `auditIDSDocument` -> at least one issue |

The first two ask whether a MODEL satisfies a well-formed IDS. The third asks
whether the IDS FILE is well-formed at all, which is a question for the audit
rather than the validator — running an `invalid-` case through `validateIDS`
returns `fail`, a defensible answer to a different question.

`../corpus.test.ts` runs all 318 pairs on that routing, per specification
rather than per file. Every `pass-` and `fail-` case currently agrees. Of the
27 `invalid-` cases the audit detects 6; the other 21 are listed in
`AUDIT_UNDETECTED` in that file, which may only shrink.

## Updating

```bash
cd /tmp && rm -rf IDS-bsi
git clone --depth 1 https://github.com/buildingSMART/IDS.git IDS-bsi
cp -r /tmp/IDS-bsi/Documentation/ImplementersDocumentation/TestCases/* \
      packages/ids/src/__corpus__/buildingsmart-ids/
```

The corpus is generated upstream from a Python DSL (`script.py` files
inside each directory) — never hand-edit individual fixtures here.
