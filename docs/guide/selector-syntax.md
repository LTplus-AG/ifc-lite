# Selector Syntax

IFClite reads the [IfcOpenShell selector (filter) syntax](https://docs.ifcopenshell.org/ifcopenshell-python/selector_syntax.html)
— the one-line form used by Bonsai and by `ifcopenshell.util.selector` — and turns it
into filter rules.

Type it into the **Selector** field at the top of the viewer's Filter tab, or parse it
yourself with `parseSelector` from `@ifc-lite/query`.

Not every construct has a rule behind it yet. The ones that do not are listed back to you
by name; nothing is dropped in silence. What is missing is tracked in
[issue #4094](https://github.com/LTplus-AG/ifc-lite/issues/4094).

## The grammar

```text
selector := group ("+" group)*        groups are unioned
group    := filter ("," filter)*      filters narrow left to right
```

| Filter | Example | Means |
|---|---|---|
| Class | `IfcWall` | the class **and all its subclasses** |
| Class, subtracted | `! IfcWall` | remove that class and its subclasses |
| GlobalId | `325Q7Fhnf67OZC$$r43uzK` | one element, by GlobalId |
| Attribute | `Name=D01` | an IFC attribute of the element |
| Property | `Pset_WallCommon.FireRating=2HR` | a property in a property set |
| Type | `type=WT01` | the relating type's Name |
| Material | `material=concrete` | a material Name or Category |
| Classification | `classification=Pr_25` | a classification reference |
| Location | `location="Level 3"` | the spatial element containing it |
| Parent | `parent=Foo` | a descendant of the element named Foo |
| Value query | `query:types.count=0` | a value-query key path |

Operators: `=`, `!=`, `>`, `>=`, `<`, `<=`, `*=` (contains), `!*=` (does not contain).

Values, and property-set and property names, come in three spellings:

| Spelling | Example | Notes |
|---|---|---|
| bare | `concrete` | no spaces, no `,` `+` `=` `!` `<` `>` `*` `"` `/` |
| quoted | `"Level 3"` | `\"` and `\\` escape inside |
| regular expression | `/D[0-9]{2}/` | unanchored, **case-sensitive** |

Quoting is what forces a **literal**: `"/Wall/".FireRating` looks for a property
set actually named `/Wall/`, not a pattern. It works in either position, so
`Pset_BeamCommon."IsExternal"` and `/Pset_.*Common/."IsExternal"` are both valid.

`NULL` (any case, unquoted) is the null literal, so `FireRating != NULL` means "has a
FireRating". `TRUE` and `FALSE` are compared as the strings IFC property sets render
them (`True` / `False`), case-insensitively.

There is **no `*` wildcard**. `IfcWall*` is a syntax error, not a match-nothing: `*`
exists only as part of `*=`. Use a regular expression for wildcards.

## What works in the viewer today

| Construct | Viewer Filter tab | Notes |
|---|---|---|
| `IfcWall`, several classes, `!` subtraction | ✅ | subclasses included, per the model's schema |
| `Name=`, `!=`, `*=`, `!*=` | ✅ | case-insensitive |
| `Name=/regex/` | ✅ | case-sensitive |
| `PredefinedType=`, `!=` | ✅ | no regex |
| `Pset.Prop` with all eight operators | ✅ | |
| `Pset.Prop = NULL` / `!= NULL` | ✅ | becomes "is not set" / "is set" |
| `/Pset_.*Common/.Prop` regex set or property name | ✅ | one rule reaches several sets |
| `Qto_….Quantity > 10` | ⚠️ | only a `Qto_` set, and only a numeric comparison — see below |
| `material=` | ✅ | matches a material **Name or Category** |
| `classification=`, `= NULL`, `!= NULL` | ✅ | matches the code or the name |
| `location="Level 3"` | ✅ | reaches one level through a containing space — see below |
| GlobalId terms, `! <GlobalId>` | ✅ | several terms union (add) or subtract, mirroring class terms |
| `GlobalId=`, `GlobalId!=` | ✅ | reuses the same globalId rule the bare term builds; `*=`, `>`/`>=`/`<`/`<=`, `/regex/`, and `NULL` are reported |
| `Description=`, `ObjectType=`, `Tag=`, any other schema attribute | ✅ | all eight operators, `= NULL` / `!= NULL` as presence — see below |
| `type=WT01` | ✅ | matches the relating type's Name; `=`, `!=`, `*=`, `!*=` and `/regex/`, like `Name=` — no `>`, `>=`, `<`, `<=` |
| `parent=Foo` | ✅ | any ancestor's Name, walking containment **and** aggregation to any depth — see below |
| `query:` | ❌ | **deliberately** out of scope — see below, not "not supported yet" |
| `+` unions of groups | ✅ | real OR-of-AND groups — see below |

### `+` unions

`IfcSlab, material=concrete + IfcDoor` becomes two filter groups, OR'd
together — every slab whose material is concrete, plus every door — the
same as two separate filters would match, unioned. Each `+`-separated
clause is its own AND group internally; only `+` combines groups.

An unsupported construct anywhere in a union refuses the **whole** query
rather than applying the readable groups: a dropped OR branch would
silently narrow what the union matches, with nothing shown to say so. A
selector with no `+` at all keeps applying what it can and naming the
rest, as it always has.

### Which quantities a selector can reach

Quantities are a separate table from property sets, and the two rules do not read
each other's rows. A term reaches the quantity table only when **both** halves hold:

- the set name starts with `Qto_` (case-sensitive), or is a pattern whose `Qto_`
  opens it or opens one of its alternatives — `/^Qto_.*/`,
  `/(Qto_Wall|Qto_Slab)BaseQuantities/`;
- the comparison is `=`, `!=`, `>`, `>=`, `<` or `<=` against a number.

A `Qto_` term failing the second half is **reported, not applied**:
`Qto_WallBaseQuantities.NetVolume = NULL`, `…NetVolume *= 1` and
`…Note = draft` all come back named rather than silently run against property
sets, where they would find nothing (`= NULL` was worse still — "is not set"
against a set no property row carries matched every element).

Quantities written under a set with no `Qto_` prefix are **not reachable** from a
selector today: Revit's IFC2x3 export writes `BaseQuantities` and ArchiCAD writes
`ArchiCADQuantities`, so `BaseQuantities.NetVolume > 1` becomes a property rule and
finds nothing. Reading quantity rows from a property term is part of #4094.

### Generic attribute terms, and the one that stays reported

`Description=`, `ObjectType=`, `Tag=`, `LongName=`, or any other name the IFC schema
declares as an attribute becomes an `attribute` rule, read from the same on-demand
per-entity extraction the IDS attribute facet uses. All eight operators work, and
`= NULL` / `!= NULL` read as "is not set" / "is set", the same as a property term.

`GlobalId=` (the comparison spelling, not the bare-GlobalId term) is the one
exception: the underlying extraction skips `GlobalId` as a structural/display
attribute, so routing it through the generic attribute rule would silently match
nothing. Instead `GlobalId=` and `GlobalId!=` reuse the same globalId rule the
bare term builds — the same exact-identity, case-sensitive comparison, just
spelled as a comparison. A GlobalId is a fixed 22-character identity rather
than text to search within or order, so `*=`, `>`/`>=`/`<`/`<=`, a
`/regex/` value, and `NULL` stay reported; use `=` or `!=` against a literal id, or the
bare GlobalId term (`325Q7Fhnf67OZC$$r43uzK`) — see the grammar table above.

### How far `location=` reaches

`location="Level 3"` becomes a storey-name rule, and that rule matches an element the
storey **contains directly**, its aggregated parts, and — one hop through a containing
`IfcSpace`/`IfcSpatialZone` — an element inside a space on that storey. So
IfcOpenShell's example `IfcPump, location="Level 3"` — a pump in a room on Level 3 —
now finds the pump in IFClite too. This is measured, not assumed: see `storey rule
reach` in `apps/viewer/src/lib/search/filter-evaluate.test.ts`.

The reach stops at one hop: an element inside a space nested inside *another* space,
rather than directly under the storey, is not resolved. That deeper case is
uncommon (most authoring tools put a space directly under its storey) and is left
open in #4094 rather than guessed at.

### How far `parent=` reaches, and why it is not `location=`

`parent="Level 3"` matches an element that is a direct **or indirect** child, in the
spatial hierarchy, of an element named `Level 3` — walking upward through **both**
`IfcRelContainedInSpatialStructure` (containment) and `IfcRelAggregates`
(aggregation) edges, to **any** depth. That is deliberately wider than `location=`,
which stops at one hop through a containing space: `parent=` also reaches a
grandparent (a wall's storey's building), a part aggregated under an assembly that
itself sits in a storey, and any combination of the two edge kinds in one walk.

Matching an element with no matching ancestor — or no ancestors at all — is an
**empty result**, not "no filter": `parent="Nonexistent"` finds nothing, the same
way an unmatched `material=` or `type=` finds nothing. Operators `=`, `!=`, `*=`,
`!*=` and `/regex/` all work, like `type=`/`material=` — no `>`, `>=`, `<`, `<=`.
Built once, in `@ifc-lite/data`'s `collectSpatialAncestors`, so the CLI/MCP/SDK
axis can reuse the same traversal when it adopts `parent=` (tracked separately).

### `query:` is refused permanently, not "not supported yet"

`query:{keys}={value}` resolves an open key-path language (attribute/property/
material/type chains, counting functions like `.count`) rather than one bounded
comparison. Unlike every other construct in the grammar table above, there is no
fixed rule shape to build for it — a partial resolver would silently narrow some
key paths and refuse others with no principled line between them, the same
zero-match-reads-as-everything risk this whole adapter exists to avoid. This is a
permanent decision (#4094), not a gap on a roadmap: a `query:` term is always
reported by name and never turned into a rule.

## Where else can I filter?

Selector text is accepted on every surface: the viewer's Filter tab, the CLI's
`query --select "…"`, the MCP `query_entities` tool's `selector` parameter, and the
SDK's `bim.query().select('…')`. The CLI, MCP and SDK route it through the same
`@ifc-lite/query` parser and the `selectorToQueryDescriptor` adapter, which covers a
**lossless subset** of the grammar above — class terms and comma unions, exact-name
Pset/Qto comparisons with `=` `!=` `>` `>=` `<` `<=` `*=`, a `/regex/` value on `=`,
and `!= NULL` — and throws `SelectorUnsupportedError` naming the construct for anything
else (regex pset/property *names*, `!*=`, `!` class negation, `+` group unions,
`parent=`, `query:`, `material=`, `classification=`, `location=`, attribute terms).
The viewer's Filter tab keeps the full grammar. The structured filters each surface
already had remain, and this is how the same intent is spelled in them:

| Selector | CLI | MCP `query_entities` | SDK / sandbox |
|---|---|---|---|
| `IfcWall, IfcSlab` | `--type IfcWall,IfcSlab` | `types: ['IfcWall','IfcSlab']` | `bim.query().byType('IfcWall')` |
| `Pset_WallCommon.FireRating=2HR` | `--where "Pset_WallCommon.FireRating=2HR"` | `property: { pset, name, op: '=', value }` | `.where('Pset_WallCommon','FireRating','=','2HR')` |
| `…FireRating*=REI` | `--where "Pset_WallCommon.FireRating~REI"` | `op: 'contains'` | `.where(…, 'contains', 'REI')` |
| `…FireRating != NULL` | `--where "Pset_WallCommon.FireRating"` | `op: 'exists'` | — |
| `/Pset_.*Common/.FireRating` | — (`--select` throws `SelectorUnsupportedError`) | — | `bim.query.property(entity, '/Pset_.*Common/', 'FireRating')` |
| `IfcWall*` (a wildcard) | `--a "IfcWall*"` (clash selectors only) | — | — |

Note the last row: the clash rule selectors (`ifc-lite clash --a "IfcDuct*|IfcPipe*"`) are
a **different, older mini-language** with a suffix `*` glob. That grammar is unchanged and
is not the one on this page.

## Parsing it yourself

```typescript
import { parseSelector } from '@ifc-lite/query';

const result = parseSelector('IfcWall, Pset_WallCommon.FireRating=/REI.*/');
if (result.ok === false) {
  console.error(`${result.error.message} at character ${result.error.offset + 1}`);
} else {
  for (const group of result.query.groups) {
    for (const filter of group.filters) {
      console.log(filter.kind, filter.text);
    }
  }
}
```

`parseSelector` reads the **whole** grammar, including the constructs no surface can
evaluate yet. That is deliberate: a caller adapts the AST onto its own filter model and
reports what it could not carry, instead of matching nothing and saying nothing.

## See also

- [Querying Data](querying.md) — the fluent API, SQL, and the property lookups behind these rules
- [CLI Toolkit](cli.md) — `--type` and `--where`
- [Clash Detection](clash-detection.md) — the separate `IfcDuct*|IfcPipe*` selector language
