// midi-document: python-engine/midi_document.py's command line, on the Rust
// port (src/midi_doc.rs, compiled into this binary as-is). Same arguments,
// same stdin, same stdout byte for byte (python's json.dumps spelling), same
// exit codes, so tools/midi-doc-parity.js can diff the two directly.
//
//   midi-document load <midi-path>          prints the document
//   midi-document save <midi-path> < doc    writes the .mid, prints {"ok": true, ...}
#[path = "../midi_doc.rs"]
mod midi_doc;

use std::io::{Read, Write};
use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 || !(args[1] == "load" || args[1] == "save") {
        eprintln!("Usage: midi_document.py <load|save> <midi-path>");
        std::process::exit(2);
    }
    let path = Path::new(&args[2]);
    let result = if args[1] == "load" {
        midi_doc::load(path).map(|doc| midi_doc::py_json(&doc))
    } else {
        let mut input = String::new();
        std::io::stdin()
            .read_to_string(&mut input)
            .map_err(|e| e.to_string())
            .and_then(|_| serde_json::from_str::<serde_json::Value>(&input).map_err(|e| e.to_string()))
            .and_then(|doc| midi_doc::save(path, &doc))
            .map(|resolved| midi_doc::py_json(&serde_json::json!({"ok": true, "path": resolved})))
    };
    match result {
        Ok(text) => {
            let mut out = std::io::stdout().lock();
            let _ = out.write_all(text.as_bytes());
            let _ = out.write_all(b"\n");
        }
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}
