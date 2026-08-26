---
"@ifc-lite/parser": patch
---

Drop an `IfcElementQuantity` that carries no quantities, on both read paths.

`Quantities` is `SET [1:?] OF IfcPhysicalQuantity` in IFC4 and IFC4X3, so an
empty set is non-conformant data. The type path already dropped one; the
instance path kept it, because its guard fell back to a synthetic
`QuantitySet #<id>` name and so was true for every set. The same broken set
therefore read one way if it hung off the occurrence and the other way if it
hung off the type — as did a set written non-empty that walks to nothing, such
as one holding only unresolvable references or complex quantities.

A named set with zero quantities asserts "this element has quantities" on the
strength of its name alone. `ifc-lite validate` counted such an element as
quantified, so a file whose elements carried only empty sets reported no
`quantity-completeness` issue at all; an IDS quantity-set existence check passed
on nothing; and a phantom occurrence set suppressed the viewer's fallback to the
quantities the element's type carries, hiding real numbers.

The per-set read now lives in the shared quantity reader alongside the walk over
`Quantities`, so the two paths cannot disagree about it again.
