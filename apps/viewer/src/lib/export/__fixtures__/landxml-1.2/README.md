# LandXML 1.2 schema (test fixture)

`LandXML-1.2.xsd` is a verbatim, unmodified copy of the official LandXML 1.2
schema published by LandXML.org:

  http://www.landxml.org/schema/LandXML-1.2/LandXML-1.2.xsd

- Fetched: 2026-10-14
- Header: `Date Posted: 7/29/2008`
- SHA-256: `f4f732341970a923943f94592a3fde0838534515d564a699761e85420fad4d77`
  (225,951 bytes, CRLF line endings as published)

The file carries no licence text. LandXML.org publishes LandXML as an open,
royalty-free industry data standard, and the schema is redistributed here
only as that published standard, unchanged. `.gitattributes` marks it `-text`
so git never normalises its CRLF line endings, which would change the hash
above; `landXmlTerrainRoundTrip.test.ts` checks the hash before validating
anything against it.

Do not edit it. Its only value is as an authority independent of this
codebase: the LandXML terrain export (#7600) is validated against it, and a
local edit would turn that check into ifc-lite agreeing with itself. To move to
a newer LandXML release, replace the file wholesale from upstream and update
the URL, date and hash above.

It is a test fixture only. It is not bundled into the viewer and is never
written into an exported file.
