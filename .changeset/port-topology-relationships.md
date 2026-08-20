---
"@ifc-lite/data": minor
"@ifc-lite/parser": minor
---

Index `IfcRelConnectsPortToElement` and `IfcRelConnectsPorts`, so plant topology is traversable.

The ports themselves were always parsed — they are `IfcProduct` subtypes and land in the `EntityTable` like any other product — but neither relationship was in the index, so nothing recorded which element a port belonged to or which port it was joined to. A distribution system therefore read as a set of unrelated parts, and there was no way to answer "what is this pump connected to" from the store.

- `RelationshipType` gains `ConnectsPortToElement = 44` and `ConnectsPorts = 45`, keeping the existing 40-range grouping for connection relationships.
- Both need their own branch in `extractRelFast`: their two ends are single references at attributes 4 and 5, which neither existing branch reads. The default branch takes attribute 5 as a list, and the `IfcRelConnectsElements` branch skips one attribute first because that entity carries an optional `ConnectionGeometry` ahead of its ends.
- `IfcRelConnectsPorts.RealizingElement` (the optional element that realises a connection, e.g. a length of duct) is deliberately not read. It is a third party to the connection rather than one of its two ends, and treating it as one would invent an edge between a port and that element.

A plant is walked as element → `ConnectsPortToElement` inverse → its ports → `ConnectsPorts` → the opposite ports → `ConnectsPortToElement` forward → their elements.
