---
"@ifc-lite/solar": patch
---

Fix `dayPath` and `analemmaPaths` failing silently on a non-positive, `NaN`, or too-small `stepMinutes`/`dayStep` option. Each drives a `for (...; x += step)` loop from a caller-supplied option that was not validated. A value of `0` (or negative) left the loop variable unchanged forever, blocking the process with no error — confirmed live: `dayPath(date, lat, lon, { stepMinutes: 0 })` did not return within an external 5-second `timeout` wrapper before this fix. `NaN` does not hang: `x += NaN` makes the loop variable `NaN`, and the next bound comparison is then always false, so the loop exits after a single iteration instead of running forever — a truncated result, not a hang.

`stepMinutes` and `dayStep` now throw a descriptive `Error` synchronously when the value is not finite or not `> 0`, instead of failing silently. They also reject a positive value too small to actually advance the loop at its upper bound (e.g. `Number.MIN_VALUE`, where floating-point addition can leave `bound + step === bound` unchanged) — the same hang reached through a different input. (`domeGraticule`'s `altitudeStep`, `azimuthStep`, and `resolution` already had both of these guards as of #2413, released in 1.15.3; `domeGraticule` is not touched by this change.) Valid (positive, sufficiently large) values behave exactly as before.

Note this guard closes the *absorbed-step* subclass of the hang — a step small enough that float addition cannot move the accumulator at all. A positive step too small to be practical but still large enough to advance (roughly `1e-13`–`1e-3` near these bounds) is not rejected and can still drive an impractically long loop; that is a separate, narrower gap than the one this fix closes.
