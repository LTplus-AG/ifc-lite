---
"@ifc-lite/pointcloud": minor
---

E57 ScaledInteger codec — bit-packed cartesian / intensity / colour.

ScaledInteger is the more compact encoding most real-world Faro,
Trimble, and Leica E57 exports use; previously we threw a clear
error on these files. This change implements the decoder so they
load directly.

Per spec ASTM E2807-11 §6.3.4:
- `bitsPerRecord = ceil(log2(maximum - minimum + 1))`
- Bytestream stores `raw_int = original − minimum` packed LSB-first
  within each byte; decoded float = `(raw_int + minimum) * scale + offset`

Implementation:
- New `readBitsLE(bytes, bitOffset, bitsPerRecord)` walks a byte
  buffer and reconstructs each value into a JS number using
  `Math.pow(2, n)` instead of `<< n`, so precision holds up to 53
  bits (covers every real exporter — LiDAR + survey kit tops out
  around 32 bits). Wider fields throw a clear error.
- `readCartesianStream` and `readIntensityStream` now branch on
  field kind: Float / Integer paths unchanged, ScaledInteger path
  bit-walks per record.
- `writeColorChannel` extended with a ScaledInteger branch that
  remaps `raw → [0, 1]` via the declared min/max range.
- Per-axis packet capacity computation now varies by field kind
  (Float = `length / byteSize`, ScaledInteger = `length * 8 / bitsPerRecord`)
  via `floatOrSiPointCapacity`.

The "ScaledInteger throws clearly" error is removed for cartesian,
intensity, and colour — all three now decode. The earlier multi-scan
pose rejection stays in place; that's a separate piece of work.

2 new tests:
- 8-bit ScaledInteger across all three cartesian axes (round-trip
  through known raw values).
- 12-bit ScaledInteger that crosses byte boundaries (proves the
  bit-pack walk is correct for non-multiples-of-8).

Verified: 63 pointcloud unit tests pass, full repo typecheck (24/24),
viewer Vite build green.
