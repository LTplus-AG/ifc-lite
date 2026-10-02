# Review provider measurement

The `Claude review` workflow starts with the OpenRouter ensemble when configured.
Its `review-outcomes-*` artifact retains per-call billed `usage.cost` (including
cache/reasoning charges), token details, elapsed time, and pool-validation outcomes.
Token-price fallbacks are labelled `estimated`; absent usage is unknown, never free.
Sidecars append corrective attempts instead of overwriting the original cost.
`poolValidation` measures acceptance into the pool, not final finding validity.
The artifact also carries initial/final raw pooled answers, findings before dedup,
judged findings, and validator diagnostics;
findings retain their source model for attribution. Transport failures have unknown
cost because an interrupted provider may still bill a request.

To compare the strong reviewer seat, dispatch `Rubric eval` with
`provider=openrouter`. It replays the same 18 historical cases independently with
GPT-6.1 Sol, Sonnet 5.5, and Opus 5.5. Each candidate uses the production prompt,
high reasoning effort, 32,768 output-token limit, context pack, mechanical validator,
and one corrective retry. There is no failover to another model, ensemble pooling,
or paid judge. Scores measure generation plus validation, not the final posted
production ensemble. Each model has a $10 ledger covering retries: before requesting,
the adapter reserves input UTF-8 bytes at the static input rate and maximum output
tokens at the output rate. Failed calls retain their reservation; successful calls
settle against billed cost or a labelled estimate. This is a conservative client
reservation, not a provider-enforced billing cap, and rates can change.

A stopped run can be resumed with `resume_run_id`: the workflow restores each
model's artifacts and cumulative cost ledger and requires the same rubric. Cases
whose model attempts completed are revalidated from their saved historical context
without another model call; mismatched model/corpus evidence is refused. Costs
remain cumulative across runs. The initial $3 probe stopped Opus after five cases
because the next full-token reservation exceeded remaining headroom; $10 allows
more room for the historical corpus's long context packs.

Download all `review-eval-*` artifacts. Compare `score.json`, per-case validation
records, and usage sidecars; a failed or budget-limited job is incomplete and must
not be reported as a full-corpus score. The semantic matcher is used when its key
is configured; otherwise the report labels the weaker stem matcher. Inspect all
extras and stem-only hits against the historical patch before changing a model:
known findings are a recall floor, not an exhaustive false-positive oracle. Record
human-confirmed defects, erroneous findings, and unique confirmed detections per
model alongside the artifacts. One canary is an availability check, not a quality
ranking. Re-run the winner with the production ensemble and judge before promotion.
`REVIEW_ENSEMBLE_STRONG_MODEL` can select an evaluated winner without changing
the cheap seats; unset or blank preserves Opus. The existing risk classifier treats
all code changes as high risk, so this seat normally runs on every code PR.

The self-hosted Qwen/PR-Agent lane remains disabled. The October 2 local probe on
this runner found that both installed Qwen coders missed two known historical
regressions; the 30B model also reported defects already fixed by a clean patch.
Those four cases do not establish general recall, but they do not support making
this lane a blocking reviewer. A future local-model evaluation should include
clean patches and after-patch correctness, not only the positive canary.
