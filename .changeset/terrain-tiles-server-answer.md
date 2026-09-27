---
"@ifc-lite/viewer": patch
---

Report a tile or WMS server's own answer when it is not an image, instead of blaming cross-origin rules (follow-up to #5942). A WMS asked for a CRS it does not serve answers HTTP 200 with an XML `ServiceException`; the terrain-imagery drape now quotes it (for `InvalidSRS`/`InvalidCRS`, naming the terrain CRS the request was made in), reports HTTP errors and non-image answers as the server's, and keeps the cross-origin explanation for a fetch that got no answer at all.
