//! Self-imposed memory cap via a Windows Job Object.
//!
//! `apply()` creates a job with `JOB_OBJECT_LIMIT_PROCESS_MEMORY |
//! JOB_OBJECT_LIMIT_JOB_MEMORY | KILL_ON_JOB_CLOSE` and assigns the current
//! process to it, so any allocation past the cap fails (Rust aborts with an
//! allocation error, ONNX Runtime returns an error) instead of paging the
//! machine to death. Child processes inherit the job.

/// Default cap used by the CLI and the tests: 7.5 GiB.
pub const DEFAULT_LIMIT_BYTES: usize = 7 * (1 << 30) + (1 << 29);

#[derive(Debug, Clone, Copy, Default)]
pub struct MemPeaks {
    /// Peak committed memory of the job (all processes), bytes.
    pub job_commit: usize,
    /// Peak committed memory of any single process in the job, bytes.
    pub process_commit: usize,
    /// Peak working set of this process, bytes.
    pub working_set: usize,
}

impl std::fmt::Display for MemPeaks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let g = |b: usize| b as f64 / (1u64 << 30) as f64;
        write!(
            f,
            "peak_job_commit_gib={:.3}  peak_process_commit_gib={:.3}  peak_working_set_gib={:.3}",
            g(self.job_commit),
            g(self.process_commit),
            g(self.working_set)
        )
    }
}

#[cfg(windows)]
mod imp {
    use super::MemPeaks;
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        QueryInformationJobObject, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOB_OBJECT_LIMIT_PROCESS_MEMORY,
    };
    use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    struct Job(HANDLE, usize);
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    static JOB: OnceLock<Job> = OnceLock::new();

    pub fn apply(limit: usize) -> std::io::Result<usize> {
        if let Some(j) = JOB.get() {
            return Ok(j.1);
        }
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY
                | JOB_OBJECT_LIMIT_JOB_MEMORY
                | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            info.ProcessMemoryLimit = limit;
            info.JobMemoryLimit = limit;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                return Err(std::io::Error::last_os_error());
            }
            if AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            let _ = JOB.set(Job(job, limit));
        }
        Ok(limit)
    }

    pub fn peaks() -> MemPeaks {
        let mut p = MemPeaks::default();
        unsafe {
            if let Some(j) = JOB.get() {
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                if QueryInformationJobObject(
                    j.0,
                    JobObjectExtendedLimitInformation,
                    &mut info as *mut _ as *mut core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                    std::ptr::null_mut(),
                ) != 0
                {
                    p.job_commit = info.PeakJobMemoryUsed;
                    p.process_commit = info.PeakProcessMemoryUsed;
                }
            }
            let mut pmc: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
            pmc.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
            if GetProcessMemoryInfo(GetCurrentProcess(), &mut pmc, pmc.cb) != 0 {
                p.working_set = pmc.PeakWorkingSetSize;
            }
        }
        p
    }
}

#[cfg(not(windows))]
mod imp {
    use super::MemPeaks;
    pub fn apply(limit: usize) -> std::io::Result<usize> {
        // RLIMIT_AS would be the analogue; forge-rs ships on Windows only for now.
        Ok(limit)
    }
    pub fn peaks() -> MemPeaks {
        MemPeaks::default()
    }
}

/// Cap this process (and its children). Idempotent: later calls keep the
/// first limit. Returns the limit in effect.
pub fn apply(limit_bytes: usize) -> std::io::Result<usize> {
    imp::apply(limit_bytes)
}

pub fn peaks() -> MemPeaks {
    imp::peaks()
}

/// Try to reserve `bytes`; used to prove the cap is live before heavy work.
pub fn can_allocate(bytes: usize) -> bool {
    let mut v: Vec<u8> = Vec::new();
    v.try_reserve_exact(bytes).is_ok()
}
