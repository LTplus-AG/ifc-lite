# Section-export engine budget decision

The human explicitly approved this measured feature-stack budget in the current
session on 2026-10-21. Earlier approval for #8003 is not its authorization.
The section-export stack (#8006 → #7900 → #7908) retains source-reference and
topology preflight, metadata attachments, and federation/visibility handling.
It enables section-clipped IFC downloads where whole elements were retained.

## Measurement and decision

- Exact measured source: `257930c586177b49f6498077cdf5bc8546962b7b`;
  tree: `31dff5e6cbfab16bbd6b7b530649cad19a0b45c5`.
- Size-phase completion/provenance: `2026-10-21T14:34:10.022Z`.
- Local Pop worker, Node 24.22.0/Brotli 1.2.0, canonical quality 11 plus
  input-size hint: **2,396,446 Brotli bytes**. This is not hosted CI evidence;
  the source workflow uses Node 22, and build paths can affect artifact bytes.
- Original ceiling 2,379,124 with relative tolerance 0.005 allowed 2,391,019:
  the original run really failed by 5,427 bytes.
- Approved ceiling 2,396,446 increases the ceiling by 17,322 bytes (about
  0.728%); the unchanged 0.005 tolerance permits 2,408,428 bytes.
  All viewer entries remain unchanged.

This accepts the measured feature-stack budget. It is not a current-main reset,
an isolated feature-byte attribution, or proof of browser runtime cost. No
credible bounded source simplification was established; do not remove safety
preflight to meet the old ceiling. Textured trims refuse, and model diagnostics
conservatively reject unsupported crops. Hosted/parity readiness and current
performance remain holds. This decision does not approve a merge.

## Retained evidence and limits

Original job `1345aaa6-c32a-4338-8323-7b15285f90a9` remains failed (exit 2):
6,194 workspace tests passed (46 ignored), strict Clippy exited 0, and forced
root typecheck exited 0, auditing 4,263 test files across 67 packages. Its size
phase then failed; it did not execute consumers or produce a new Haus output.
Only Haus was fetched; 181 optional model fixtures were absent.

Consumer job `5f906537-2d02-472b-9429-1ad0e2172e7a` independently completed
with exit 0 on that exact source/runtime: 1,955 export tests passed, 53 skipped,
and seven mounted viewer tests passed without skips. The cropped Haus output
reopened 136 meshes, with 23 trimmed elements, 34 outside elements excluded,
and zero plane violations. This proves the tested consumer behavior, not GPU,
browser end-to-end, full-corpus, performance, or hosted size readiness.

Actual runtime custody SHA-256 (unchanged between the original build and the
completed consumer run):

```text
WASM  40ff4a3a0aa7c37fdaf89f4f9af775a71444c3324c1ffa2c947e6c2a4f353713
JS    0efc9079eb1903c0db6e45e6ce3099c4dfa793c8353c94cc34dab53bbdf1370e
d.ts  3790fd33554cc8939753518404c28b67ac45200cffd01e97de02f684445fee9f
Haus  d42ab0dee01173106c16cd823b4614efe188fa15dd65195d95b9879bec59acc5
Crop  08b119575bcfc46c8a272aa1684c1ded5715da6f0da388ccefbbe7a114e008a2
```

The original failed receipt, logs, runtime capsules, and subsequent independent
consumer reconciliation remain retained privately. Earlier failures are not
rewritten as passes; the earlier `df57` consumer attempt remains orphaned/unknown
and supplies no acceptance evidence. No build, install, test, benchmark, runtime
regeneration, or output repin was performed for this documentation/budget carry.
