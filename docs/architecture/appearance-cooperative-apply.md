# Cooperative appearance Apply

The viewer's internal `commitAppearance` command returns a promise. Its controller must await completion, prevent a second Apply, and abort preparation when the draft or target changes. `onProgress` reports `preparing`, `validating`, and `publishing`; every callback runs before any IFC installation.

Entity operations are prepared through `StoreEditor.prepareEntityOperations`. The shared appearance validator also serves the standalone synchronous entity API. Prepared effects and mutation records supply owned history values, replacing the previous synchronous draft-only appearance helper. No draft view or publication graph escapes the mutations package.

The command retains its earlier source checkpoint and checks it again after asynchronous preparation. The final phase has no await: it installs the reversible IFC checkpoint, captures the after-dependency guard, prepares asset/history/GPU ownership, and publishes geometry with the single existing Undo entry. Any failure before that publication restores IFC and releases provisional resources. SDK edits, model replacement, cancellation and callback failures do not publish a partial command.

The appearance consumer uses a bounded cumulative allocation allowance of 2 GiB and 32 million work steps. This counts all private copies over the job; it is not a measured live-heap limit or an allocation reservation. The mutations API's smaller defaults remain unchanged. The actual public Convento regression exercises the first and second entire-model planar applications within this allowance; exceeding a bound reports failure and preserves the prior model. It does not fall back to blocking synchronous preparation.

When available, the browser's `scheduler.yield()` provides host-task scheduling without chained timer clamping. The fallback is a host timer. Neither path replaces exact synchronous comparison of escaped SDK values: source/dependency guards, final installation and history/GPU publication still perform synchronous work. This slice therefore requires actual interaction measurement and does not claim a universal frame-time bound or completion of the responsiveness issue.
