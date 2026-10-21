//! Which ONNX Runtime build to load and which execution provider to use.
//!
//! A process loads exactly one onnxruntime.dll, so the choice is made once,
//! before any session: separation and transcription share it.
//!
//! * CPU: any ORT >= 1.22 (the forge env's onnxruntime-directml 1.24 works;
//!   its CPU EP is what the Transkun parity was measured on).
//! * CUDA: onnxruntime-gpu 1.22 (the CUDA 12 / cuDNN 9 build) plus the CUDA
//!   runtime DLLs it links against. The forge env's torch ships exactly
//!   those (cudart64_12, cublas64_12, cufft64_11, cudnn64_9) in torch\lib, so
//!   no CUDA toolkit is needed. onnxruntime-gpu itself is looked for in
//!   FORGE_RS_ORT_GPU_DIR, `<forge env>\ort-gpu`, `<exe dir>\ort-gpu` and the
//!   exe dir.
//!
//! `Auto` takes CUDA only when the driver, the GPU build and the CUDA DLLs
//! are all present, and otherwise CPU; a CUDA session that still fails to
//! come up falls back to CPU on the same (GPU) library, which carries the CPU
//! EP too.

use crate::roformer::Ep;
use anyhow::{bail, Result};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EpChoice {
    Auto,
    Cpu,
    Cuda,
}

impl EpChoice {
    pub fn parse(s: &str) -> Result<Self> {
        Ok(match s.to_ascii_lowercase().as_str() {
            "auto" | "" => EpChoice::Auto,
            "cpu" => EpChoice::Cpu,
            "cuda" | "gpu" => EpChoice::Cuda,
            o => bail!("--ep {o}: expected auto, cpu or cuda"),
        })
    }
}

/// The resolved runtime for this process.
#[derive(Debug, Clone)]
pub struct OrtPlan {
    pub dylib: PathBuf,
    /// Directory of the CUDA runtime DLLs (prepended to PATH), CUDA only.
    pub cuda_dir: Option<PathBuf>,
    pub ep: Ep,
    /// Why CPU was chosen under Auto (empty when CUDA was chosen or asked for).
    pub why_cpu: String,
}

const GPU_DLLS: [&str; 3] = ["onnxruntime.dll", "onnxruntime_providers_cuda.dll", "onnxruntime_providers_shared.dll"];
const CUDA_DLLS: [&str; 4] = ["cudart64_12.dll", "cublas64_12.dll", "cufft64_11.dll", "cudnn64_9.dll"];

fn env_path(k: &str) -> Option<PathBuf> {
    std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf))
}

/// The forge env this run belongs to: MIDI_STUDIO_FORGE_ENV_DIR (the app
/// sets it for every job), else the default location.
pub fn forge_env_dir() -> Option<PathBuf> {
    env_path("MIDI_STUDIO_FORGE_ENV_DIR")
        .or_else(|| env_path("LOCALAPPDATA").map(|l| l.join("midi-studio").join("forge-env")))
}

fn has_all(dir: &Path, names: &[&str]) -> bool {
    names.iter().all(|n| dir.join(n).is_file())
}

/// Directories that may hold onnxruntime-gpu, in priority order.
pub fn gpu_ort_dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    v.extend(env_path("FORGE_RS_ORT_GPU_DIR"));
    if let Some(f) = forge_env_dir() {
        v.push(f.join("ort-gpu"));
    }
    if let Some(d) = exe_dir() {
        v.push(d.join("ort-gpu"));
        v.push(d);
    }
    v
}

/// Directories that may hold the CUDA 12 / cuDNN 9 runtime, in priority order.
pub fn cuda_dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    v.extend(env_path("FORGE_RS_CUDA_DIR"));
    if let Some(f) = forge_env_dir() {
        v.push(f.join("python").join("Lib").join("site-packages").join("torch").join("lib"));
        v.push(f.join("ort-gpu"));
    }
    if let Some(d) = exe_dir() {
        v.push(d.join("cuda"));
    }
    v.extend(env_path("CUDA_PATH").map(|p| p.join("bin")));
    v
}

pub fn find_gpu_ort(explicit: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = explicit {
        let d = p.parent()?;
        return has_all(d, &GPU_DLLS).then(|| p.to_path_buf());
    }
    gpu_ort_dirs().into_iter().find(|d| has_all(d, &GPU_DLLS)).map(|d| d.join("onnxruntime.dll"))
}

pub fn find_cuda_dir(explicit: Option<&Path>) -> Option<PathBuf> {
    match explicit {
        Some(d) => has_all(d, &CUDA_DLLS).then(|| d.to_path_buf()),
        None => cuda_dirs().into_iter().find(|d| has_all(d, &CUDA_DLLS)),
    }
}

/// nvcuda.dll is the NVIDIA driver's CUDA entry point; without it the CUDA EP
/// cannot start.
pub fn nvidia_driver_present() -> bool {
    let sys = env_path("SystemRoot").unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    sys.join("System32").join("nvcuda.dll").is_file()
}

/// A CPU-capable onnxruntime.dll: the explicit one, ORT_DYLIB_PATH, next to
/// the exe, the forge env's onnxruntime, then a GPU build (its CPU EP works).
pub fn find_cpu_ort(explicit: Option<&Path>) -> Option<PathBuf> {
    let mut c = crate::backbone::ort_dylib_candidates(explicit);
    if let Some(f) = forge_env_dir() {
        c.push(f.join("python/Lib/site-packages/onnxruntime/capi/onnxruntime.dll"));
    }
    c.into_iter().find(|p| p.is_file()).or_else(|| find_gpu_ort(None))
}

pub fn plan(choice: EpChoice, explicit_ort: Option<&Path>, explicit_cuda: Option<&Path>) -> Result<OrtPlan> {
    let cpu = |why: String| -> Result<OrtPlan> {
        match find_cpu_ort(explicit_ort) {
            Some(dylib) => Ok(OrtPlan { dylib, cuda_dir: None, ep: Ep::Cpu, why_cpu: why }),
            None => bail!("onnxruntime.dll not found (pass --ort-dylib or set ORT_DYLIB_PATH)"),
        }
    };
    if choice == EpChoice::Cpu {
        return cpu(String::new());
    }
    let gpu = find_gpu_ort(explicit_ort);
    let cuda = find_cuda_dir(explicit_cuda);
    let driver = nvidia_driver_present();
    match (gpu, cuda, driver) {
        (Some(dylib), Some(cuda_dir), true) => Ok(OrtPlan { dylib, cuda_dir: Some(cuda_dir), ep: Ep::Cuda { device_id: 0 }, why_cpu: String::new() }),
        (gpu, cuda, driver) => {
            let why = if !driver {
                "no NVIDIA driver".to_string()
            } else if gpu.is_none() {
                format!("onnxruntime-gpu 1.22 not found (looked in {:?})", gpu_ort_dirs())
            } else if cuda.is_none() {
                format!("CUDA 12 / cuDNN 9 DLLs not found (looked in {:?})", cuda_dirs())
            } else {
                String::new()
            };
            if choice == EpChoice::Cuda {
                bail!("CUDA requested but {why}");
            }
            cpu(why)
        }
    }
}

/// Device 0's name and total memory in bytes, from the CUDA runtime in
/// `cuda_dir` (what torch.cuda.get_device_name / total_memory report).
#[cfg(windows)]
pub fn cuda_device_info(cuda_dir: &Path) -> Option<(String, u64)> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    let dll = cuda_dir.join("cudart64_12.dll");
    let wide: Vec<u16> = dll.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        let h = LoadLibraryW(wide.as_ptr());
        if h.is_null() {
            return None;
        }
        type Props = unsafe extern "system" fn(*mut u8, i32) -> i32;
        type MemInfo = unsafe extern "system" fn(*mut usize, *mut usize) -> i32;
        let props = GetProcAddress(h, c"cudaGetDeviceProperties_v2".as_ptr() as *const u8)
            .or_else(|| GetProcAddress(h, c"cudaGetDeviceProperties".as_ptr() as *const u8))?;
        let props: Props = std::mem::transmute(props);
        // cudaDeviceProp starts with char name[256]; the struct is ~1 KB in
        // CUDA 12, so a generous buffer covers any minor-version growth.
        let mut buf = vec![0u8; 16 << 10];
        if props(buf.as_mut_ptr(), 0) != 0 {
            return None;
        }
        let end = buf[..256].iter().position(|&b| b == 0).unwrap_or(256);
        let name = String::from_utf8_lossy(&buf[..end]).into_owned();
        let mem: MemInfo = std::mem::transmute(GetProcAddress(h, c"cudaMemGetInfo".as_ptr() as *const u8)?);
        let (mut free, mut total) = (0usize, 0usize);
        if mem(&mut free, &mut total) != 0 {
            return Some((name, 0));
        }
        Some((name, total as u64))
    }
}

#[cfg(not(windows))]
pub fn cuda_device_info(_cuda_dir: &Path) -> Option<(String, u64)> {
    None
}

/// song_to_midi._separation_batch: chunks per forward scaled to VRAM (the
/// stock config is 1). Only MSST's fade-window choice depends on it here.
pub fn separation_batch_for_vram(total_bytes: u64) -> usize {
    let gb = total_bytes as f64 / (1u64 << 30) as f64;
    if gb >= 11.5 {
        6
    } else if gb >= 7.5 {
        4
    } else if gb >= 5.5 {
        2
    } else {
        1
    }
}

/// Put `dir` first on PATH so the CUDA EP's dependent DLLs resolve from it.
pub fn prepend_path(dir: &Path) -> Result<()> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    let mut v = vec![dir.to_path_buf()];
    v.extend(std::env::split_paths(&path));
    std::env::set_var("PATH", std::env::join_paths(v)?);
    Ok(())
}

/// (major, minor) of the loaded ONNX Runtime: OrtApiBase::GetVersionString
/// of the dll init_ort loaded ("1.22.0"), else the build info string when it
/// names a release branch (the pip builds say "git-branch=HEAD"). None
/// before init.
pub fn loaded_version() -> Option<(u32, u32)> {
    crate::backbone::loaded_dylib().and_then(|p| dylib_version(&p)).or_else(|| parse_build_info(ort::info()))
}

/// The version string an onnxruntime.dll reports, parsed to (major, minor).
#[cfg(windows)]
pub fn dylib_version(dll: &Path) -> Option<(u32, u32)> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    #[repr(C)]
    struct ApiBase {
        get_api: unsafe extern "system" fn(u32) -> *const core::ffi::c_void,
        get_version_string: unsafe extern "system" fn() -> *const core::ffi::c_char,
    }
    let wide: Vec<u16> = dll.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        // Already loaded by init_ort: this only takes another reference.
        let h = LoadLibraryW(wide.as_ptr());
        if h.is_null() {
            return None;
        }
        type GetBase = unsafe extern "system" fn() -> *const ApiBase;
        let f: GetBase = std::mem::transmute(GetProcAddress(h, c"OrtGetApiBase".as_ptr() as *const u8)?);
        let base = f();
        if base.is_null() {
            return None;
        }
        let s = std::ffi::CStr::from_ptr(((*base).get_version_string)()).to_string_lossy().into_owned();
        let mut it = s.split('.');
        Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
    }
}

#[cfg(not(windows))]
pub fn dylib_version(_dll: &Path) -> Option<(u32, u32)> {
    None
}

pub fn parse_build_info(info: &str) -> Option<(u32, u32)> {
    let rest = &info[info.find("rel-")? + 4..];
    let mut it = rest.split(|c: char| !c.is_ascii_digit());
    let major = it.next()?.parse().ok()?;
    let minor = it.next()?.parse().ok()?;
    Some((major, minor))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_info_versions() {
        assert_eq!(parse_build_info("ORT Build Info: git-branch=rel-1.22.0, git-commit-id=5ab3cf2, build type=Release"), Some((1, 22)));
        assert_eq!(parse_build_info("ORT Build Info: git-branch=rel-1.24.4, git-commit-id=x"), Some((1, 24)));
        assert_eq!(parse_build_info("ORT Build Info: git-branch=main, git-commit-id=x"), None);
        assert_eq!(EpChoice::parse("CUDA").unwrap(), EpChoice::Cuda);
        assert!(EpChoice::parse("dml").is_err());
    }
}
