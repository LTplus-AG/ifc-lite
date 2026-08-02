# B5.1 -- real merge traces

**The bet cannot be run as commissioned, and the reason is a two-line defect in
the shipped server rather than a shortage of users: the collaboration binary
never constructs an audit sink, so the audit log the finishing plan says
"already exist" has never had a single entry written to it in any deployment.
The corpus clears none of the six admissibility criteria this bet registered
before counting it. Everything below is therefore labelled, in the artifact
itself, as measured on the synthetic schedule generator and not on captured
sessions -- and on that population the pre-registered prediction FAILED as
registered, held on the one cell whose semantics match this repository, and
produced a stronger result than it predicted: the spatial rule can be deleted
outright and replaced by a read-set check over hosting targets, with zero
unsound auto-merges in all four semantics cells and no geometry at all.**

## 1. What was pre-registered, before anything was counted

`prereg.mjs` holds the prediction and the admissibility bar and nothing else.
`run.mjs` imports both and states no threshold of its own, so a result cannot
arrive with a bar that was adjusted to fit it. The registration is committed in
`prereg.json` with a hash of the source that produced it.

**The prediction.** Under the cut semantics this repository actually
implements, which is derived and not the stored lazy cut the published headline
was measured in, the spatial rule true-catch count falls to zero or one, with
the residual hazard being referential integrity of the hosting relation --
catchable by a read-set check over relationship targets with no geometry at
all. Three separately falsifiable clauses:

| clause | claim | bar |
|---|---|---|
| `b51-p1a` | spatial-only true conflicts per thousand schedules, under derived cuts | at most one |
| `b51-p1b` | the same count under the stored lazy cut is strictly greater | greater than zero |
| `b51-p1c` | structural plus a hosting read-set, spatial deleted, admits no more unsound auto-merges than the full predicate | at most zero |

Clause `b51-p1a` is scored on the **worse** of the two derived cells, by
registration, so it cannot be passed by choosing the friendlier one. That
choice is what makes the result below a real failure rather than a rounding
argument.

**The admissibility bar**, six criteria, all floors for the run to count as an
adjudication: at least thirty distinct sessions; at least ten with two or more
concurrent editors; all four scored op kinds present; at least one session
containing a hosting relation; at least three independent origins; and a record
type that can express a target and a value at all. The bar exists because the
exam operative word is "real", and without a floor a three-session replay by
one developer satisfies the sentence and adjudicates nothing.

## 2. The corpus, and why it clears nothing

The census is a measurement, not a search that came up empty. Three independent
findings, each read out of the tree rather than asserted:

**The production server records nothing.** The binary entry point never
constructs an audit sink, and the room manager default is the sink that drops
every entry. There is no environment variable anywhere in the package that
could switch one on without a code change, so this holds for every deployment
of this binary and not merely for one of them. The finishing plan premise
that the audit logs already exist is false, and it is false by omission in
about two lines.

**The record type could not drive the battery even if it were switched on.**
The audit record carries a timestamp, a user, a role, a room, a message kind
and a hash of the payload. It names no entity, no property set and no mesh, and
carries no value. Its message vocabulary is transport-level -- connect,
disconnect, the two sync steps, update, awareness, reject -- so it cannot
express a single one of the four op kinds the battery scores. The census
computes that by enumerating the declared fields and looking for a target and a
value, and finds neither.

**No captured sessions exist, committed or otherwise.** Zero session-trace
files are committed anywhere in the repository. The only persisted room state
on the machine this was run on is two room logs in a gitignored directory, both
opened by this repository own example applications -- the census establishes
that by reading the room ids out of the examples sources and matching the
persistence layer own filename encoding, so it is a derived fact and not a
guess about filenames. They hold 459 frames between them, they are one
developer talking to themself, and they are not an independent origin under any
reading.

<!-- numeral-src: 459 :: b51-real-merge-traces/trace-census.json#totalPersistedFrames -->

**Result: none of the six criteria cleared.** The two most decisive are the two
that cannot be fixed by finding more users: the record type expresses none of
the four op kinds, and no session carries the hosting relation the spatial rule
exists for.

The scorecard carries this verdict next to every number, in a field that says
which population was measured, so the rate below cannot be quoted without it.

## 3. What was measured instead, and what it is worth

The battery was replayed on the generator, across eight independent seeds of
one thousand schedules in each of four semantics cells, under both the
schedule-matched and the regenerated stream conventions. That is eight times
the schedule count the published derived-cut grid was measured on, and it is
the first time that grid has been run on more than one stream.

This is a **semantics-sensitivity replay, not a real-trace replay.** It cannot
adjudicate the open finding. What it can do -- and does -- is test whether the
grid the open finding rests on is a property of the model or of one lucky
stream.

**The grid reproduces, per thousand schedules, regenerated stream:**

| cut semantics | containment enforced | containment off |
|---|---|---|
| lazy | 9.5 | 14.875 |
| derived | 4.125 | 0.625 |

<!-- numeral-src: 9.5 :: b51-real-merge-traces/scorecard.json#measurements.regenerated.lazyEnforced.spatialOnlyTrueConflictsPerThousand -->
<!-- numeral-src: 14.875 :: b51-real-merge-traces/scorecard.json#measurements.regenerated.lazyOff.spatialOnlyTrueConflictsPerThousand -->
<!-- numeral-src: 4.125 :: b51-real-merge-traces/scorecard.json#measurements.regenerated.derivedEnforced.spatialOnlyTrueConflictsPerThousand -->
<!-- numeral-src: 0.625 :: b51-real-merge-traces/scorecard.json#measurements.regenerated.derivedOff.spatialOnlyTrueConflictsPerThousand -->

Against the published single-stream figures of nine, thirteen, three and one,
every cell lands inside sampling noise of its published value. The published
grid is real. The schedule-matched convention gives 9.5, 9.5, 4.125 and 1.125,
which likewise reproduces the published claim that dropping containment alone
changes nothing.

<!-- numeral-src: 1.125 :: b51-real-merge-traces/scorecard.json#measurements.scheduleMatched.derivedOff.spatialOnlyTrueConflictsPerThousand -->

**The per-seed spread is the part the single stream could not show.** Under
derived cuts with containment off, most of the eight seeds produce no
spatial-only true conflict at all in a thousand schedules and none produces
more than a couple. Under derived cuts with containment enforced, no seed
produces none. The two derived cells are not the same phenomenon at different
volumes; only one of them is consistent with the phrase zero or one. The arrays
are emitted in full at
`scorecard.json#measurements.regenerated.derivedOff.perSeedSpatialOnlyTrueConflicts`
and its sibling.

## 4. The prediction, graded

| clause | observed | bar | verdict |
|---|---|---|---|
| `b51-p1a` spatial true-catch collapses | 4.125 | at most one | **FAILED** |
| `b51-p1b` the lazy cell is the outlier | 5.375 | above zero | HELD |
| `b51-p1c` read-set substitutes for geometry | zero | at most zero | HELD |

<!-- numeral-src: 5.375 :: b51-real-merge-traces/scorecard.json#prediction.clauses[1].observed -->

**Clause `b51-p1a` failed, and the failure is informative rather than
embarrassing.** It was registered over the worse of the two derived cells. The
worse cell is derived cuts with containment enforced, at 4.125 per thousand.
The cell whose semantics this repository actually implements is the other one:
the void kernel clips overhanging cutters rather than refusing the edit, so
containment is not enforced anywhere in the stack, and in that cell the count
is 0.625 per thousand -- exactly the zero or one the prediction named.

So the honest statement is: the prediction is right about the repository and
wrong as registered, because the registration quantified over both derived
cells and only one of them matches the code. A prediction registered over the
matching cell alone would have held, and saying so after the fact is worth
nothing, which is why the registered form is the one graded in the table.

**Clause `b51-p1c` held, and held harder than predicted.** The prediction said
a read-set check would catch the residual case in the derived cell. It catches
every case in **every** cell. With the spatial rule deleted entirely, a
predicate of structural overlap plus a read-set over hosting targets admits no
unsound auto-merge in any of the four cells, where structural overlap alone
admits 5, 33, 76 and 119.

<!-- numeral-src: 5 :: b51-real-merge-traces/scorecard.json#measurements.regenerated.derivedOff.structuralOnlyUnsoundAutoMerges -->
<!-- numeral-src: 33 :: b51-real-merge-traces/scorecard.json#measurements.regenerated.derivedEnforced.structuralOnlyUnsoundAutoMerges -->
<!-- numeral-src: 76 :: b51-real-merge-traces/scorecard.json#measurements.regenerated.lazyEnforced.structuralOnlyUnsoundAutoMerges -->
<!-- numeral-src: 119 :: b51-real-merge-traces/scorecard.json#measurements.regenerated.lazyOff.structuralOnlyUnsoundAutoMerges -->

That is a stronger claim than the plan, which held the rule in the lazy cell
on the grounds that it was the only thing catching those events. It is not: a
check with no geometry in it catches them too.

**What the substitute costs, stated because it is not free.** The read-set
check as implemented is deliberately conservative -- a geometry replace on a
host reads and writes all of that host openings -- and it over-approximates
slightly more than the rule it replaces, refusing 28 more commuting schedules
in the derived-off cell than the full predicate does. Tightening it is a
different exercise; the number is reported as measured, not argued away.

<!-- numeral-src: 28 :: b51-real-merge-traces/scorecard.json#measurements.regenerated.derivedOff.readSetMinusFullFalseConflicts -->

## 5. The false-conflict rate against the twenty percent bar

On the derived-cut cell, over ground-truth-commuting schedules -- the plan own
denominator: **8.99%**, against a bar of 20%. The other three cells give 7.04%,
7.53% and 7.59%. Every cell passes.

<!-- numeral-src: 8.99% :: b51-real-merge-traces/scorecard.json#measurements.regenerated.derivedOff.falseConflictRate -->
<!-- numeral-src: 7.04% :: b51-real-merge-traces/scorecard.json#measurements.regenerated.lazyEnforced.falseConflictRate -->
<!-- numeral-src: 7.53% :: b51-real-merge-traces/scorecard.json#measurements.regenerated.lazyOff.falseConflictRate -->
<!-- numeral-src: 7.59% :: b51-real-merge-traces/scorecard.json#measurements.regenerated.derivedEnforced.falseConflictRate -->
<!-- numeral-src: 20% :: b51-real-merge-traces/scorecard.json#killBar -->

**This number does not discharge the kill criterion.** The criterion reads
real-trace false-conflict rate, and the corpus cleared none of the six
criteria that would make this a real-trace rate. The scorecard records the
population next to the rate for exactly this reason. What the number does
establish is that the rate is stable under the semantics switch: moving from
the stored lazy cut to the derived cut moves it by under two points, so the
published pass is not an artifact of the cut convention.

The restricted rate the earlier bet own exam turns on moves the other way and
gets worse. Over schedules where the spatial rule fired, the false-conflict
rate is 33.60% in the lazy baseline and **61.68%** under derived cuts with
containment off, with a Wilson interval of 57.49% to 65.70%. That restricted
exam fails by a wider margin under the semantics this repository implements
than under the cell it was measured in.

<!-- numeral-src: 33.60% :: b51-real-merge-traces/scorecard.json#measurements.regenerated.lazyEnforced.spatialFiredFalseConflictRate -->
<!-- numeral-src: 61.68% :: b51-real-merge-traces/scorecard.json#measurements.regenerated.derivedOff.spatialFiredFalseConflictRate -->
<!-- numeral-src: 57.49% :: b51-real-merge-traces/scorecard.json#measurements.regenerated.derivedOff.spatialFiredFalseConflictRateWilson95.low -->
<!-- numeral-src: 65.70% :: b51-real-merge-traces/scorecard.json#measurements.regenerated.derivedOff.spatialFiredFalseConflictRateWilson95.high -->

## 6. What this says about the open finding

The finding is that the spatial predicate is unfalsifiable: it had never
produced a true conflict, so nothing about it could be adjudicated. Three
things follow from the measurements above, and only the first two are entitled
to any weight.

1. **It stays open, and B5.1 did not close it.** The exam that would close it
   is a real-trace rate and the corpus cleared none of the six criteria. This
   bet cannot be quoted as the adjudication, and its own artifact says so in a
   field.

2. **The rule is falsifiable but nearly worthless where the code lives.** In
   the cell matching this repository, the spatial rule fires alone 318 times
   per eight thousand schedules and is right 5 of those times: a precision of
   **1.57%**. It is not unfalsifiable any more -- it does fire truthfully --
   but a rule that is wrong in almost every case where it is the only thing
   speaking is not carrying the argument that was built on it.

<!-- numeral-src: 318 :: b51-real-merge-traces/scorecard.json#measurements.regenerated.derivedOff.spatialOnlyFlagged -->
<!-- numeral-src: 1.57% :: b51-real-merge-traces/scorecard.json#measurements.regenerated.derivedOff.spatialOnlyPrecision -->

3. **The keep verdict has lost its remaining support.** It rested on the rule
   being the only thing that catches the residual hosting hazard. Clause
   `b51-p1c` shows a read-set check catches all of them, in every cell, with no
   geometry. The rule now buys replay-cost avoidance and nothing else, and it
   buys it at that precision.

## 7. Null-space audit

**What the scored observable is invariant under.** Ground truth in this battery
is a canonical serialization of the model state, and that serialization
contains exactly the storey vocabulary and, per entity, its node id, key, IFC
type, storey identifier, host, property sets and meshes. It is therefore blind
to everything else: every relationship other than the host-to-opening link,
units, classification, type assignment, material association, and the order of
operations inside one client.

The first candidate this audit tried was the hosting relation, on the reasoning
that the footprint rule excludes relationship-kind ancestors. **That was
wrong** -- hosting was added to the canonical bytes -- and it is recorded here
rather than quietly dropped, because a null-space audit that only reports the
candidate that worked is a null-space audit that stopped looking.

**Where it actually is: spatial-structure membership.** The relationship node
that aggregates a storey elements exists only in the derived graph, never in
the state, and nothing in the operation vocabulary writes it. So the battery
contains no instance of the one operation class the footprint module own
docstring names as outside its soundness argument: an operation that targets a
relationship node directly. The module says, of itself, that if a future
operation kind targets containers directly then the rule needs revisiting. The
exam that is supposed to adjudicate the predicate cannot generate that
operation, so it has never been revisited.

**The check that is not invariant, and what it found.** The audit adds one
operation kind -- setting a storey membership list, which is an ordinary edit
to a spatial-containment relationship -- and asks the predicate under test,
unmodified, about a pair consisting of that edit and a concurrent move of one
of the listed elements. The predicate clears the pair, because the element
edit ancestor walk excludes the storey node and the two footprints are
disjoint. The two orders then diverge. It is asserted positively: the run fails
if the predicate does not clear the pair, and fails if the orders do not
diverge.

**What that establishes, and what it does not.** It establishes a property of
this predicate: the soundness argument the footprint module states about itself
excludes operations that target a container node directly, and on exactly such
a pair the predicate clears a divergence. That stands.

**The first version of this section said "an unsound auto-merge, in shipped
code, on an operation the product supports". That was wrong, a reviewer caught
it, and it is corrected here rather than quietly reworded.** Both halves of the
qualifier fail:

- *Not shipped.* The predicate lives in `packages/provenance`, whose manifest
  is private and whose own description calls it a prototype, and no other
  package in this repository depends on it. No user edit is routed to it by
  anything.
- *A different merger owns the real operation.* The product does support
  containment edits, as `set-child` and `remove-child` in `packages/merge`, and
  that package's three-way planner classifies a concurrent divergence on a
  child slot as a **hierarchy conflict** rather than auto-merging it. On the
  path a user can actually reach, this pair is refused, not cleared.

A user *can* cause a spatial-containment change through a shipped path --
publishing a layer whose delta carries `children` opinions, which the CLI
recognises explicitly as a distinct write capability -- but that change goes to
the merger above and never to the predicate audited here. The viewer cannot
cause one at all: the collaboration document interface the viewer is given has
no containment writer in it.

So the correct claim is about the exam, not about the product: **the battery
cannot generate the one operation class the footprint module names as outside
its own soundness argument, so that caveat has never been tested.** The
reachability facts are recorded as fields on the null-space result in the
scorecard, beside the verdict, so the two cannot be read apart.

## 8. Privacy

The guard was written before the first artifact and is the only write path;
there is no second one. It has two nets. Net one is an allowlist: a string
reaches a committed artifact only if it is a number, a day-precision date, a
digest, a semantic version, a dotted field path or a repository path -- or if
it can be accounted for in a declared set of committed source files. Net two is
a raw substring and pattern scan over the serialized bytes, with no parsing at
all, so it cannot lose quote parity the way the guard it is a reaction to did.

**The guard failed its own proof twice before it passed, and both failures are
the interesting part.**

The first version had a general prose shape. An authored element name went
through both nets untouched and would have been written to a committed file --
the same class of defect as the guard this one is modelled against, reached
from a different direction. A shape rule cannot separate a measurement from a
name, because names are shaped like words. That is what forced the allowlist to
be about provenance rather than appearance.

The second version quoted three of its own planted tokens in its explanatory
comments, and since net one accounts for strings by finding them in the
declared source corpus, three proof cases silently stopped being caught. The
plants now live in a file that is deliberately outside the corpus.

**The third failure was found by review, not by the proof, and it is the same
blindness a third time.** Half B of net one had a word-level fallback: a string
was accounted for when every one of its words appeared somewhere in the corpus.
That is vocabulary, not provenance. A real authored model name assembled out of
ordinary words the corpus happens to contain passed with nothing verbatim
behind it, and net two only stops such a phrase if the operator happened to
list that exact phrase -- which for a name nobody anticipated is precisely what
does not happen. This is the same shape as the two failures above and as the
quote-parity defect the guard was built against: a test that asks what a string
*resembles* instead of where it *came from*.

The fallback is gone. A string is now accounted for only if the corpus contains
it. The reason a fallback existed is real -- source composes prose across
adjacent string literals and line breaks, so a sentence is often not a
byte-for-byte substring of the file that built it -- and is handled by
reconstructing the corpus before the test rather than by loosening it: adjacent
quote-plus-quote joins are spliced out and whitespace runs are collapsed. That
recovers the sentence the source does emit and can never assemble a phrase the
corpus does not contain in order. Every string in every artifact this bet
writes is still accounted for; none of them needed the fallback.

**The proof as it stands:** 9 planted cases, all of them caught, each by the
net it was aimed at -- a case caught only by the other net counts as failed,
because two lines of defence sharing one hole are one line of defence. The
ninth is the recombined name above. A clean control artifact passes, without
which every catch above would be satisfied by a guard that rejects everything.
No planted token is written to any artifact; findings carry a digest prefix and
a length.

<!-- numeral-src: 9 :: b51-real-merge-traces/scorecard.json#guard.casesRun -->

## 9. Red run

`--red` constructs, for each assertion this exam makes, the specific violation
that assertion exists to detect, and requires the same assertion path that
produces the green verdict to reject it. All 6 tripwires fire: a corpus one
criterion short being called admissible; the lazy-cell count graded against the
derived-cell bar; a read-set variant that admits one more unsound auto-merge
than the full predicate; a rate above the kill bar called a pass; a planted
identifier driven through the real write path; and the null-space construction
failing to produce a divergence. Evidence in `red-run.json`.

<!-- numeral-src: 6 :: b51-real-merge-traces/red-run.json#tripwiresTotal -->

## 10. Caveats, including the one against the headline

1. **Against the headline.** The strongest claim here -- that the spatial rule
   can be deleted in favour of a read-set check -- is measured on the same
   synthetic generator whose inadequacy is this bet other finding. The read-set
   check is being asked about a population containing exactly one relationship.
   On a real corpus with material associations, type assignments and
   connectivity, a read-set over relationship targets has far more edges to get
   right, and nothing here shows it would.

2. The census counts depend on a gitignored directory outside the repository
   and are not reproducible from a clean checkout. The artifact records that in
   a field rather than leaving a reader to work it out.

3. Eight seeds is more than one and is not many. The per-seed arrays are
   emitted in full so the spread can be read directly instead of trusted.

4. The guard has now survived three failures. Two were found by its own proof;
   the third was found by a reviewer, which is the interesting part -- the
   proof had eight cases and none of them was a phrase recombined out of corpus
   words, so the proof was passing over a hole it had not been asked about. A
   ninth case now covers it. There is no claim that a fourth does not exist,
   and the third failure is direct evidence that the proof's coverage, not just
   the guard's logic, is the thing to distrust.

5. The census counts independent origins from operator-declared metadata, one
   origin per supplied trace root by default. The registered bar of three
   deployments is unchanged; what changed is that the meter can now reach it.
   Before this correction the metric collapsed every non-demo corpus to one, so
   no input could ever have cleared the bar and a failure to clear it carried no
   information. The observed value on the corpus measured here is zero either
   way, so no figure in this report moved.

## 11. Reproducing

```
pnpm --filter @ifc-lite/provenance build
node scripts/moonshot/b51-real-merge-traces/run.mjs --self-test
node scripts/moonshot/b51-real-merge-traces/run.mjs --red
node scripts/moonshot/b51-real-merge-traces/run.mjs
```

The census defaults to the repository own data directory, which does not exist
in a clean checkout; pass `--trace-root <dir>` to point it at a real one, and
`--forbid-file <path outside the repo>` to hand net two a corpus denylist. The
committed run used both.

`--trace-root` may be repeated, and each supplied root counts as one
independent origin provided it holds at least one room log this repository own
examples did not open. A root that aggregates traces from several deployments
may say so with an `origins.txt` beside them, one label per line; the labels
are counted and discarded, never read into an artifact.
