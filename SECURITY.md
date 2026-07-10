# Security Policy

## Reporting a vulnerability

Please report security issues privately, not through public issues or pull
requests.

- Preferred: open a private advisory at
  https://github.com/LTplus-AG/ifc-lite/security/advisories/new
- Or email louis@lt.plus

Include a description, the affected surface (viewer, kernel, CLI, server, or a
package), and a minimal reproduction if you have one. We aim to acknowledge a
report within a few business days.

ifc-lite runs untrusted IFC input through a parser and a geometry kernel, so
parser and kernel crashes, out-of-bounds reads, and unbounded memory or time on
crafted input are in scope. Please do not include confidential or
client-identifying model data in a report; a minimal synthetic reproduction is
strongly preferred.

## Supported versions

Security fixes target the latest released version on the default branch. Older
versions are not maintained.
