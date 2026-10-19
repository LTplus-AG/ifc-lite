<!-- SPDX-License-Identifier: MPL-2.0 -->
# Canonical zero in the existing section grid

The actual source26354 WASM SDK witness produced two degree-one section nodes
at x=0 and x=-1.1102230246251565e-16. Seven-decimal toFixed keys retained a
negative sign for the rounded zero, spuriously splitting one existing grid point.
The repair canonicalizes only that negative-zero spelling. Grid precision,
section closure, loop counts, bounds, areas, volumes and tolerances are unchanged.
No SDK geometry is edited or accepted through another predicate.

A synthetic annular triangle-soup fixture varies one vertical boundary edge
across the zero axis. The same-grid positive case fails with the original witness
and passes after the repair; a 1e-6 seam beyond the existing grid still refuses.
The full CMake-invoked transport/oracle fixture group passes all32 cases with no
skips. Compressed before/after outputs and source hashes are retained. These are
oracle regression results, not actual SDK or browser numerical qualification.
The actual witness still requires an admitted corrected-source rerun.
