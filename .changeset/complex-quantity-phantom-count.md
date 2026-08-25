---
"@ifc-lite/parser": patch
---

Stop reading `IfcPhysicalComplexQuantity` as if it were a simple quantity.

A complex quantity groups other quantities rather than carrying a measure, so
its `HasQuantities`/`Discrimination`/`Quality`/`Usage` attributes sit where a
simple quantity keeps `Unit` and its value. Both quantity readers assumed the
simple layout: the type fell through to `QuantityType.Count` and slot 3 — a
label, not a number — settled at `0`, so every complex quantity surfaced as a
phantom `Count = 0` bearing the complex quantity's name. That row satisfied IDS
existence requirements, counted as "has quantities" in `validate`, entered the
compare fingerprints and rendered as a bogus quantity card.

Complex quantities are now skipped, matching what the legacy quantity extractor
already did for a type it did not recognise. The walk over
`IfcElementQuantity.Quantities` also moved into one shared reader, so the
instance path and the type path can no longer drift apart.

Quantities nested inside a complex quantity remain unreported, as before.
