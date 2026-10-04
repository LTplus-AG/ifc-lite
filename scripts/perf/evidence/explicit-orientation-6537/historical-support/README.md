# Historical support originals

The eleven original manifests, readers and previous Markdown are retained verbatim. Their status prose is historical, superseded by the rejection verdict. Existing payload archives remain outside this support container at their published paths.

- Container: `receipts.tar.gz`, 55,456 bytes.
- SHA-256: `7aa6bf4764a5707f6c91b5df603187587f70c4f060bf71e9dbea83cd8d0e17bb`.
- Index: `cohort-index.json.gz`, deterministic compressed JSON.
- Index gzip SHA-256: `3f5156a8d83a45e79a99d595a53f5dca70afb81f8fe386e41d859fce0421562c`.
- Internal manifest: `packet-member-manifest.json`.
- Manifest SHA-256: `1a77784c4e63936c8240f1ec2a2fa12102c000f1c23fbd59bd37985dd2b381e3`.
- Logical members: 11; 296,284 logical bytes.
- Stored TAR members: 12, including the internal manifest.

The data-only codec is the previously qualified child reader, SHA-256
`198ed395efe99b409a7eb9507188800c0e399c048ce8b9264e749fdca1971535`.
It is retained inside historical-support as `cohort_archive.py`, not installed
or automatically executed. No new executable reader or implicit dependency on
an unmerged PR is introduced. A reviewer can decompress the index into a fresh
directory, then use an independently reviewed data-only reader to verify the
container and internal manifest; ordinary TAR extraction alone is not validation.

Safe validation bounds are 2,000 logical members, 128 MiB per member and 256 MiB
logical total, plus 4 MiB TAR/header allowance. Absolute, parent, backslash,
duplicate, unknown, deep/oversized names, links and non-regular entries are
rejected. All stored and referenced member sizes/hashes must match before writing.
The gzip mtime is zero. Original-byte comparisons passed for every retained input;
no archived script, model, browser, Rust compiler or benchmark was executed.
