# Resource integration preservation round 2

Apply incremental.patch to e26527d79c (or cherry-pick this delivery's single local
checkpoint after reviewing newer parent semantics). The exact checkpoint is in
source-identity.json. This is a 46-path integration delta: the original 45-path
resource increment, with mapping paths ported into program/mapping, plus core
execution-owner regression coverage. No whole original-child overlay is included.
All resulting bytes were verified by applying the patch to a separate plain-file
copy of the exact e265 baseline; see apply-verification.json and files.json.
No paths are deleted; deleted-files.json is explicitly empty.

The branch is t3/rust-resource-admission in the app-managed worktree
/home/louistrue/.t3/worktrees/ifc-lite/t3-67b1d6af. The app renamed its original
branch while retaining this worktree binding. The parent workspace was not edited
or published. There is no PR, push, SMLib activation or second loader.

Read review-responses.md for the correction and port decisions. The original
source, review and immutable evidence are preserved under original-evidence;
original-evidence-SHA256SUMS pins every archived byte. Original orphaned workspace
and Clippy requests were also queried read-only; both still have null exitCode
and safeToResubmitAutomatically=false. Their current responses are retained.
No original request was retried and no active/foreign job was altered.

The parent advanced to fb913d3a5c after this base. Do not replace that parent with
this branch wholesale. There are no textual path overlaps, but its new common
BooleanProgram needs the terminal audit in new-parent-terminal-audit.md during
porting. Preserve its numerical-only PendingEffects unwind sink and updated
Execute::execute(&NumericalEffects) callers. This delivery did not incorporate
the newer Boolean code or the separately owned source/cache corrections.

Qualification: UNCOMPILED / RESOURCE-UNQUALIFIED. Syntax-only rustfmt parsing and
physical module-count inspection are observations, not Cargo tests or Clippy.
Fleet status reported Pop guard exit78 refusal; the reported 212 GiB free did
not meet 316 GiB required. PC's prior disk exhaustion has no verified recovery.
No refused heavy check was repeated. See qualification.json for pending checks.
No performance, exact full-heap bound, WASM consumer, or whole-workspace pass is
claimed. Strict refuses opaque coverage; Compatibility adds no quota/account;
Bounded retains the documented decoder/profile/numerical/raster/assembly and
downstream exclusions and conservative cache-account lifetime limitations.
