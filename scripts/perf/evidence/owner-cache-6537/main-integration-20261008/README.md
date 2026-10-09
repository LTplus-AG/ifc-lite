# Main integration and inherited gate correction

The b513 CI merge failed because main introduced an intentional source-class point read in a reviewed material module without the required explanation. Looking up the original class is necessary to invalidate forwarded evidence after deletion/retyping; replacing it with the effective class could retain stale material fields. The integration adds that explanation without changing the algorithm or gate budget.

The frozen source, independent reasoning, failed/restored gate and actual controls are in receipt.json. All six previously qualified alias/release/control modules are byte-identical. Integrated geometry/cache controls pass 70/70; material evidence passes 20 with one absent-fixture skip. Full root typecheck covers 3726 test sources. These are functional controls and source integration evidence, not native performance or OS memory acceptance. The parent charter remains open.

The historical wiring entry in `receipt.json` records the original decompressed
log hash. [The integrity supplement](../historical-source-integrity.json) names
that scope and records the gzip archive hash separately. The original receipt
and raw log bytes are unchanged.
