// SPDX-License-Identifier: MPL-2.0
//! A deterministic, entirely synthetic IFC model for the export-plan executor:
//! the memory harness in `main.rs` writes millions of records with it, and
//! `tests/plan_output_pinned.rs` uses a small one to pin the executor's output
//! byte for byte.
//!
//! Every record is built from the schema's own attribute order
//! (`ifc_lite_core::attribute_names_for_schema`), so the output validates with
//! zero findings unless a quirk below plants one on purpose.
//!
//! Layout. Globals sit below [`WALL_BASE`]; wall `k` owns the ids
//! `wall(k) .. wall(k) + WALL_STRIDE`; the property sets shared by groups of
//! [`GROUP`] walls follow the walls; the optional quirks block comes last.

use std::io::{self, Write};

pub const WALL_BASE: u32 = 1000;
pub const WALL_STRIDE: u32 = 32;
/// Walls sharing one property set through one relationship.
pub const GROUP: u32 = 50;
/// Wall types; wall `k` is typed by `k % TYPES`.
pub const TYPES: u32 = 10;

pub const OWNER_HISTORY: u32 = 6;
const CONTEXT: u32 = 20;
const ORIGIN: u32 = 22;
const DIR_Z: u32 = 23;
const BUILDING_PLACEMENT: u32 = 34;

#[derive(Clone, Copy)]
pub struct Layout {
    pub walls: u32,
    pub storeys: u32,
    /// Append the malformed-but-legal records the pinning test needs.
    pub quirks: bool,
}

impl Layout {
    pub fn wall(&self, k: u32) -> u32 {
        WALL_BASE + k * WALL_STRIDE
    }
    pub fn storey(&self, s: u32) -> u32 {
        100 + s * 10
    }
    pub fn storey_placement(&self, s: u32) -> u32 {
        self.storey(s) + 1
    }
    pub fn storey_of(&self, k: u32) -> u32 {
        k * self.storeys / self.walls.max(1)
    }
    pub fn wall_type(&self, t: u32) -> u32 {
        400 + t * 10
    }
    fn group_base(&self) -> u32 {
        self.wall(self.walls)
    }
    pub fn groups(&self) -> u32 {
        self.walls.div_ceil(GROUP)
    }
    /// Base id of the quirks block (see [`write_quirks`]).
    pub fn quirks_base(&self) -> u32 {
        self.group_base() + self.groups() * 4 + 10
    }
    pub fn has_opening(k: u32) -> bool {
        k.is_multiple_of(10)
    }
    pub fn has_boundary(k: u32) -> bool {
        k.is_multiple_of(7)
    }
}

pub fn gid(n: u32) -> String {
    format!("'{n:0>22}'")
}

fn line(out: &mut impl Write, schema: &str, id: u32, entity: &str, fields: &[(&str, String)]) -> io::Result<()> {
    let names = ifc_lite_core::attribute_names_for_schema(schema, entity)
        .unwrap_or_else(|| panic!("{schema} does not declare {entity}"));
    write!(out, "#{id}={entity}(")?;
    for (i, n) in names.iter().enumerate() {
        if i > 0 {
            out.write_all(b",")?;
        }
        match fields.iter().find(|(name, _)| name == n) {
            Some((_, v)) => out.write_all(v.as_bytes())?,
            None => out.write_all(b"$")?,
        }
    }
    out.write_all(b");\n")
}

fn r(id: u32) -> String {
    format!("#{id}")
}

fn list(ids: impl IntoIterator<Item = u32>) -> String {
    let parts: Vec<String> = ids.into_iter().map(r).collect();
    format!("({})", parts.join(","))
}

fn rooted(id: u32) -> Vec<(&'static str, String)> {
    vec![("GlobalId", gid(id)), ("OwnerHistory", r(OWNER_HISTORY))]
}

fn with(mut base: Vec<(&'static str, String)>, more: &[(&'static str, String)]) -> Vec<(&'static str, String)> {
    base.extend(more.iter().cloned());
    base
}

pub fn write_model(out: &mut impl Write, schema: &str, layout: &Layout) -> io::Result<()> {
    write!(
        out,
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('synthetic'),'2;1');\n\
         FILE_NAME('synthetic.ifc','2000-01-01T00:00:00',(''),(''),'','','');\n\
         FILE_SCHEMA(('{schema}'));\nENDSEC;\nDATA;\n"
    )?;
    write_globals(out, schema, layout)?;
    for k in 0..layout.walls {
        write_wall(out, schema, layout, k)?;
    }
    write_groups(out, schema, layout)?;
    if layout.quirks {
        write_quirks(out, schema, layout)?;
    }
    out.write_all(b"ENDSEC;\nEND-ISO-10303-21;\n")
}

fn write_globals(out: &mut impl Write, schema: &str, l: &Layout) -> io::Result<()> {
    line(out, schema, 1, "IFCPROJECT", &with(rooted(1), &[("Name", "'Project'".into()), ("RepresentationContexts", list([CONTEXT])), ("UnitsInContext", r(10))]))?;
    line(out, schema, 2, "IFCPERSON", &[("FamilyName", "'Person'".into())])?;
    line(out, schema, 3, "IFCORGANIZATION", &[("Name", "'Organization'".into())])?;
    line(out, schema, 4, "IFCPERSONANDORGANIZATION", &[("ThePerson", r(2)), ("TheOrganization", r(3))])?;
    line(
        out,
        schema,
        5,
        "IFCAPPLICATION",
        &[("ApplicationDeveloper", r(3)), ("Version", "'1'".into()), ("ApplicationFullName", "'Generator'".into()), ("ApplicationIdentifier", "'gen'".into())],
    )?;
    line(
        out,
        schema,
        OWNER_HISTORY,
        "IFCOWNERHISTORY",
        &[("OwningUser", r(4)), ("OwningApplication", r(5)), ("ChangeAction", ".NOCHANGE.".into()), ("CreationDate", "0".into())],
    )?;
    writeln!(out, "#10=IFCUNITASSIGNMENT((#11));")?;
    writeln!(out, "#11=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);")?;
    writeln!(out, "#{CONTEXT}=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);")?;
    writeln!(out, "#21=IFCAXIS2PLACEMENT3D(#{ORIGIN},#{DIR_Z},#24);")?;
    writeln!(out, "#{ORIGIN}=IFCCARTESIANPOINT((0.,0.,0.));")?;
    writeln!(out, "#{DIR_Z}=IFCDIRECTION((0.,0.,1.));")?;
    writeln!(out, "#24=IFCDIRECTION((1.,0.,0.));")?;
    line(out, schema, 30, "IFCSITE", &with(rooted(30), &[("Name", "'Site'".into()), ("ObjectPlacement", r(31))]))?;
    writeln!(out, "#31=IFCLOCALPLACEMENT($,#32);")?;
    writeln!(out, "#32=IFCAXIS2PLACEMENT3D(#{ORIGIN},$,$);")?;
    line(out, schema, 33, "IFCBUILDING", &with(rooted(33), &[("Name", "'Building'".into()), ("ObjectPlacement", r(BUILDING_PLACEMENT))]))?;
    writeln!(out, "#{BUILDING_PLACEMENT}=IFCLOCALPLACEMENT(#31,#35);")?;
    writeln!(out, "#35=IFCAXIS2PLACEMENT3D(#{ORIGIN},$,$);")?;
    line(out, schema, 36, "IFCRELAGGREGATES", &with(rooted(36), &[("RelatingObject", r(1)), ("RelatedObjects", list([30]))]))?;
    line(out, schema, 37, "IFCRELAGGREGATES", &with(rooted(37), &[("RelatingObject", r(30)), ("RelatedObjects", list([33]))]))?;
    line(
        out,
        schema,
        38,
        "IFCRELAGGREGATES",
        &with(rooted(38), &[("RelatingObject", r(33)), ("RelatedObjects", list((0..l.storeys).map(|s| l.storey(s))))]),
    )?;
    for s in 0..l.storeys {
        let st = l.storey(s);
        line(out, schema, st, "IFCBUILDINGSTOREY", &with(rooted(st), &[("Name", format!("'Storey {s}'")), ("ObjectPlacement", r(st + 1))]))?;
        writeln!(out, "#{}=IFCLOCALPLACEMENT(#{BUILDING_PLACEMENT},#{});", st + 1, st + 2)?;
        writeln!(out, "#{}=IFCAXIS2PLACEMENT3D(#{},$,$);", st + 2, st + 5)?;
        writeln!(out, "#{}=IFCCARTESIANPOINT((0.,0.,{}.));", st + 5, s * 3)?;
        let walls = (0..l.walls).filter(|&k| l.storey_of(k) == s).map(|k| l.wall(k));
        line(
            out,
            schema,
            st + 3,
            "IFCRELCONTAINEDINSPATIALSTRUCTURE",
            &with(rooted(st + 3), &[("RelatedElements", list(walls)), ("RelatingStructure", r(st))]),
        )?;
        line(out, schema, st + 4, "IFCSPACE", &with(rooted(st + 4), &[("Name", format!("'Space {s}'"))]))?;
    }
    for t in 0..TYPES {
        let ty = l.wall_type(t);
        line(
            out,
            schema,
            ty,
            "IFCWALLTYPE",
            &with(rooted(ty), &[("Name", format!("'Type {t}'")), ("HasPropertySets", list([ty + 2])), ("PredefinedType", ".NOTDEFINED.".into())]),
        )?;
        writeln!(out, "#{}=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('{t}HR'),$);", ty + 1)?;
        line(out, schema, ty + 2, "IFCPROPERTYSET", &with(rooted(ty + 2), &[("Name", "'Pset_Type'".into()), ("HasProperties", list([ty + 1]))]))?;
        let typed = (0..l.walls).filter(|&k| k % TYPES == t).map(|k| l.wall(k));
        line(out, schema, ty + 3, "IFCRELDEFINESBYTYPE", &with(rooted(ty + 3), &[("RelatedObjects", list(typed)), ("RelatingType", r(ty))]))?;
    }
    Ok(())
}

fn write_wall(out: &mut impl Write, schema: &str, l: &Layout, k: u32) -> io::Result<()> {
    let w = l.wall(k);
    let storey_placement = l.storey_placement(l.storey_of(k));
    line(
        out,
        schema,
        w,
        "IFCWALL",
        &with(rooted(w), &[("Name", format!("'W{k}'")), ("ObjectPlacement", r(w + 1)), ("Representation", r(w + 5))]),
    )?;
    writeln!(out, "#{}=IFCLOCALPLACEMENT(#{storey_placement},#{});", w + 1, w + 2)?;
    writeln!(out, "#{}=IFCAXIS2PLACEMENT3D(#{},$,$);", w + 2, w + 3)?;
    writeln!(out, "#{}=IFCCARTESIANPOINT(({}.,{}.,0.));", w + 3, k % 1000, k / 1000)?;
    writeln!(out, "#{}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{}));", w + 5, w + 6)?;
    writeln!(out, "#{}=IFCSHAPEREPRESENTATION(#{CONTEXT},'Body','SweptSolid',(#{}));", w + 6, w + 7)?;
    writeln!(out, "#{}=IFCEXTRUDEDAREASOLID(#{},#{},#{DIR_Z},3.);", w + 7, w + 8, w + 11)?;
    line(
        out,
        schema,
        w + 8,
        "IFCRECTANGLEPROFILEDEF",
        &[("ProfileType", ".AREA.".into()), ("Position", r(w + 9)), ("XDim", "5.".into()), ("YDim", "0.2".into())],
    )?;
    writeln!(out, "#{}=IFCAXIS2PLACEMENT2D(#{},$);", w + 9, w + 10)?;
    writeln!(out, "#{}=IFCCARTESIANPOINT((2.5,0.1));", w + 10)?;
    writeln!(out, "#{}=IFCAXIS2PLACEMENT3D(#{ORIGIN},$,$);", w + 11)?;
    writeln!(out, "#{}=IFCPROPERTYSINGLEVALUE('Reference',$,IFCIDENTIFIER('W{k}'),$);", w + 12)?;
    line(out, schema, w + 13, "IFCPROPERTYSET", &with(rooted(w + 13), &[("Name", "'Pset_Own'".into()), ("HasProperties", list([w + 12]))]))?;
    line(
        out,
        schema,
        w + 14,
        "IFCRELDEFINESBYPROPERTIES",
        &with(rooted(w + 14), &[("RelatedObjects", list([w])), ("RelatingPropertyDefinition", r(w + 13))]),
    )?;
    line(out, schema, w + 15, "IFCQUANTITYLENGTH", &[("Name", "'Length'".into()), ("LengthValue", "5.".into())])?;
    line(out, schema, w + 16, "IFCELEMENTQUANTITY", &with(rooted(w + 16), &[("Name", "'Qto_Base'".into()), ("Quantities", list([w + 15]))]))?;
    line(
        out,
        schema,
        w + 17,
        "IFCRELDEFINESBYPROPERTIES",
        &with(rooted(w + 17), &[("RelatedObjects", list([w])), ("RelatingPropertyDefinition", r(w + 16))]),
    )?;
    if Layout::has_opening(k) {
        line(out, schema, w + 20, "IFCOPENINGELEMENT", &with(rooted(w + 20), &[("Name", "'Opening'".into()), ("ObjectPlacement", r(w + 21))]))?;
        writeln!(out, "#{}=IFCLOCALPLACEMENT(#{},#{});", w + 21, w + 1, w + 22)?;
        writeln!(out, "#{}=IFCAXIS2PLACEMENT3D(#{},$,$);", w + 22, w + 23)?;
        writeln!(out, "#{}=IFCCARTESIANPOINT((1.,0.,0.));", w + 23)?;
        line(
            out,
            schema,
            w + 24,
            "IFCRELVOIDSELEMENT",
            &with(rooted(w + 24), &[("RelatingBuildingElement", r(w)), ("RelatedOpeningElement", r(w + 20))]),
        )?;
    }
    if Layout::has_boundary(k) {
        let space = l.storey(l.storey_of(k)) + 4;
        line(
            out,
            schema,
            w + 25,
            "IFCRELSPACEBOUNDARY",
            &with(
                rooted(w + 25),
                &[
                    ("RelatingSpace", r(space)),
                    ("RelatedBuildingElement", r(w)),
                    ("PhysicalOrVirtualBoundary", ".PHYSICAL.".into()),
                    ("InternalOrExternalBoundary", ".INTERNAL.".into()),
                ],
            ),
        )?;
    }
    Ok(())
}

fn write_groups(out: &mut impl Write, schema: &str, l: &Layout) -> io::Result<()> {
    for g in 0..l.groups() {
        let b = l.group_base() + g * 4;
        writeln!(out, "#{b}=IFCPROPERTYSINGLEVALUE('Grade',$,IFCLABEL('G{g}'),$);")?;
        line(out, schema, b + 1, "IFCPROPERTYSET", &with(rooted(b + 1), &[("Name", "'Pset_Shared'".into()), ("HasProperties", list([b]))]))?;
        let members = (g * GROUP..((g + 1) * GROUP).min(l.walls)).map(|k| l.wall(k));
        line(
            out,
            schema,
            b + 2,
            "IFCRELDEFINESBYPROPERTIES",
            &with(rooted(b + 2), &[("RelatedObjects", list(members)), ("RelatingPropertyDefinition", r(b + 1))]),
        )?;
    }
    Ok(())
}

/// Offsets inside the quirks block, relative to [`Layout::quirks_base`].
pub mod quirk {
    /// A wall written with a mixed-case keyword, whose placement record spans
    /// two lines and whose point is declared twice (the later one wins).
    pub const MIXED_CASE_WALL: u32 = 0;
    /// A wall whose placement chain is written in descending id order.
    pub const OUT_OF_ORDER_WALL: u32 = 10;
    /// A relationship naming a definition that does not exist.
    pub const DANGLING_REL: u32 = 20;
    /// Two walls whose `ObjectPlacement` is the same record.
    pub const SHARED_PLACEMENT_WALL: u32 = 30;
    /// A wall on an `IfcGridPlacement`.
    pub const GRID_WALL: u32 = 40;
    /// A wall whose point has a second referrer written after a comment
    /// holding an unbalanced quote.
    pub const COMMENTED_WALL: u32 = 60;
}

fn write_quirks(out: &mut impl Write, schema: &str, l: &Layout) -> io::Result<()> {
    let q = l.quirks_base();
    let sp = l.storey_placement(0);

    let w = q + quirk::MIXED_CASE_WALL;
    let wall = format!("#{w}=IfcWall({}", &mixed_case_wall_args(schema, w));
    writeln!(out, "{wall}")?;
    writeln!(out, "#{}=IFCLOCALPLACEMENT(\n  #{sp},#{});", w + 1, w + 2)?;
    writeln!(out, "#{}=IFCCARTESIANPOINT((9.,9.,9.));", w + 3)?;
    writeln!(out, "#{}=IFCAXIS2PLACEMENT3D(#{},$,$);", w + 2, w + 3)?;
    writeln!(out, "#{}=IFCCARTESIANPOINT((4.,4.,0.));", w + 3)?;

    let w = q + quirk::OUT_OF_ORDER_WALL;
    writeln!(out, "#{}=IFCCARTESIANPOINT((7.,0.,0.));", w + 3)?;
    writeln!(out, "#{}=IFCAXIS2PLACEMENT3D(#{},$,$);", w + 2, w + 3)?;
    writeln!(out, "#{}=IFCLOCALPLACEMENT(#{sp},#{});", w + 1, w + 2)?;
    line(out, schema, w, "IFCWALL", &with(rooted(w), &[("Name", "'Reversed'".into()), ("ObjectPlacement", r(w + 1))]))?;

    let rel = q + quirk::DANGLING_REL;
    line(
        out,
        schema,
        rel,
        "IFCRELDEFINESBYPROPERTIES",
        &with(rooted(rel), &[("RelatedObjects", list([q + quirk::OUT_OF_ORDER_WALL])), ("RelatingPropertyDefinition", r(99_999_999))]),
    )?;
    // A GlobalId already carried by the relationship above.
    writeln!(out, "#{}=IFCPROPERTYSINGLEVALUE('Unused',$,IFCLABEL('x'),$);", rel + 1)?;
    line(out, schema, rel + 2, "IFCPROPERTYSET", &[("GlobalId", gid(rel)), ("OwnerHistory", r(OWNER_HISTORY)), ("Name", "'Pset_Orphan'".into()), ("HasProperties", list([rel + 1]))])?;

    let w = q + quirk::SHARED_PLACEMENT_WALL;
    line(out, schema, w, "IFCWALL", &with(rooted(w), &[("Name", "'Shares A'".into()), ("ObjectPlacement", r(w + 2))]))?;
    line(out, schema, w + 1, "IFCWALL", &with(rooted(w + 1), &[("Name", "'Shares B'".into()), ("ObjectPlacement", r(w + 2))]))?;
    writeln!(out, "#{}=IFCLOCALPLACEMENT(#{sp},#{});", w + 2, w + 3)?;
    writeln!(out, "#{}=IFCAXIS2PLACEMENT3D(#{ORIGIN},$,$);", w + 3)?;

    let w = q + quirk::GRID_WALL;
    line(out, schema, w, "IFCWALL", &with(rooted(w), &[("Name", "'On grid'".into()), ("ObjectPlacement", r(w + 1))]))?;
    line(out, schema, w + 1, "IFCGRIDPLACEMENT", &[])?;

    let w = q + quirk::COMMENTED_WALL;
    line(out, schema, w, "IFCWALL", &with(rooted(w), &[("Name", "'Commented'".into()), ("ObjectPlacement", r(w + 1))]))?;
    writeln!(out, "#{}=IFCLOCALPLACEMENT(#{sp},#{});", w + 1, w + 2)?;
    writeln!(out, "#{}=IFCAXIS2PLACEMENT3D(#{},$,$);", w + 2, w + 3)?;
    writeln!(out, "#{}=IFCCARTESIANPOINT((3.,0.,0.));", w + 3)?;
    // Nothing before the comment names a record, so a reference scan that
    // honours the quote inside it sees no reference on this line at all.
    writeln!(out, "#{}=IFCAXIS2PLACEMENT3D($,/* it's here */ $,#{});", w + 4, w + 3)?;
    Ok(())
}

fn mixed_case_wall_args(schema: &str, w: u32) -> String {
    let mut buf = Vec::new();
    line(&mut buf, schema, w, "IFCWALL", &with(rooted(w), &[("Name", "'Mixed case'".into()), ("ObjectPlacement", r(w + 1))]))
        .expect("writing to a Vec cannot fail");
    let text = String::from_utf8(buf).expect("ASCII");
    let open = text.find('(').expect("an argument list");
    text[open + 1..].trim_end().to_string()
}
