---
"@ifc-lite/solar": patch
---

Fix `dayPath`, `analemmaPaths`, and `domeGraticule` hanging indefinitely (infinite loop, not a crash) on a non-positive or `NaN` step option. Each function drives a `for (...; x += step)` loop from a caller-supplied option — `stepMinutes`, `dayStep`, `altitudeStep`, `azimuthStep`, `resolution` — none of which were validated. A value of `0` (or negative, or `NaN`) left the loop variable unchanged forever, blocking the process with no error. Confirmed live: `dayPath(date, lat, lon, { stepMinutes: 0 })` did not return within an external 5-second `timeout` wrapper before this fix. All five options now throw a descriptive `Error` synchronously for `value <= 0` or `NaN` instead of hanging; valid (positive) values behave exactly as before.
