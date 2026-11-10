// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! A tiny IFC4 writer for the Rhino scene tests: a project with a chosen
//! length unit, a site, a building, storeys and box-shaped elements, built
//! line by line so each test states only what it is about.

#![allow(dead_code)]

/// Length unit declarations.
pub const METRE: &str = "IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)";
pub const MILLIMETRE: &str = "IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)";
/// Feet, as Revit writes them (a conversion-based unit over the metre).
pub const FOOT: &str = "FOOT";

pub struct Ifc {
    lines: Vec<String>,
    next: u32,
    pub context: u32,
    pub project: u32,
    pub site: u32,
    pub site_placement: u32,
    pub building: u32,
    building_placement: u32,
    contained: Vec<(u32, Vec<u32>)>,
    aggregated: Vec<(u32, Vec<u32>)>,
}

/// Site options.
pub struct Site<'a> {
    pub at: [f64; 3],
    /// Site X axis in world XY.
    pub x_dir: [f64; 2],
    /// `IfcCompoundPlaneAngleMeasure` lists, verbatim.
    pub ref_lat_lon: Option<(&'a str, &'a str)>,
    pub ref_elevation: Option<f64>,
}

impl Default for Site<'_> {
    fn default() -> Self {
        Self { at: [0.0; 3], x_dir: [1.0, 0.0], ref_lat_lon: None, ref_elevation: None }
    }
}

fn opt(v: Option<&str>) -> String {
    v.map_or("$".to_string(), |s| format!("'{s}'"))
}

impl Ifc {
    /// `unit` is one of the constants above; `true_north` an XY direction.
    pub fn new(unit: &str, true_north: Option<[f64; 2]>, site: Site<'_>) -> Self {
        let mut f = Ifc {
            lines: Vec::new(),
            next: 1,
            context: 0,
            project: 0,
            site: 0,
            site_placement: 0,
            building: 0,
            building_placement: 0,
            contained: Vec::new(),
            aggregated: Vec::new(),
        };
        let unit_id = if unit == FOOT {
            let si = f.add(METRE.to_string());
            let measure = f.add(format!("IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#{si})"));
            let dims = f.add("IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0)".to_string());
            f.add(format!("IFCCONVERSIONBASEDUNIT(#{dims},.LENGTHUNIT.,'FOOT',#{measure})"))
        } else {
            f.add(unit.to_string())
        };
        let units = f.add(format!("IFCUNITASSIGNMENT((#{unit_id}))"));
        let origin = f.add("IFCCARTESIANPOINT((0.,0.,0.))".to_string());
        let wcs = f.add(format!("IFCAXIS2PLACEMENT3D(#{origin},$,$)"));
        let north = true_north.map(|[x, y]| f.add(format!("IFCDIRECTION(({x:?},{y:?}))")));
        f.context = f.add(format!(
            "IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#{wcs},{})",
            north.map_or("$".to_string(), |n| format!("#{n}"))
        ));
        f.project = f.add(format!("IFCPROJECT('0project00000000000001',$,'Proj',$,$,$,$,(#{}),#{units})", f.context));
        let at = f.add(format!("IFCCARTESIANPOINT(({:?},{:?},{:?}))", site.at[0], site.at[1], site.at[2]));
        let z = f.add("IFCDIRECTION((0.,0.,1.))".to_string());
        let x = f.add(format!("IFCDIRECTION(({:?},{:?},0.))", site.x_dir[0], site.x_dir[1]));
        let axis = f.add(format!("IFCAXIS2PLACEMENT3D(#{at},#{z},#{x})"));
        f.site_placement = f.add(format!("IFCLOCALPLACEMENT($,#{axis})"));
        let (lat, lon) = site.ref_lat_lon.map_or(("$".to_string(), "$".to_string()), |(a, b)| (a.to_string(), b.to_string()));
        let elev = site.ref_elevation.map_or("$".to_string(), |e| format!("{e:?}"));
        f.site = f.add(format!(
            "IFCSITE('0site000000000000000001',$,'Site',$,$,#{},$,$,.ELEMENT.,{lat},{lon},{elev},$,$)",
            f.site_placement
        ));
        f.building_placement = f.placement(Some(f.site_placement), [0.0; 3]);
        f.building = f.add(format!(
            "IFCBUILDING('0bldg000000000000000001',$,'Building',$,$,#{},$,$,.ELEMENT.,$,$,$)",
            f.building_placement
        ));
        f.aggregated.push((f.project, vec![f.site]));
        f.aggregated.push((f.site, vec![f.building]));
        f
    }

    pub fn add(&mut self, body: String) -> u32 {
        let id = self.next;
        self.next += 1;
        self.lines.push(format!("#{id}={body};"));
        id
    }

    pub fn placement(&mut self, relative_to: Option<u32>, at: [f64; 3]) -> u32 {
        let p = self.add(format!("IFCCARTESIANPOINT(({:?},{:?},{:?}))", at[0], at[1], at[2]));
        let axis = self.add(format!("IFCAXIS2PLACEMENT3D(#{p},$,$)"));
        self.add(format!("IFCLOCALPLACEMENT({},#{axis})", relative_to.map_or("$".to_string(), |r| format!("#{r}"))))
    }

    /// A storey under the building; returns `(storey, its placement)`.
    pub fn storey(&mut self, gid: &str, name: Option<&str>, long_name: Option<&str>, elevation: f64) -> (u32, u32) {
        let pl = self.placement(Some(self.building_placement), [0.0, 0.0, elevation]);
        let id = self.add(format!(
            "IFCBUILDINGSTOREY('{gid}',$,{},$,$,#{pl},$,{},.ELEMENT.,{elevation:?})",
            opt(name),
            opt(long_name)
        ));
        let building = self.building;
        self.aggregated.push((building, vec![id]));
        (id, pl)
    }

    /// An axis-aligned box `size` at `at` in `parent_placement`, as an
    /// `IfcProductDefinitionShape`.
    pub fn box_shape(&mut self, size: [f64; 3]) -> u32 {
        let c = self.add(format!("IFCCARTESIANPOINT(({:?},{:?}))", size[0] / 2.0, size[1] / 2.0));
        let p2 = self.add(format!("IFCAXIS2PLACEMENT2D(#{c},$)"));
        let prof = self.add(format!("IFCRECTANGLEPROFILEDEF(.AREA.,$,#{p2},{:?},{:?})", size[0], size[1]));
        let o = self.add("IFCCARTESIANPOINT((0.,0.,0.))".to_string());
        let pos = self.add(format!("IFCAXIS2PLACEMENT3D(#{o},$,$)"));
        let dir = self.add("IFCDIRECTION((0.,0.,1.))".to_string());
        let solid = self.add(format!("IFCEXTRUDEDAREASOLID(#{prof},#{pos},#{dir},{:?})", size[2]));
        let rep = self.add(format!("IFCSHAPEREPRESENTATION(#{},'Body','SweptSolid',(#{solid}))", self.context));
        self.add(format!("IFCPRODUCTDEFINITIONSHAPE($,$,(#{rep}))"))
    }

    /// A box element of class `entity` at the container's origin; `tail` is
    /// the IFC4 attribute list after the placement and shape (e.g. `"$,$"`
    /// for a wall's Tag and PredefinedType).
    pub fn element(&mut self, entity: &str, (gid, name): (&str, &str), container: (u32, u32), size: [f64; 3], tail: &str) -> u32 {
        self.element_at(entity, (gid, name), container, [0.0; 3], size, tail)
    }

    /// [`Self::element`] placed at `at` in the container.
    pub fn element_at(&mut self, entity: &str, (gid, name): (&str, &str), container: (u32, u32), at: [f64; 3], size: [f64; 3], tail: &str) -> u32 {
        let pl = self.placement(Some(container.1), at);
        let shape = self.box_shape(size);
        let id = self.add(format!("{entity}('{gid}',$,'{name}',$,$,#{pl},#{shape},{tail})"));
        match self.contained.iter_mut().find(|(c, _)| *c == container.0) {
            Some((_, kids)) => kids.push(id),
            None => self.contained.push((container.0, vec![id])),
        }
        id
    }

    pub fn wall(&mut self, gid: &str, name: &str, storey: (u32, u32), at: [f64; 3], size: [f64; 3]) -> u32 {
        self.element_at("IFCWALL", (gid, name), storey, at, size, "$,$")
    }

    /// The building's own `(id, placement)`, for elements contained in it.
    pub fn building_ref(&self) -> (u32, u32) {
        (self.building, self.building_placement)
    }

    /// The finished file, named `name` in its header.
    pub fn finish(mut self, name: &str) -> Vec<u8> {
        for (i, (parent, kids)) in std::mem::take(&mut self.aggregated).into_iter().enumerate() {
            let list: Vec<String> = kids.iter().map(|k| format!("#{k}")).collect();
            self.add(format!("IFCRELAGGREGATES('0agg{i:018}',$,$,$,#{parent},({}))", list.join(",")));
        }
        for (i, (parent, kids)) in std::mem::take(&mut self.contained).into_iter().enumerate() {
            let list: Vec<String> = kids.iter().map(|k| format!("#{k}")).collect();
            self.add(format!("IFCRELCONTAINEDINSPATIALSTRUCTURE('0con{i:018}',$,$,$,({}),#{parent})", list.join(",")));
        }
        format!(
            "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('{name}','2026-01-01T00:00:00',(''),(''),'','Synthetic Writer','');\n\
             FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{}\nENDSEC;\nEND-ISO-10303-21;\n",
            self.lines.join("\n")
        )
        .into_bytes()
    }
}
