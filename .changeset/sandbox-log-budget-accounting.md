---
"@ifc-lite/sandbox": patch
---

Stop captured log entries that cannot be sized from escaping the sandbox's host-memory budget.

The bridge caps captured console output twice: by entry count (1000) and by cumulative serialized size (4 MB), because `vm.dump` copies sandbox values onto the host heap, which the QuickJS memory limit does not bound. The size charge came from `JSON.stringify`, and when that threw the entry was charged zero bytes and retained anyway. A top-level `BigInt` is the value that reaches the host in that state — it survives `vm.dump` intact but has no JSON form, and QuickJS will allocate one of a million bits — so a script could park up to 1000 such values, tens of megabytes, that the byte budget never saw. (An object the VM cannot serialize never got that far: `vm.dump` already flattens it to the string `"[object Object]"`.)

The bridge now refuses to retain what it cannot size. When sizing an entry fails, each argument is sized on its own: arguments that serialize are kept untouched, and only those that do not are replaced by bounded text, charged at exactly the length of that text. Retained memory is therefore always what the budget can see. Serializable logs are sized and capped exactly as before.

**Embedder-visible:** `LogEntry.args` no longer contains `BigInt` values. A small BigInt is retained as its literal text (`42n`), a very large one as `[BigInt too large to retain]`; other arguments on the same line are unaffected, so the log still shows which script logged what. The failure is reported to the host console once per sandbox context — not once per entry, since the trigger is script-supplied.
