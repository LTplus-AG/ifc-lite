# Reporting backup and recovery procedure (#7495)

Status: prepared procedure, not a successful hosted restore receipt. Scope is only the isolated `reports-postgres` and `model-reports` services identified in the [deployment runbook](./railway.md). The daily six-day backup schedule is configured, but the recorded inventory has no completed backup. Never restore, wipe, migrate or change a foreign service to qualify reporting.

## Quiesce the entire service

Keep viewer reporting, public submissions, public sharing and signing disabled. Stop the **entire API deployment**, including retention, verification and publisher workers, and prevent an automatic restart/redeploy while recovery is underway. `REPORT_SUBMISSIONS_ENABLED=false` only gates admission: existing owners retain read/delete access and workers registered by the deployed source continue to run. Historical deployed N registers retention, verification and publication; current main `d7ea7b13ed889d318e4768fc8de93499e1719da6` registers only retention and verification, leaving publication dormant. Removing the qualification token also does not stop them.

Allow normal SIGTERM shutdown to drain, then verify no API replica remains and no application database transaction is active. The process has a 25-second shutdown deadline; a requested stop alone is not proof that workers stopped. Record deployment/volume identifiers and verify the dedicated database target before taking any snapshot or applying changes. Keep the old volume available for rollback until the restored state is approved.

## Bounded initial restore qualification

This sequence requires a separately authorised change window. It has not been executed by the routing change.

1. Confirm the owned reporting database has no real reports. Capture safe row counts, schema/migration state and the six PostgreSQL logging settings. Create a labelled safety snapshot and wait for a completed provider workflow and a listed backup; an accepted mutation is insufficient.
2. Through private database access, create an isolated qualification table containing only an opaque canary identifier and synthetic payload A. Commit, record its hash/count, checkpoint, and create a labelled qualification snapshot. Wait for its completion and record its expiry.
3. Change that same canary to payload B and commit. Verify B immediately before restore. This distinguishes a real rewind from a no-op that merely leaves a readable database.
4. Authorise the exact qualification backup and owned volume instance. The Railway restore API takes those two identifiers and returns a workflow ID. Omit `wipeServiceIds` and replica targets. Inspect the staged change: only the reporting database's volume replacement/mount may change. A restore creates a replacement volume; the previous volume must remain available. Apply only the reviewed change.
5. With a fresh private connection, prove payload A/hash/count, absence of B, expected schema and zero report rows. Recheck logging: `log_statement=none`, `log_min_messages=panic`, `log_min_error_statement=panic`, `log_error_verbosity=terse`, `log_parameter_max_length=0`, `log_parameter_max_length_on_error=0`. Record duration, resulting volume IDs and provider status.
6. Remove the synthetic table, verify no fixture/outbox work remains, and verify the daily schedule on the replacement volume rather than assuming inheritance. After rollback is no longer needed, explicitly clean up only the snapshots and detached volume belonging to this qualification. Record their removal; do not leave indefinite manual backups outside the disclosed window.

The actual API schema can be inspected with `railway api describe volumeInstanceBackupCreate`, `volumeInstanceBackupRestore` and `workflowStatus`. A completed restore must have data evidence, not just a workflow status. Provider documentation differs on treatment of later snapshots, so inventory both original and replacement volumes rather than assuming newer backups disappeared.

## Hold restart after any production restore

Keep the entire API stopped until independent deletion and publication reconciliation completes. Do not use normal startup or the publisher itself as a recovery script. Database-local deletion tombstones, audit rows, sessions and outbox receipts rewind with the snapshot and cannot independently prove what happened afterward.

**Deletion reconciliation:** obtain a deletion/cancellation journal that survived outside the restored database. It must cover every owner deletion, model cancellation and public-link revocation after the snapshot, contain only opaque identifiers/times needed for erasure, and be access-controlled and retained for at least the recoverable snapshot window. This main-based routing unit does not implement or activate that independent journal. Later recovery-journal and publisher-startup layers require their own source-bound qualification and custody evidence; their existence elsewhere in the stack is not restore acceptance. If the original volume is readable, export its relevant tombstones before switching, but that is not a total-volume-loss solution. Replay verified erasures, preserve original expiry timestamps, purge expired private details and reconcile missing/deleted S3 objects before allowing any owner reads. Public-link revocation must also be replayed if public sharing is later deployed.

If that independent evidence is unavailable, do not reopen restored confidential data on the assumption that no one deleted it. Keep recovery paused for maintainer review or conservatively erase potentially resurrected private records, agreements, sessions and model access before reopening. A restoration that loses safe resume access must report that limitation honestly; it is preferable to reviving withdrawn access.

**Publication reconciliation:** quarantine every restored outbox entry before any worker resumes. Compare opaque report IDs against independently retained GitHub publication receipts and actual GitHub issues/comments, including the configured App identity and exact service marker. A known publication updates the restored receipt/status without issuing another POST. Unknown, edited-marker, inaccessible or bounded-search-limit cases remain quarantined for review. `GithubIssues.findOrCreate` is unsafe for this recovery step because a no-match outcome can create an issue. A future recovery utility needs a read-only lookup path; an outbox row being present is not permission to republish reviewed private context after rollback. Later PostHog-bound comments need the same reconciliation.

A durable external deletion/publication journal and a read-only reconciliation utility are follow-up implementation, not features established by this runbook. Do not claim production disaster recovery acceptance until either they are qualified or an explicit conservative-erasure recovery policy has been approved and tested.

## Restart evidence and backup expiry

Before restarting, verify: all affected erasures applied; expired content removed without extending timestamps; restored sessions invalidated or independently reviewed; no unreconciled outbox entry eligible for publication; private object ownership/byte state consistent; all public revocations applied if relevant; safe PostgreSQL logging and daily backup schedule intact. Record only identifiers, counts, hashes and categorical outcomes in the recovery receipt—never model bytes, credentials, signer details or reviewed report prose.

Restart the exact approved gated source, then check health and disabled capabilities. Confirm no unexpected GitHub write or object resurrection. Public submissions and viewer activation require the remaining qualification steps in the deployment runbook; a restore does not enable them.

Daily database snapshots can retain recently deleted records for up to six days. Locked/manual snapshots, retained original volumes, object versions and provider-internal disaster-recovery copies require separate accounting. Delete qualification leftovers promptly; alert on snapshots without expiry. Do not promise the application can delete unmanaged provider backups. The object bucket has no operator backup/versioning, and its incomplete-upload lifecycle does not protect or expire completed model objects.
