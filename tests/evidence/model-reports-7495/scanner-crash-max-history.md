# Historical scanner crash and maximum-model evidence

The two `scanner-*-local-20261013.json` receipts retain their original bytes and
source bindings. Crash/container-death qualification belongs to
`6c0bf4846400238810bbeb0686e2345046e040b6`, with the orphan-removal negative
control at `e4383aa6d7f3da7bbf40fb5fa68956dfb09c0df2`. The separately enabled
exact-1-GiB padded FZK qualification belongs to
`8f2bf08fb7db36ab358df04da08003098ec06c76`. The published historical M layer
was `96a4743fdc7efa4f37be5b80ee26812c9e808415` on L
`a68fa4ecb531ff2abfc3733a2c339ac52e991b1e`.

This test/evidence layer is now composed over L
`e4d94af89de80e8809953a3496199a36cae87eea`, whose ancestry contains the
canonical N composition on main. All production and scanner CLI source remains
identical to that parent. Current behavior is **unqualified**: no new install,
build, test, typecheck, engine execution, container kill, maximum-model upload
or scanner soak was performed. A plain backend storage CI pass would not
exercise the engine or the opt-in maximum-model case.

Historical lease expiry used an explicit fixture-only database deadline update,
not a twenty-minute wall-clock wait. The padded FZK result covers that selected
fixture; OOM, scan-work exhaustion, universal malware clearance and the selected
EU runtime remain unqualified. Current source-bound correctness, cleanup and
negative controls need an authorized exclusive host window. Production scanner
activation, public release, submissions and NDA signing remain disabled.
