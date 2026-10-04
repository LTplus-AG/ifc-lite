# Integrated SDK rejection: complete raw evidence

Run 37194313221, attempt 1, measures literal BASE8ab versus CAND89d using controller4d. All five Holter pairs are slower; the candidate must not ship. This archive preserves all 250 artifact members and 32 full-run log members by exact reference to the original official ZIP containers, plus complete metadata, job log, audit inputs/results and rejected production source/patch.

- Container: `receipts.tar.gz`, 25,485,862 bytes.
- SHA-256: `358c2605500765689f3bb80965cc322b5eea7a211835b7335e4ce6251b28a0f4`.
- Index: `cohort-index.json.gz`, deterministic compressed JSON.
- Index gzip SHA-256: `d901900a8bcf1ebe1476ab02d1fe327273f6f2d3607407468e4bf189140972e9`.
- Internal manifest: `packet-member-manifest.json`.
- Manifest SHA-256: `6c008d2f616ceac400765cc3a3c566fa96a74539cbb1f8fb9107bc1b85216cb5`.
- Logical members: 338; 100,289,220 logical bytes.
- Stored TAR members: 57, including the internal manifest.

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

Within the packet, `sdk-raw/qualification.json` retains all five paired deltas for
every family, controls and the independent audit. The exact original report is the ZIP member
`sdk-raw/artifacts/sdk-worker-37194313221-1/report.json`.
`rejected-production/orientation.patch` is an exact eight-path diff from reviewed
main515 to historical candidate4361; `rejected-production/source-manifest.json`
pins the baseline/candidate source bytes and absent baseline sibling test.
The candidate source is data only and is absent from the final runtime tree.
