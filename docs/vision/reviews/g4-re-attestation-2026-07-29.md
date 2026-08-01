# G4 re-attestation - the second adversarial cycle

Date: 2026-07-29, the same day as
[`g4-red-team-2026-07-29.md`](./g4-red-team-2026-07-29.md) and after it. This is
a **separate review with a separate mandate**: the first one attacked Phase 4's
work, this one attacked Phase 4's *remediation of that review*. It is the reason
the amendments in `moonshots-finishing-plan.md` say what they say.

## Why this file is being written after the fact

**The cycle it records left no committed document.** Its ruling and its seven
exit criteria existed only inside agent messages and in the commit subjects that
cite them by number, so the audit trail of this gate cycle was not
reconstructible from origin - a program whose thesis is standing evidence closed
its own gate cycle on an artifact nobody committed. Recorded here, late and
labelled, rather than left as a hole.

**What is verbatim and what is reconstructed.** Every sentence in quotation
marks below is copied from a commit body on origin, with the commit named. The
exit criteria themselves are **reconstructed**: the wording is lost and only the
numbering and the closing act survive, so each one is stated as the thing the
record proves was demanded, not as the sentence the reviewer wrote. One of the
seven (A1) left no anchor at all and is marked as such. Reconstruction is worth
less than the original; that is the cost of not committing it, and it is stated
here rather than smoothed over.

## Method

Five attackers, a skeptic, and a judge. Each attacker took one remediation claim
and checked it **against origin** rather than against the claim - re-reading the
committed file, the committed artifact, and the PR body a reader actually sees,
in the state a stranger would fetch them. The skeptic then attacked each
attestation in turn, on the standing assumption that an attestation is a claim
like any other. The judge ruled on what survived.

The design point is narrow and worth keeping: the first review found that the
orchestrator's verification could re-run every battery and still miss prose that
no artifact backs. Re-attestation does not re-run anything. It reads what
origin holds and asks whether the sentence and the artifact say the same thing.

## RULING: GATE G4 STAYS FAILED

The remediation closed real work - the perturbation artifact is real, the
ablation is real, the numeral checker gates - and it did not close the gate. The
decisive reason is in the defects below: **the round-one remediation
re-committed the same defect class it was written to fix, three times.** A
remediation that reproduces the failure mode under review is not a remediation
yet.

## The seven exit criteria

Cited in commit subjects as "G4 item N". They are **not** the G4 review's six
required items; see the numbering note at the end.

**A1 - unrecovered.** No commit subject or body anchors an item 1, and the
wording is lost. The one remediation thread in this cycle that carries no
numbered anchor is the correction of PR #1900's body (defect 3 below), which is
the most likely occupant of this slot; it is recorded here with that uncertainty
stated rather than silently numbered.

**A2 - resolve M3's adjudication status, by scheduling the CSG-adjoint bet
properly or by withdrawing the claim that it is scheduled.** Closed as option
(b): commit `1d5c5b97` says "M3's status is recorded as UNADJUDICATED pending
the Phase 5 CSG-adjoint bet, rather than left as a binary that can neither pass
nor fail. This is option (b) of the re-review's exit criterion 2." The
withdrawal itself landed later, in `0d5a68a2`, because the amendment text had
not actually followed the option the commit declared - defect 1.

**A3 - the retraction must reach every document a reader can see, and it must be
signed by the gate holder rather than by the party it excuses.** Two halves.
Governance half, commit `1d5c5b97`: "Closes the governance half of the G4
re-review's exit criterion 3: the amendments were written by the party whose
work they excuse, in the wrong file, without the betting-table marker amendments
1-5 all carry." Artifact half, commit `a90030c0`: B4.4's own conclusion section
"said 'differentiable buildings survives the exam it was given' - true, and
misleading in the one file a reader on this branch can see, because the
retraction lives in `docs/vision` on a different branch."

**A4 - correct the misstated tolerance and point count, everywhere it was
copied.** Closed in the plan by `1d5c5b97` and in the artifacts by `98d9a6d5`.
Defect 2.

**A5 - produce a real KERNEL perturbation artifact; the shipped self-test is not
one.** Commit `7b2cf114`: "The plan's B4.1 exam says 'a deliberate one-bit
KERNEL perturbation turns it red'. The shipped `--self-test` perturbed a
JavaScript carbon constant, and the adversarial re-review proved that is not
equivalent: the wasm kernel can be disconnected from act 5 entirely and the
self-test still passes."

**A6 - the numeral checker must GATE, and it must cover `docs/vision`.** Same
commit: the checker "now gates (`--gate`, step E9) over every bet directory AND
`docs/vision/**`, which the review identified as the blind spot that let a
fourth bad figure into amendment 6." Its artifact-side half is `37a08f8e`, which
found that B4.5's own reproduction command "wrote `scorecard.json` in place, so
the reproduction command documented in its own REPORT.md destroyed the artifact
every later claim is checked against - that is how eleven prose/artifact
contradictions were created here in the first place."

**A7 - measure B4.2's derived-cut sensitivity instead of arguing about it, and
restate what the spatial rule actually buys.** Commit `f2a2705d` implemented the
semantics as a switch and "measured the full 2x2 rather than argued about it",
returning the finding that the first review's mechanism split was wrong. Defect
4 came out of the same work.

## The four defects

### 1. An amendment that contradicted its own commit message

Amendment 6 asserted that the CSG-adjoint bet **is scheduled first in Phase 5,
ahead of B5.5**, while the commit that wrote it declared it was taking option
(b) - "the route that exists precisely to DROP that claim" (`0d5a68a2`). Phase 5
contained B5.1 to B5.5 and nothing else: no number, no exam, no kill clause, no
displacement against the five-bet cap, and an unchanged cycle budget.

The commit that caught it states the shape of the thing plainly: "a live false
statement of record was sitting inside the amendment written to fix the record."
Withdrawn, and the plan now says that entering a bet is a betting-table act
rather than a sentence in an amendment.

### 2. The tolerance figure, wrong for the third time

The tolerance 2.19e-13 began as a correct measurement used with a wrong scope:
the first review wrote it as holding "at every one of 1,200 sampled points". The
amendment written to eliminate that class of error imported the same phrase
unchecked. Round one of the remediation corrected the plan; the artifacts it
cited were not corrected, so B4.4's DESIGN.md still said the forward value
matched the closed form "to 2e-13 relative across all 1,200 family-A points" -
"wrong twice", per `98d9a6d5`, because the battery's points are half family A
and half family B, and family B has a **different** oracle,
`det*depth*(A_outer + A_hole/3)`. A Rust doc comment claimed family B was
"Verified below to 1e-13", false by about 13.6x and asserted nowhere in the
file.

Corrected values: family A's worst oracle-versus-forward deviation is
2.188857e-13 over the family-A half; the battery-wide worst, on family B, is
1.358479e-12. The smoothness conclusion is unchanged - only the scope was
wrong, three times, in three documents, each time inside a correction.

That is also why the numeral gate now covers `docs/vision`. It still does not
cover Rust doc comments.

### 3. PR #1900's unbacked pooling row

The first review had already found that B4.2's PR body carried a row reading
`42 further seeds / 36,000 schedules pooling to ~31%` - the strongest evidence
in its table - and that the study "exists nowhere in the repository". The row is
quoted here as a string rather than as a figure, because it is withdrawn text
and there is nothing for it to be checked against. Round one fixed the
module and the ledger; **nobody fixed the PR body**, which is the document a
reader on GitHub actually sees and the only one a reviewer of that bet reads
end to end. The re-attestation checked origin rather than the branch and found
the pre-restatement story still standing there.

The body was rewritten in `7ddb4de7`, which records the reason in the PR itself:
"Body rewritten after the G4 re-attestation found it still carrying the
pre-restatement story, including a `42-seed/36,000-schedule` pooling row that
exists in no committed artifact."

The general lesson is the one this cycle keeps producing: **the record is
whatever a stranger can fetch**, and a PR body is part of it.

### 4. The false "only one of the 9" claim

The sensitivity work of A7 introduced its own false claim in its own docstring:
schedule 937 was described as "the only one of the 9 that survives every
correction". False - the schedule-matched derived/off cell is **zero**, so none
of the original nine survives both corrections; 937 comes from a stream
regenerated under derived/off semantics, a schedule the baseline never drew.

Commit `7ddb4de7` names the pattern rather than just the instance: "A false
claim inside the correction written to fix false claims, which is the pattern
this whole gate cycle keeps finding." The substantive point survives in correct
form: 937 is the only conflict anywhere in the grid with an IFC basis, namely
`IfcRelVoidsElement` referential integrity - an opening added into an element
another client removes.

## What the re-attestation did not dispute

- Every measurement in Phase 4 still reproduces. This cycle, like the first,
  found errors of framing, scope and record-keeping, and none of fact.
- The ablation and the sensitivity grid are genuine new work that made the
  program's own claim weaker and more precise, volunteered by the bet.
- The kernel-perturbation artifact is the real thing and is sharper than the
  self-test it replaced.

## Numbering convention, so this cannot recur

The collision is demonstrable in the log. Commits `9039d402` and `1d5c5b97` both
say "G4 items 3 and 4" and implement entirely different item sets - the first
against the G4 review's required list, the second against this cycle's exit
criteria. Commits `841aabdc` and `7b2cf114` both say "G4 items 5 and 6", again
against different lists. Commit `f2a2705d` says "G4 item 7", and the G4 review
has six required items, so that citation resolves to nothing.

From here:

1. **A numbered list that a commit may cite must exist in a committed document
   before the commit that cites it.** This is the rule that would have prevented
   all of the above, and the only one that matters. An uncommitted list is not a
   numbering scheme, it is a private one.
2. **Cite items with a qualified tag, never a bare "item N".** `G4-R1` to
   `G4-R6` are the G4 standing review's required items; `G4-A1` to `G4-A7` are
   this re-attestation's exit criteria. In general `G<n>-R<k>` for a gate's
   standing review and `G<n>-A<k>` for its re-attestation.
3. **A cycle that produces exit criteria commits them before any commit closes
   one.** Cheap, and it is what this file is retrofitting.

<!-- numeral-ok: 937 :: a schedule index from B4.2's regenerated derived/off
     stream on branch feat/b42-spatial-merge, which commits no scorecard JSON -
     that bet's grid is emitted to stdout by
     scripts/moonshot/g2-merge-soundness.mjs and pinned by provenance tests, so
     no artifact in any tree backs it. It is the one Phase 4 headline with no
     machine-readable source, and until one exists this marker is the whole
     guarantee. -->
<!-- numeral-ok: 13.6x, 1e-13, 2e-13 :: 13.6x is the ratio between the claimed
     1e-13 and the measured 1.358479e-12, arithmetic done in the sentence;
     1e-13 and 2e-13 are the two WRONG tolerances being retracted here and must
     stay unbacked. -->
<!-- numeral-src: 2.19e-13, 2.188857e-13 :: b44-kernel-adjoint/battery.json#[0].maxOracleRelDev -->
<!-- numeral-src: 1.358479e-12 :: b44-kernel-adjoint/battery.json#[5].maxOracleRelDev -->
