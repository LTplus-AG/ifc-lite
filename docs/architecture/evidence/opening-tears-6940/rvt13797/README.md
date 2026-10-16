# RVT13797 bounded needle-repair evidence

This is the reviewed source/cut comparison supporting one explained census-row
migration. It is separate from the fresh MiniBIM1cb4 functional/browser pack.
The original captures retain their own heads and candidate patches; they are
not relabeled as new1cb4 executions. No golden edit is performed here.

The cap keeps its authored f64 oriented domain and original scalar vertices,
while replacing faces that collapse/reverse under finite local f32 conversion.
All adopted cap faces are locally f32 positive. Downstream3D surfaces do differ.
Primary output398→382 triangles removes collapsed faces but changes open/strict
edge counts72→104 /132→134; alternate375→371 has ordinary91 unchanged and
strict123→120. These are mixed, disclosed aggregate results.

Exact per-axis/sign and authored-depth-layer projected multiplicity accounts
for every face. Both exterior skins match exactly in projection; nonzero
changes remain on internal interfaces and primary sidefaces. Complete finite
face comparison gives diagnostic upper bounds at most18.1018µm both directions
and same hemisphere. That observed number is not a new acceptance tolerance.
The verdicts explain why these facts support this specific needle repair.
They do not claim exact3D identity, a material-labelled bijection, watertightness,
or repair of the inherited extra interior sheet/oracle discrepancy.

`13797-evidence.tar.gz` preserves original relative paths, bytes and hashes.
`manifest.json` lists every member; no IFC fixture, runtime, ELF or dependencies
are shipped. Authored JSON includes bounded original entity excerpts and
pinned0.8.5 settings/placements/finite vertices/faces, not a complete IFC file.

For offline reproduction extract into a NEW scratch directory. Scripts retain
original relative input/output paths. Preserve or move the archived result
file before running its script: some original scripts overwrite that result.
The exact multiplicity scripts need Python/NumPy; finite-face v2/v3 also need
Shapely. Run v2 before v3. No new geometry-engine run is needed for saved-array
analysis. The original oracle scripts additionally require the locked engine,
authentic fixture obtained separately, and adapting their disclosed absolute
fixture path; they refuse an existing output directory. Raw source/command/
restoration receipts describe the original native captures, not a new replay.

Counterevidence is intentionally retained: finite-face v1/v2 contain coarse
bounds subsequently refined byv3; all-axis-depth-v1 has failed cell-membership
accounting and is NOT an acceptance certificate. The exact plane-chain report
disproves exact3D equivalence. No old failure is substituted for a passing run.

Read the two bounded-acceptance verdicts inside `work/6940/rvt-causal/` first.
CI, new-source provenance, other changed census rows and end-to-end performance
remain independent requirements. Nothing in this pack changes their gates.
