fn main() {
    let a: Vec<String> = std::env::args().collect();
    let c = std::fs::read(&a[1]).unwrap();
    let o = ifc_lite_export::StepOptions { schema: Some(a[3].clone()), ..Default::default() };
    std::fs::write(&a[2], ifc_lite_export::export_step(&c, &o).unwrap()).unwrap();
}
