# buildingSMART/IDS Implementer Test Cases

The 318 IDS+IFC pairs in `attribute/`, `classification/`, `entity/`,
`ids/`, `material/`, `partof/`, `property/`, `restriction/`, `tolerance/`
are copied verbatim from
[buildingSMART/IDS](https://github.com/buildingSMART/IDS) under
`Documentation/ImplementersDocumentation/TestCases/` (MIT-licensed; see
`UPSTREAM_LICENSE`).

Each pair is named with one of three prefixes that encodes the expected
outcome when the IDS is run against the IFC:

| Prefix | Expected `IDSSpecificationResult.status` |
|--------|------------------------------------------|
| `pass-`    | `pass` — applicability matches and all requirements satisfy |
| `fail-`    | `fail` — applicability matches but at least one requirement fails |
| `invalid-` | `not_applicable` — no applicable entities (or IDS itself rejects the input as non-conforming) |

The `corpus.test.ts` test runs the entire corpus through our parser +
validator and asserts the resulting status matches the filename prefix.
Parity with buildingSMART's reference implementation is reported as a
single percentage.

## Updating

```bash
cd /tmp && rm -rf IDS-bsi
git clone --depth 1 https://github.com/buildingSMART/IDS.git IDS-bsi
cp -r /tmp/IDS-bsi/Documentation/ImplementersDocumentation/TestCases/* \
      packages/ids/src/__corpus__/buildingsmart-ids/
```

The corpus is generated upstream from a Python DSL (`script.py` files
inside each directory) — never hand-edit individual fixtures here.
