//! Session options ONNX Runtime has but its C API does not expose.
//!
//! `SessionOptions::enable_mem_reuse` (Python's `SessionOptions.enable_mem_reuse`)
//! has no C setter. It matters for the BS-Roformer body: with its time axis
//! pinned, the allocation planner's buffer reuse drives one chunk's peak commit
//! from 2.0 to 7.3 GiB, and with the axis left symbolic, the same planner
//! spends ~20 s at session creation. Pinned with reuse off is the only setting
//! that is both fast to load (~4 s) and lean (2.0 GiB), measured in Python
//! ORT 1.24 on CPU.
//!
//! The flag sits between `enable_mem_pattern` and `enable_cpu_mem_arena` in
//! the C++ struct `OrtSessionOptions` wraps (ORT's TraceSessionOptions prints
//! them in that order), and both neighbours do have C setters. So the layout
//! is found, not assumed: flip each neighbour through the C API, see exactly
//! one byte change for each, two bytes apart, with a set byte between them,
//! and only then clear that middle byte. Any other picture and nothing is
//! written; the caller then keeps the time axis symbolic.

use ort::session::builder::SessionBuilder;
use ort::AsPointer;

/// Bytes of the options object compared; the field sits ~50 bytes in and
/// the C++ SessionOptions is well over 1 KB.
const SCAN: usize = 256;

unsafe fn ok(s: ort::sys::OrtStatusPtr) -> bool {
    if s.0.is_null() {
        true
    } else {
        unsafe { (ort::api().ReleaseStatus)(s.0) };
        false
    }
}

/// Clear `enable_mem_reuse` on this builder. Leaves the memory pattern and
/// the CPU arena enabled (set them afterwards). Err says why it refused.
pub fn disable_mem_reuse(b: &mut SessionBuilder) -> Result<(), String> {
    let api = ort::api();
    let opts = b.ptr_mut();
    let bytes = opts as *mut u8;
    unsafe {
        let snap = || std::slice::from_raw_parts(bytes as *const u8, SCAN).to_vec();
        if !ok((api.EnableMemPattern)(opts)) || !ok((api.EnableCpuMemArena)(opts)) {
            return Err("could not reset the memory options".into());
        }
        let base = snap();
        if !ok((api.DisableMemPattern)(opts)) {
            return Err("DisableMemPattern failed".into());
        }
        let no_pattern = snap();
        let _ = ok((api.EnableMemPattern)(opts));
        if !ok((api.DisableCpuMemArena)(opts)) {
            return Err("DisableCpuMemArena failed".into());
        }
        let no_arena = snap();
        let _ = ok((api.EnableCpuMemArena)(opts));
        if snap() != base {
            return Err("options did not return to their starting state".into());
        }
        let diff = |x: &[u8]| (0..SCAN).filter(|&i| x[i] != base[i]).collect::<Vec<_>>();
        let (dp, da) = (diff(&no_pattern), diff(&no_arena));
        let [p] = dp.as_slice() else { return Err(format!("mem pattern flag not found ({dp:?})")) };
        let [a] = da.as_slice() else { return Err(format!("cpu arena flag not found ({da:?})")) };
        let (p, a) = (*p, *a);
        if a != p + 2 || base[p] != 1 || no_pattern[p] != 0 || base[a] != 1 || no_arena[a] != 0 || base[p + 1] != 1 {
            return Err(format!("unexpected layout (pattern @{p}, arena @{a}, between {})", base[p + 1]));
        }
        *bytes.add(p + 1) = 0;
    }
    Ok(())
}
