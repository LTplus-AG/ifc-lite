# Emitting location zones as IFC entities (design)

**Status:** decided, partly built. The property/quantity write-back ships
(#2508 item 3b). `IfcZone` emission is **refused** on schema grounds.
`IfcSpatialZone` is the correct vehicle for the zone boxes themselves and is
deferred to its own PR, with the shape below.

Issue #2508 asks the question rather than assuming the answer: "Whether
user-drawn takt boxes *should* become `IfcZone` is a genuine modelling
question, not an obvious yes". This is the argument.

## What a location zone is

A zone (`apps/viewer/src/lib/zones/types.ts`) is a user-drawn oriented box in
the **viewer's** world frame: a construction section, a takt area, a delivery
sequence. It has a name, a colour, a stable id, and no relationship to the
model's spatial structure. Elements are classified into it geometrically, by
where their geometry actually is, and an element can be in several zone sets at
once ("Section 2" and "Takt Area B").

Three properties matter for what follows:

1. A zone is **not a room**. Nothing bounds it, nothing was designed to it, and
   it usually cuts through walls and slabs rather than following them.
2. An element can belong to **several zones at once**, which is the entire
   point of #2508: the straddlers are the interesting population.
3. Zones are **planning state**, not design state. They change when the
   programme changes, several times a week, and two people planning the same
   building will draw different ones.

## `IfcZone`: no

`IfcZone` is a grouping of **spaces**. Its `IsGroupedBy`
(`IfcRelAssignsToGroup`) accepts `IfcSpace`, `IfcSpatialZone` and nested
`IfcZone` only; a wall is not an admissible member. This repo already reads it
that way: `extractGroupMembersOnDemand`
(`packages/parser/src/on-demand-extractors.ts`) documents an `IfcZone`'s
members as the `IfcSpace` / `IfcSpatialZone` ones, and the GROUPS panel (#1672)
browses them on that assumption.

So emitting takt boxes as `IfcZone` with walls and slabs assigned to them
produces a file that our own reader would mis-describe and a validator would
reject. The attraction is only that the word matches; the semantics do not.
Refused.

## `IfcGroup`: possible, and it says nothing

`IfcRelAssignsToGroup` onto a plain `IfcGroup` accepts any
`IfcObjectDefinition`, so the schema permits assigning walls to a group named
"Takt Area B". It is the unconstrained fallback, and that is also its problem:
a plain group carries no spatial meaning, so a receiving tool learns that these
elements are *associated*, not that they occupy a *region*. It also cannot
express a straddler honestly, because group membership is a yes/no while a
straddling wall is 40% one and 60% the other.

Worth having only if a specific downstream consumer asks for groups. It is a
transport, not a model.

## `IfcSpatialZone`: yes, and it is a separate PR

`IfcSpatialZone` (IFC4) is exactly this concept: a spatial region that is
"not necessarily bounded by physical elements", intended for thermal,
lighting, occupancy and **construction** zones, with a `PredefinedType` that
includes `CONSTRUCTION`. It carries an `ObjectPlacement` and a
`Representation`, so the box a user drew can be emitted as geometry rather than
described in prose. This repo already surfaces it (#1094, #1075).

Two schema details make it fit where `IfcZone` does not:

- Elements are attached with **`IfcRelReferencedInSpatialStructure`**, which is
  many-to-many and *additive*. It does not disturb
  `IfcRelContainedInSpatialStructure`, which is exclusive and holds the
  building's real hierarchy. The parser already indexes the referenced
  relation (`packages/parser/src/columnar-parser-indexes.ts`), so a file we
  emit is a file we can read back.
- A straddler can be referenced in **both** zones, which is the truthful
  statement of the topology.

### What it does not solve

Referencing says *this element reaches this zone*. It cannot say *this element
is 40% in this zone*, which is the number #2508 exists to produce. So an
`IfcSpatialZone` emission is complementary to the quantity write-back, never a
replacement for it: the zone entity carries the region, the quantity set
carries the split.

### Why it is deferred rather than done here

- It writes new **spatial** entities into someone else's model, which is a
  heavier act than adding property sets, and needs its own review and its own
  opt-in.
- It needs a placement chain and a swept-solid or brep representation in IFC
  **Z-up**, converted out of the viewer's Y-up frame, anchored on the site.
  That is geometry authoring, not data authoring.
- Zones change several times a week (property 3 above). Baking planning state
  into the spatial structure of a design model is a decision a user should make
  deliberately, on export, not as a side effect of drawing a box.

## What ships instead, and why it is the right default

The property and quantity write-back (#2508 item 3b,
`apps/viewer/src/lib/zones/writeback.ts`):

- is **additive and reversible**: it touches no spatial structure and the panel
  removes exactly what it wrote;
- expresses the straddler honestly, as a per-zone volume breakdown that sums to
  the whole;
- lands in the one place every downstream tool already looks, which is what the
  reporter of #1763 was doing by hand in a spreadsheet.

## If the `IfcSpatialZone` PR is written

Sketch, so the next person does not re-derive it:

- One `IfcSpatialZone` per zone, `PredefinedType = CONSTRUCTION`, `LongName` =
  the zone set's name, `Name` = the zone's name.
- Placement relative to the site, representation as an extruded rectangle
  profile carrying `rotationY` in the placement rather than in the profile.
- `IfcRelReferencedInSpatialStructure` per zone, listing every element the
  assignment says it touches (not just the elements whose home it is).
- Aggregate the set's zones under one `IfcZone` **only** if every member is an
  `IfcSpatialZone`, which is admissible and is the one legitimate use of
  `IfcZone` here.
- Emit alongside the property sets, never instead of them.
