//! MIDI Studio player engine. `bridge::Bridge` is the whole protocol of
//! python-engine/ipc_main.py behind an emit callback, so the stdio binary and
//! an in-process host drive the same code.

pub mod bridge;
pub mod hotkeys;
pub mod keys;
pub mod mapping;
pub mod midi;
pub mod player;
pub mod py;
pub mod win;

pub use bridge::{Bridge, Config, Emit, Flow};
pub use keys::{Key, KeyAction, KeySink, Modifier};
