# Vendored IDS-Audit-tool schema data

The five `SchemaInfo.*.g.cs` files in this directory are auto-generated source from
[buildingSMART/IDS-Audit-tool](https://github.com/buildingSMART/IDS-Audit-tool)
(licensed MIT). They are copied verbatim for use by `generate-ifc-schema.ts`,
which converts them into the TypeScript data tables in
`packages/data/src/ifc-schema/generated/`.

`LICENSE` is the upstream MIT license, retained as required for redistribution.

## Updating

```bash
git -C /tmp clone --depth 1 https://github.com/buildingSMART/IDS-Audit-tool.git
cp /tmp/IDS-Audit-tool/ids-lib/IfcSchema/SchemaInfo.Schemas.g.cs \
   /tmp/IDS-Audit-tool/ids-lib/IfcSchema/SchemaInfo.Properties.g.cs \
   /tmp/IDS-Audit-tool/ids-lib/IfcSchema/SchemaInfo.PartOfRelations.g.cs \
   /tmp/IDS-Audit-tool/ids-lib/IfcSchema/SchemaInfo.ObjectTypes.g.cs \
   /tmp/IDS-Audit-tool/ids-lib/IfcSchema/SchemaInfo.ClassAndAttributeNames.g.cs \
   /tmp/IDS-Audit-tool/LICENSE \
   packages/data/scripts/upstream/
pnpm --filter @ifc-lite/data run generate:ifc-schema
```
