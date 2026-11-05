# Italian release preparation

Original source `f3acb2fb3e`: request
`auto-0c8b48fa02bd4ca499519199dc919d8b`, Pop worker
`3cad3f72-99fa-451a-9f5a-d67755f641bb`, exit 1. Selected i18n tests:
80 passed, zero skips; scoped pre-handoff: 13 passed. Root typecheck failed on
an implicit type in the Italian plural test (fixed in `df55551ed0`, now replaced
by the shared explicitly typed contract). Root lint stopped at unused-locals:
viewer and viewer-embed did not compile standalone; no further diagnostic was
printed. Later lint gates and root typecheck tail did not run. Do not claim pass.

Original hardware GPU acceptance request `auto-fb33598fc585457e9a94b62c9bdada2e`,
worker `110a2b5f-ed0f-4b56-b38e-fc6b6a536e05`, was still queued when inspected.
It owns the original f3acb2fb3e build and its outputs; do not replay or remove them.
Real Italian GPU acceptance remains a release blocker until that receipt settles.

Integration adds current-main translations and shared test/verdict helpers.
Final-head root checks and full viewer suite remain required. IFCX dependency
build verification previously skipped four absent external fixtures; no IFCX,
Rust or full-monorepo acceptance is claimed. Preview query: `?lang=it`;
English: `?lang=en`. Merge after French; rollback via normal commit per i18n README.
