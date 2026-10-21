use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Modifier {
    Ctrl,
    Shift,
    Alt,
    Cmd,
}

impl Modifier {
    pub fn from_name(name: &str) -> Option<Modifier> {
        match name {
            "ctrl" | "control" => Some(Modifier::Ctrl),
            "shift" => Some(Modifier::Shift),
            "alt" => Some(Modifier::Alt),
            "win" | "cmd" | "meta" => Some(Modifier::Cmd),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Modifier::Ctrl => "ctrl",
            Modifier::Shift => "shift",
            Modifier::Alt => "alt",
            Modifier::Cmd => "cmd",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Key {
    Char(char),
    Mod(Modifier),
    Vk(u16),
}

impl fmt::Display for Key {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Key::Char(c) => write!(f, "{c}"),
            Key::Mod(m) => f.write_str(m.name()),
            Key::Vk(v) => write!(f, "vk:0x{v:02x}"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyAction {
    Down(Key),
    Up(Key),
}

/// Where keystrokes go. One call is one atomic batch: the Windows sink turns it
/// into a single SendInput, so every action in it lands in the same input frame.
pub trait KeySink: Send {
    fn send(&mut self, actions: &[KeyAction]);
}

const SHIFTED_SYMBOLS: &str = "!@#$%^&*()_+{}|:\"<>?~";

fn needs_shift(s: &str) -> bool {
    let mut it = s.chars();
    match (it.next(), it.next()) {
        (Some(c), None) => c.is_uppercase() || SHIFTED_SYMBOLS.contains(c),
        _ => false,
    }
}

fn base_key(c: char) -> char {
    match c {
        '!' => '1', '@' => '2', '#' => '3', '$' => '4', '%' => '5', '^' => '6',
        '&' => '7', '*' => '8', '(' => '9', ')' => '0',
        '_' => '-', '+' => '=',
        '{' => '[', '}' => ']', '|' => '\\',
        ':' => ';', '"' => '\'',
        '<' => ',', '>' => '.', '?' => '/',
        '~' => '`',
        _ => c,
    }
}

/// `_parse_mapping_value`: "a" -> ([], "a"), "!" -> (["shift"], "1"),
/// "ctrl+1" -> (["ctrl"], "1"), "ctrl++" -> (["ctrl", "shift"], "=").
pub fn parse_mapping_value(value: &str) -> (Vec<String>, String) {
    let (mut mods, mut base): (Vec<String>, String);
    if value.chars().count() <= 1 || !value.contains('+') {
        base = value.to_string();
        mods = Vec::new();
    } else {
        let mut parts: Vec<&str> = value.split('+').collect();
        if parts.last() == Some(&"") && parts.len() >= 2 {
            base = "+".to_string();
            parts.truncate(parts.len() - 2);
        } else {
            base = parts.pop().unwrap_or("").to_string();
        }
        mods = parts
            .iter()
            .map(|p| p.trim())
            .filter(|p| !p.is_empty())
            .map(|p| p.to_lowercase())
            .collect();
    }
    if needs_shift(&base) {
        let c = base.chars().next().unwrap();
        base = if c.is_alphabetic() { c.to_lowercase().collect() } else { base_key(c).to_string() };
        if !mods.iter().any(|m| m == "shift") {
            mods.push("shift".to_string());
        }
    }
    (mods, base)
}

/// A mapping value resolved once, before playback, into what gets pressed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stroke {
    pub mods: Vec<Modifier>,
    pub base: Key,
}

impl Stroke {
    pub fn parse(value: &str) -> Result<Stroke, String> {
        let (mods, base) = parse_mapping_value(value);
        let mut chars = base.chars();
        let c = match (chars.next(), chars.next()) {
            (Some(c), None) => c,
            _ => return Err(format!("mapping value {value:?} does not resolve to a single key")),
        };
        Ok(Stroke {
            mods: mods.iter().filter_map(|m| Modifier::from_name(m)).collect(),
            base: Key::Char(c),
        })
    }

    pub fn push_tap(&self, out: &mut Vec<KeyAction>) {
        for m in &self.mods {
            out.push(KeyAction::Down(Key::Mod(*m)));
        }
        out.push(KeyAction::Down(self.base));
        out.push(KeyAction::Up(self.base));
        for m in self.mods.iter().rev() {
            out.push(KeyAction::Up(Key::Mod(*m)));
        }
    }

    pub fn push_hold(&self, out: &mut Vec<KeyAction>) {
        for m in &self.mods {
            out.push(KeyAction::Down(Key::Mod(*m)));
        }
        out.push(KeyAction::Down(self.base));
        for m in self.mods.iter().rev() {
            out.push(KeyAction::Up(Key::Mod(*m)));
        }
    }
}

pub const PANIC_MODIFIERS: [Modifier; 4] = [Modifier::Shift, Modifier::Ctrl, Modifier::Alt, Modifier::Cmd];

#[cfg(test)]
mod tests {
    use super::*;

    fn want(mods: &[&str], base: &str) -> (Vec<String>, String) {
        (mods.iter().map(|m| m.to_string()).collect(), base.to_string())
    }

    #[test]
    fn mapping_values() {
        assert_eq!(parse_mapping_value("a"), want(&[], "a"));
        assert_eq!(parse_mapping_value("Q"), want(&["shift"], "q"));
        assert_eq!(parse_mapping_value("!"), want(&["shift"], "1"));
        assert_eq!(parse_mapping_value("\""), want(&["shift"], "'"));
        assert_eq!(parse_mapping_value("ctrl+1"), want(&["ctrl"], "1"));
        assert_eq!(parse_mapping_value("ctrl+shift+a"), want(&["ctrl", "shift"], "a"));
        assert_eq!(parse_mapping_value("ctrl+Q"), want(&["ctrl", "shift"], "q"));
        assert_eq!(parse_mapping_value("ctrl++"), want(&["ctrl", "shift"], "="));
        assert_eq!(parse_mapping_value("+"), want(&["shift"], "="));
        assert_eq!(parse_mapping_value(" Ctrl +x"), want(&["ctrl"], "x"));
    }

    #[test]
    fn strokes() {
        let s = Stroke::parse("ctrl+E").unwrap();
        assert_eq!(s.mods, vec![Modifier::Ctrl, Modifier::Shift]);
        assert_eq!(s.base, Key::Char('e'));
        let mut out = Vec::new();
        s.push_tap(&mut out);
        use KeyAction::*;
        assert_eq!(out, vec![
            Down(Key::Mod(Modifier::Ctrl)), Down(Key::Mod(Modifier::Shift)),
            Down(Key::Char('e')), Up(Key::Char('e')),
            Up(Key::Mod(Modifier::Shift)), Up(Key::Mod(Modifier::Ctrl)),
        ]);
        assert_eq!(Stroke::parse("hyper+k").unwrap().mods, vec![]);
        assert!(Stroke::parse("ab").is_err());
        assert!(Stroke::parse("").is_err());
    }
}
