//! Dev helper: prints the JSON B-rep of an X_B/X_T file.
fn main() {
    let path = std::env::args().nth(1).expect("usage: psjson <file.x_b>");
    let bytes = std::fs::read(path).expect("read");
    match parasolid_wasm::parse_to_json(&bytes) {
        Ok(s) => println!("{s}"),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1)
        }
    }
}
