# Recorded-build decision for #7036

The combined persistent-worker and parser-memo proposal failed its recorded
acceptance rule. Earlier first geometry on the small model coexisted with a
regression in full metadata/render readiness on the large model. Full readiness
also improved on the structural model; the result is mixed across fixtures. The comparison
does not isolate the responsible layer. The proposals are declined and the
held main experiment is removed under its existing removal condition.

`decision.json` records source/build/WASM identities, the worker receipt,
fixture hashes, memory-accounting limits and M2 frame observations.
`comparison.json` is the unchanged repository reporter output.
`acceptance-rule.json` was recorded while the measurement request was queued,
before any results existed. Its term "total-load" did not name a field: during
result review this was mapped to the reporter's existing full METADATA+RENDER
readiness boundary. That field mapping was not separately preregistered; the
legacy app-summary total remains a distinct measurement. The successful request used that same frozen
protocol after the preceding requests ended before execution.

`measurements.jsonl.gz` losslessly preserves all original sample rows, including
span trees, worker observations, frame attribution, health and logged phase
memory. Its decompressed SHA256 is in `decision.json`. To reproduce the report,
decompress the rows to a scratch file and run
`node scripts/perf/browser-ab-report.mjs ROWS --base base --branch candidate`.
`recorded-cohort-driver.mts.gz` preserves the exact measured driver verbatim;
its decompressed SHA256 is `driverSha256` in `protocol.json`. The observer source
is unchanged. `cohort-driver.mts` is the executable reproducer with an error-path
repair: primary and cleanup failures are aggregated outside `finally` rather
than allowing cleanup to overwrite the original error. All accepted samples
had no errors and clean cleanup; this repair changes no recorded observation
and no timing campaign was repeated. The reproducer has its own SHA256.

Run a reproduction only with the recorded helper checkout and source-pinned
production distributions, under exclusive fleet admission. The executable path
is the original measurement host's Chromium installation.

The source-built engine binary is identical on both arms. Each sample used a
fresh browser/profile, and the target model was its first load; OS file cache
was uncontrolled. No cloned-payload identity hashing ran during the timings.
The logged `perfMem` peaks are not browser RSS. Renderer/federation and resident
memory acceptance were not completed, because the performance gate already
rejects shipping this candidate. No extra timing campaign was run to seek a win.
