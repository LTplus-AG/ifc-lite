# Evaluated occurrence appearance policy (F6, #4404)

Image and finite-page requests keep `representationPolicy: "preserve"` by
default. `"evaluatedOccurrence"` explicitly permits the supported occurrence's
parametric Body to become evaluated tessellation. A viewer must explain this
tradeoff and show the converted products before Apply. Discard publishes nothing;
conversion and appearance belong to one mutation/history operation.

The first supported path is a mapped `IfcElement` occurrence with a uniquely
owned `IfcProductDefinitionShape` and one uniquely owned Body shape wrapper.
The wrapper may have ordinary presentation-layer membership. Its Items and
RepresentationType change in place; its identity, context, layer membership,
product placement, product identity, properties and semantic relationships stay
intact. Non-Body curve and bounding-box wrappers remain untouched. Shared mapped
items, representation maps, type products, source styles and sibling occurrences
are never edited. Retaining the occurrence wrapper avoids creating orphaned
ProductDefinitionShapes or accidentally sharing shape wrappers contrary to
IfcShapeModel.WR11.

The canonical element-production funnel evaluates the original occurrence.
The first slice requires one unambiguous mesh and one explicit source surface
style. New tessellation coordinates use the inverse rigid product placement,
restoring mesh origin and RTC once, in source length units. Canonical reopening
must reproduce every oriented triangle corner exactly and retain the original
colour/material before the requested appearance is applied. A bounded single
IfcPresentationStyleAssignment wrapper can be flattened while keeping its
surface-style definition. The native image/page planners consume this private
typed source overlay and return one composite mutation plan, with original-item
provenance in `conversions`. Edits targeting private newly created rows are folded
into their creation records before returning the plan.

Unsupported cases remain diagnostics: opening-bearing products (including voids
propagated through aggregates), StandardCase subclasses, shared Body/PDS wrappers,
shape aspects, styled presentation layers, additional renderable representations,
multiple meshes or ambiguous/inherited styles, mapped-chain and nested geometry
style overrides (even with matching colour), material-layer slicing, existing
textures, and ExistingUv conversion. No alternate visible Body is added. These
are first-slice limits, not claims that IFC cannot represent the cases.

Opening conversion is deliberately not enabled by this policy. buildingSMART
distinguishes subtractive opening Body geometry from Reference geometry accompanying
an already-cut host. Our geometry path must honor that distinction before baked
opening surfaces can be published while retaining the opening relationships.
See [IfcOpeningElement semantics](https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcOpeningElement.htm).

The real IFC4 fixture is AC20-FZK-Haus from the fixture manifest, SHA-256
`ea6f04eaf92fac4d7ad0038bc3d2dfea4c094dd3f516ecc33c50bf1835ca108d`.
Mapped IfcMember 35169 is one of 42 members sharing a type; its Body wrapper is
35155 and evaluated source geometry item is 35135. Native tests compare all
unselected meshes unchanged and the selected oriented world corners exactly,
exercise finite-page composition, and refuse direct/inherited openings and shared
wrappers. Independent IfcOpenShell checks compare new violations against the
source's existing validation findings; the original model is not schema-clean.

Composite output uses ascending, contiguous created IDs from `nextExpressId`.
Private conversions rejected by the final appearance pass leave no allocator
gaps. Generated references, replacement-item provenance and page image bindings
are rebound together before the plan leaves Rust; host allocation checks remain
strict.
