---
'@ifc-lite/cli': patch
---

`mutate` now refuses to rewrite a STEP record whose argument list it cannot read, instead of writing the attribute into whatever a mis-scan accumulated and reporting success (#4125).

Attribute writes are by index, so a record split into the wrong parts puts the value on the wrong attribute and drops the ones the mis-scan swallowed. Measured on an IFC4 wall carrying two undoubled apostrophes, `--set Name=NewName` took a 9-attribute record down to 4 and exited 0; a record wrapped across two lines was skipped in silence while the run still reported the mutation. Both now fail with an error naming the record, and no output file is written. One legal shape is refused as a side effect: a record whose trailing comment contains a `)` (as in `#1=IFCWALL(...); /* note (x) */`) is now rejected rather than rewritten, because the argument list is located with `lastIndexOf(')')`. That is tracked as #4163.

The argument list is validated at every nesting depth, so the same corruption inside typed values or adjacent lists of strings is caught as well: `IFCLABEL('a's'),$,IFCLABEL('b's'),$` keeps the parens balanced and still reads four attributes as two, and `IfcPerson`'s MiddleNames and PrefixTitles have that shape.

A STEP block comment in the argument list is refused too, whatever it contains. A comment carrying no whitespace read as a whole extra argument, so `--set Description=NEWDESC` on `#2=IFCWALL('1BBB...',/*edited*/,$,'MyName','MyDescription',...)` overwrote Name and exited 0. The scan now breaks a bare token run on `/`, so the comment can never be mistaken for one; a `/` inside a quoted string is untouched, and storey and family names carrying one still rewrite.
