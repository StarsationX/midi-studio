use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use midi_player::{Bridge, Config, Flow};

enum Out {
    Line(String),
    Flush(mpsc::Sender<()>),
}

/// Lines go out through one writer thread, so a stalled reader on the other
/// end of the pipe can never block the keyboard hook or the hot loop.
fn spawn_writer() -> mpsc::Sender<Out> {
    let (tx, rx) = mpsc::channel::<Out>();
    std::thread::Builder::new()
        .name("stdout".into())
        .spawn(move || {
            let stdout = std::io::stdout();
            for item in rx {
                match item {
                    Out::Line(line) => {
                        let mut out = stdout.lock();
                        let _ = out.write_all(line.as_bytes());
                        let _ = out.write_all(b"\n");
                        let _ = out.flush();
                    }
                    Out::Flush(ack) => {
                        let _ = ack.send(());
                    }
                }
            }
        })
        .expect("spawn stdout writer");
    tx
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

struct ReleaseOnExit(Bridge);

impl Drop for ReleaseOnExit {
    fn drop(&mut self) {
        self.0.panic_release(Duration::from_millis(1500));
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dry_run = args.iter().any(|a| a == "--dry-run")
        || std::env::var("MIDI_PLAYER_DRY_RUN").is_ok_and(|v| !v.is_empty() && v != "0");
    let script_dir = arg_value(&args, "--script-dir")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let user_mappings_dir = std::env::var_os("MIDI_STUDIO_MAPPINGS_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);

    let tx = spawn_writer();
    let line_tx = tx.clone();
    let emit = Arc::new(move |v: serde_json::Value| {
        let _ = line_tx.send(Out::Line(v.to_string()));
    });

    let bridge = Bridge::new(emit, Config { script_dir, user_mappings_dir, dry_run });
    bridge.ready();

    let guard = ReleaseOnExit(bridge.clone());
    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if bridge.handle_line(&String::from_utf8_lossy(&buf)) == Flow::Shutdown {
                    break;
                }
            }
        }
    }
    drop(guard);

    let (ack_tx, ack_rx) = mpsc::channel();
    if tx.send(Out::Flush(ack_tx)).is_ok() {
        let _ = ack_rx.recv_timeout(Duration::from_secs(2));
    }
    std::process::exit(0);
}
