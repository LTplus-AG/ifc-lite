---
"@ifc-lite/sandbox": patch
---

Make the captured-log byte budget an actual ceiling.

The bridge caps captured console output by cumulative serialized size (4 MB), because `vm.dump` copies sandbox values onto the host heap, which the QuickJS memory limit does not bound. The check ran *before* an entry was sized: it compared the running total against the budget, then retained the entry unconditionally, so a single oversized argument (e.g. one `console.log` of a 40 MB string) was retained in full — the check only caught up on the next call, by which point the overshoot was already on the host heap and bounded only by whatever the script chose to log.

The check now runs against the entry about to be added, before it is retained: an entry that would push the cumulative total over the 4 MB budget is refused and replaced by the truncation marker instead of being kept. This is a deliberate behavior change — a script logging one very large payload now sees truncation on that call rather than after it, and the existing boundary test's expectations moved accordingly (three full 1 MB entries plus a marker, not four).

The entry-count cap (1000 entries) is unchanged: it increments by exactly one per call, so its overshoot was already bounded to a single entry and does not have the same unbounded-overshoot shape.
