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
| `material=` | ⚠️ | matches material **names**; Category is not read yet |
| `classification=`, `= NULL`, `!= NULL` | ✅ | matches the code or the name |
| `location="Level 3"` | ⚠️ | see below |
| GlobalId terms, `! <GlobalId>` | ❌ | reported, not applied |
| `type=WT01` | ❌ | reported, not applied |
| attributes other than `Name` and `PredefinedType` | ❌ | reported, not applied |
| `parent=`, `query:` | ❌ | reported, not applied |
| `+` unions of groups | ❌ | the first group is applied, the rest reported |

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

### How far `location=` reaches

`location="Level 3"` becomes a storey-name rule, and that rule matches an element the
storey **contains directly**, plus the parts aggregated under such an element.

It does **not** reach an element one level further down, inside an `IfcSpace` on that
storey. So IfcOpenShell's example `IfcPump, location="Level 3"` — a pump in a room on
Level 3 — finds the pump in IfcOpenShell and not in IFClite. This is measured, not
assumed: see `storey rule reach` in `apps/viewer/src/lib/search/filter-evaluate.test.ts`.
A spatial-ancestor rule is part of #4094.

## Where else can I filter?

Only the viewer's Filter tab accepts selector text today. The other surfaces have their
own structured filters, and this is how the same intent is spelled in each:

| Selector | CLI | MCP `query_entities` | SDK / sandbox |
|---|---|---|---|
| `IfcWall, IfcSlab` | `--type IfcWall,IfcSlab` | `types: ['IfcWall','IfcSlab']` | `bim.query().byType('IfcWall')` |
| `Pset_WallCommon.FireRating=2HR` | `--where "Pset_WallCommon.FireRating=2HR"` | `property: { pset, name, op: '=', value }` | `.where('Pset_WallCommon','FireRating','=','2HR')` |
| `…FireRating*=REI` | `--where "Pset_WallCommon.FireRating~REI"` | `op: 'contains'` | `.where(…, 'contains', 'REI')` |
| `…FireRating != NULL` | `--where "Pset_WallCommon.FireRating"` | `op: 'exists'` | — |
| `/Pset_.*Common/.FireRating` | — | — | `bim.query.property(entity, '/Pset_.*Common/', 'FireRating')` |
| `IfcWall*` (a wildcard) | `--a "IfcWall*"` (clash selectors only) | — | — |

Note the last row: the clash rule selectors (`ifc-lite clash --a "IfcDuct*|IfcPipe*"`) are
a **different, older mini-language** with a suffix `*` glob. That grammar is unchanged and
is not the one on this page.

Accepting selector text in the CLI, MCP and the scripting API is tracked in #4094; the
parser already lives in `@ifc-lite/query`, so those surfaces adapt the same AST rather
than growing a second grammar.

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
