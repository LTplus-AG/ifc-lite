# @ifc-lite/solar

## 1.15.4

### Patch Changes

- [#2329](https://github.com/LTplus-AG/ifc-lite/pull/2329) [`fffc0ee`](https://github.com/LTplus-AG/ifc-lite/commit/fffc0ee91c0c7c63955993faf470fa0581303005) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `dayPath` and `analemmaPaths` failing silently on a non-positive, `NaN`, or too-small `stepMinutes`/`dayStep` option. Each drives a `for (...; x += step)` loop from a caller-supplied option that was not validated. A value of `0` (or negative) left the loop variable unchanged forever, blocking the process with no error — confirmed live: `dayPath(date, lat, lon, { stepMinutes: 0 })` did not return within an external 5-second `timeout` wrapper before this fix. `NaN` does not hang: `x += NaN` makes the loop variable `NaN`, and the next bound comparison is then always false, so the loop exits after a single iteration instead of running forever — a truncated result, not a hang.

  `stepMinutes` and `dayStep` now throw a descriptive `Error` synchronously when the value is not finite or not `> 0`, instead of failing silently. They also reject a positive value too small to actually advance the loop at its upper bound (e.g. `Number.MIN_VALUE`, where floating-point addition can leave `bound + step === bound` unchanged) — the same hang reached through a different input. (`domeGraticule`'s `altitudeStep`, `azimuthStep`, and `resolution` already had both of these guards as of [#2413](https://github.com/LTplus-AG/ifc-lite/issues/2413), released in 1.15.3; `domeGraticule` is not touched by this change.) Valid (positive, sufficiently large) values behave exactly as before.

  Note this guard closes the _absorbed-step_ subclass of the hang — a step small enough that float addition cannot move the accumulator at all. A positive step too small to be practical but still large enough to advance (roughly `1e-13`–`1e-3` near these bounds) is not rejected and can still drive an impractically long loop; that is a separate, narrower gap than the one this fix closes.

## 1.15.3

### Patch Changes

- [#2413](https://github.com/LTplus-AG/ifc-lite/pull/2413) [`5ad0f69`](https://github.com/LTplus-AG/ifc-lite/commit/5ad0f6915de9e0c06ef31165d4ee0fbb9b4b0d6c) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `domeGraticule` hanging on a non-positive or denormal `altitudeStep`, `azimuthStep` or `resolution` (e.g. `0` or `Number.MIN_VALUE`): a denormal step is too small to advance its loop's accumulator (`90 + Number.MIN_VALUE === 90`), so the loop never terminated. Each option now has a finite, positive, bound-relative guard — `altitudeStep` against its loop's bound of 90, `azimuthStep` against its bound of 360, `resolution` against 360 (the larger of the two bounds it drives, which also covers its 90-bounded use). `NaN` for `altitudeStep` and `resolution` was already rejected immediately (not a hang) and still is; `NaN` for `azimuthStep` previously returned a graticule with only the azimuth-0 spoke and now throws. Legitimate fine-grained values (e.g. `altitudeStep: 0.5`, `resolution: 0.1`) are unaffected.

## 1.15.2

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

## 1.15.1

### Patch Changes

- [#1676](https://github.com/LTplus-AG/ifc-lite/pull/1676) [`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39) Thanks [@louistrue](https://github.com/louistrue)! - Docs refresh: correct stale README claims and API samples against the current codebase; add READMEs to the ten published packages that shipped without one (cli, create, sdk, sandbox, lens, lists, embed-sdk, embed-protocol, encoding, viewer-core).

## 1.15.0

### Minor Changes

- [#1069](https://github.com/LTplus-AG/ifc-lite/pull/1069) [`49d146a`](https://github.com/LTplus-AG/ifc-lite/commit/49d146a653f65eb5e265347ed6a9e9e7a21589a4) Thanks [@louistrue](https://github.com/louistrue)! - Add `@ifc-lite/solar`: a dependency-free package for solar position (NOAA
  algorithm), sunrise/sunset/solar-noon, and 3D sun-path dome geometry (day
  paths, hourly analemmas, graticule) emitted as ENU unit vectors for the
  georeferenced viewer.
