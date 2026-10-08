Material selection evidence qualification (#7119)
================================================

The current PR changes only the existing selection-material test fidelity. The canonical null-name production fix shipped in #7213, and the real parser fixture repair shipped in #7209. Their duplicate local production, parser-test and changeset changes were removed on normal main integration.

[Current clean integration qualification](dedup-eec-main/qualification.json) pins source `6e15e64fae`, the actual 21 affected tests, the full root typecheck of 3,734 files across 62 packages, light gates and separate runtime transitions. Fresh published-head CI and raw review remain required.

The original parent-folder qualification.json and logs remain immutable historical, superseded proof of the independently reproduced material defect. Those original 20/97/56/21/3732 runs and 2954 review are not relabeled as qualification of the current integration. No browser or performance claim.
