//! The handful of Python coercions the protocol leans on: `float(x)`,
//! `int(x)`, truthiness for `x or default`, and `str(x)` for log text.

use serde_json::Value;

pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// `msg.get(key) or None`: present and truthy.
pub fn get_truthy<'a>(msg: &'a Value, key: &str) -> Option<&'a Value> {
    msg.get(key).filter(|v| truthy(v))
}

pub fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "NoneType",
        Value::Bool(_) => "bool",
        Value::Number(n) if n.is_f64() => "float",
        Value::Number(_) => "int",
        Value::String(_) => "str",
        Value::Array(_) => "list",
        Value::Object(_) => "dict",
    }
}

pub fn float(v: &Value) -> Result<f64, String> {
    match v {
        Value::Bool(b) => Ok(if *b { 1.0 } else { 0.0 }),
        Value::Number(n) => n.as_f64().ok_or_else(|| "number out of range".into()),
        Value::String(s) => s
            .trim()
            .parse::<f64>()
            .map_err(|_| format!("could not convert string to float: '{s}'")),
        other => Err(format!("float() argument must be a string or a real number, not '{}'", type_name(other))),
    }
}

pub fn int(v: &Value) -> Result<i64, String> {
    match v {
        Value::Bool(b) => Ok(*b as i64),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(i)
            } else {
                let f = n.as_f64().unwrap_or(f64::NAN);
                if f.is_finite() { Ok(f.trunc() as i64) } else { Err("cannot convert float to integer".into()) }
            }
        }
        Value::String(s) => s
            .trim()
            .parse::<i64>()
            .map_err(|_| format!("invalid literal for int() with base 10: '{s}'")),
        other => Err(format!(
            "int() argument must be a string, a bytes-like object or a real number, not '{}'",
            type_name(other)
        )),
    }
}

/// `float(msg.get(key, default))`.
pub fn float_or(msg: &Value, key: &str, default: f64) -> Result<f64, String> {
    msg.get(key).map_or(Ok(default), float)
}

/// `int(msg.get(key, default))`.
pub fn int_or(msg: &Value, key: &str, default: i64) -> Result<i64, String> {
    msg.get(key).map_or(Ok(default), int)
}

/// `int(msg.get(key, d) or d)`.
pub fn int_or_falsy(msg: &Value, key: &str, default: i64) -> Result<i64, String> {
    get_truthy(msg, key).map_or(Ok(default), int)
}

/// `msg[key]`, with KeyError's text.
pub fn req<'a>(msg: &'a Value, key: &str) -> Result<&'a Value, String> {
    msg.get(key).ok_or_else(|| format!("'{key}'"))
}

pub fn req_str<'a>(msg: &'a Value, key: &str) -> Result<&'a str, String> {
    let v = req(msg, key)?;
    v.as_str().ok_or_else(|| format!("'{key}' must be a string, not '{}'", type_name(v)))
}

/// `str(x)` as it appears inside an f-string.
pub fn text(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}
