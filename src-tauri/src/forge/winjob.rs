// winjob.rs: the Win32 side of a Forge job.
//
// Every Forge child (pipeline, yt-dlp, capability probe, setup) starts
// suspended, goes into a Job Object of its own and only then runs, so nothing
// it spawns can escape the job before it is in it. The job:
//   * KILL_ON_JOB_CLOSE: when the host goes, however it goes, the whole tree
//     goes with it. Electron needed taskkill /t and a pid file for that.
//   * JOB_MEMORY: only when MIDI_STUDIO_FORGE_MEM_LIMIT_MB sets one (tests
//     and dev runs; 0 or unset = no cap, like the Electron build). A fixed cap
//     broke real jobs: CUDA's host-side commit counts against it, so a
//     7.5 GiB cap turned into CUDA OOM on an 8 GB card.
// Pause is NtSuspendProcess on every process in the job (forge-runner.js
// reached the same call through PowerShell and only ever suspended the direct
// child, so the Transkun grandchild kept the GPU busy), priority is
// SetPriorityClass on every process in the job, cancel is TerminateJobObject.
use std::collections::{HashMap, HashSet};
use std::io;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, SetPriorityClass, TerminateProcess, BELOW_NORMAL_PRIORITY_CLASS, CREATE_NO_WINDOW, CREATE_SUSPENDED,
    IDLE_PRIORITY_CLASS, PROCESS_SET_INFORMATION, PROCESS_SUSPEND_RESUME, PROCESS_TERMINATE,
};

#[link(name = "ntdll")]
extern "system" {
    fn NtSuspendProcess(process: HANDLE) -> i32;
    fn NtResumeProcess(process: HANDLE) -> i32;
}

/// 7.5 GiB, forge-rs memlimit's default (tests only: real jobs run uncapped).
#[cfg(test)]
pub const DEFAULT_MEM_LIMIT: usize = 7 * (1 << 30) + (1 << 29);

/// The cap every Forge job gets. None = no cap.
pub fn mem_limit() -> Option<usize> {
    match std::env::var("MIDI_STUDIO_FORGE_MEM_LIMIT_MB").ok().and_then(|v| v.trim().parse::<usize>().ok()) {
        Some(0) | None => None,
        Some(mb) => Some(mb << 20),
    }
}

pub struct Job {
    h: HANDLE,
    limit: Option<usize>,
}
// A job handle is a kernel handle: any thread may use it.
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

impl Drop for Job {
    fn drop(&mut self) {
        // KILL_ON_JOB_CLOSE: closing the last handle ends whatever is left.
        unsafe { CloseHandle(self.h) };
    }
}

#[repr(C)]
struct PidList {
    assigned: u32,
    listed: u32,
    pids: [usize; 256],
}

impl Job {
    pub fn new(limit: Option<usize>) -> io::Result<Job> {
        unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Job { h, limit };
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if let Some(l) = limit {
                info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
                info.JobMemoryLimit = l;
            }
            if SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }
    }

    fn extended(&self) -> Option<JOBOBJECT_EXTENDED_LIMIT_INFORMATION> {
        unsafe {
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            (QueryInformationJobObject(
                self.h,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *mut core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                std::ptr::null_mut(),
            ) != 0)
                .then_some(info)
        }
    }

    /// The memory cap as the kernel holds it (read back, not remembered).
    pub fn memory_limit(&self) -> Option<usize> {
        self.extended()
            .filter(|i| i.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_JOB_MEMORY != 0)
            .map(|i| i.JobMemoryLimit)
    }

    pub fn kills_on_close(&self) -> bool {
        self.extended().is_some_and(|i| i.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE != 0)
    }

    /// Peak committed memory of every process in the job together, bytes.
    pub fn peak_memory(&self) -> usize {
        self.extended().map_or(0, |i| i.PeakJobMemoryUsed)
    }

    pub fn configured_limit(&self) -> Option<usize> {
        self.limit
    }

    pub fn pids(&self) -> Vec<u32> {
        unsafe {
            let mut list: PidList = std::mem::zeroed();
            if QueryInformationJobObject(
                self.h,
                JobObjectBasicProcessIdList,
                &mut list as *mut _ as *mut core::ffi::c_void,
                std::mem::size_of::<PidList>() as u32,
                std::ptr::null_mut(),
            ) == 0
            {
                return Vec::new();
            }
            list.pids[..(list.listed as usize).min(list.pids.len())].iter().map(|p| *p as u32).collect()
        }
    }

    pub fn terminate(&self) -> bool {
        unsafe { TerminateJobObject(self.h, 1) != 0 }
    }
}

/// Start `cmd` suspended, put it in `job`, then let it run. If the job cannot
/// take it (an old Windows without nested jobs), it runs anyway and the pid
/// file reap is what is left to catch an orphan.
pub fn spawn_in_job(cmd: &mut Command, job: &Job, idle: bool) -> io::Result<(Child, bool)> {
    let class = if idle { IDLE_PRIORITY_CLASS } else { BELOW_NORMAL_PRIORITY_CLASS };
    cmd.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED | class);
    let child = cmd.spawn()?;
    let h = child.as_raw_handle() as HANDLE;
    let in_job = unsafe { AssignProcessToJobObject(job.h, h) != 0 };
    unsafe { NtResumeProcess(h) };
    Ok((child, in_job))
}

fn with_process<T>(pid: u32, access: u32, f: impl FnOnce(HANDLE) -> T) -> Option<T> {
    if pid == 0 {
        return None;
    }
    unsafe {
        let h = OpenProcess(access, 0, pid);
        if h.is_null() {
            return None;
        }
        let r = f(h);
        CloseHandle(h);
        Some(r)
    }
}

/// NtSuspendProcess / NtResumeProcess. True when the call went through.
pub fn suspend(pid: u32, resume: bool) -> bool {
    with_process(pid, PROCESS_SUSPEND_RESUME, |h| unsafe {
        (if resume { NtResumeProcess(h) } else { NtSuspendProcess(h) }) >= 0
    })
    .unwrap_or(false)
}

/// Idle while something else needs the machine, below normal otherwise.
pub fn set_priority(pid: u32, idle: bool) -> bool {
    let class = if idle { IDLE_PRIORITY_CLASS } else { BELOW_NORMAL_PRIORITY_CLASS };
    with_process(pid, PROCESS_SET_INFORMATION, |h| unsafe { SetPriorityClass(h, class) != 0 }).unwrap_or(false)
}

pub fn priority_class(pid: u32) -> u32 {
    use windows_sys::Win32::System::Threading::{GetPriorityClass, PROCESS_QUERY_LIMITED_INFORMATION};
    with_process(pid, PROCESS_QUERY_LIMITED_INFORMATION, |h| unsafe { GetPriorityClass(h) }).unwrap_or(0)
}

#[cfg(test)]
const IDLE: u32 = IDLE_PRIORITY_CLASS;
#[cfg(test)]
const BELOW_NORMAL: u32 = BELOW_NORMAL_PRIORITY_CLASS;

/// (pid, parent pid, image name) for every process. Read-only: a snapshot
/// lists, it opens nothing.
pub fn snapshot() -> Vec<(u32, u32, String)> {
    let mut out = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE || snap.is_null() {
            return out;
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut e) != 0;
        while ok {
            let n = e.szExeFile.iter().position(|c| *c == 0).unwrap_or(e.szExeFile.len());
            out.push((e.th32ProcessID, e.th32ParentProcessID, String::from_utf16_lossy(&e.szExeFile[..n])));
            ok = Process32NextW(snap, &mut e) != 0;
        }
        CloseHandle(snap);
    }
    out
}

/// taskkill /pid N /t /f: the process and everything below it.
pub fn kill_tree(pid: u32) -> bool {
    let snap = snapshot();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (p, pp, _) in &snap {
        if p != pp {
            children.entry(*pp).or_default().push(*p);
        }
    }
    let mut seen = HashSet::new();
    let mut stack = vec![pid];
    let mut order = Vec::new();
    while let Some(p) = stack.pop() {
        if !seen.insert(p) {
            continue;
        }
        order.push(p);
        stack.extend(children.get(&p).into_iter().flatten().copied());
    }
    let mut root = false;
    for p in order {
        let ok = with_process(p, PROCESS_TERMINATE, |h| unsafe { TerminateProcess(h, 1) != 0 }).unwrap_or(false);
        if p == pid {
            root = ok;
        }
    }
    root
}

/// forge-runner.js isOurPython: only an interpreter (or the old player exe)
/// is ever reaped from the pid file, never whatever reused the number.
pub fn is_reapable_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n == "python.exe" || n == "pythonw.exe" || n == "midi-player.exe" || n == "forge-rs.exe"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_holds_limits_and_children() {
        let job = Job::new(Some(DEFAULT_MEM_LIMIT)).unwrap();
        assert_eq!(job.memory_limit(), Some(DEFAULT_MEM_LIMIT));
        assert!(job.kills_on_close());
        let mut cmd = Command::new("cmd.exe");
        cmd.args(["/c", "ping -n 30 127.0.0.1 >nul"]);
        let (mut child, in_job) = spawn_in_job(&mut cmd, &job, true).unwrap();
        assert!(in_job);
        // ping.exe starts whenever cmd gets scheduled; a fixed sleep raced it under load.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut pids = job.pids();
        while pids.len() < 2 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
            pids = job.pids();
        }
        assert!(pids.contains(&child.id()), "{pids:?}");
        // ping.exe is a grandchild and must be in the job too.
        assert!(pids.len() >= 2, "{pids:?}");
        assert_eq!(priority_class(child.id()), IDLE);
        assert!(set_priority(child.id(), false));
        assert_eq!(priority_class(child.id()), BELOW_NORMAL);
        for p in &pids {
            assert!(suspend(*p, false));
        }
        for p in &pids {
            assert!(suspend(*p, true));
        }
        assert!(job.terminate());
        let st = child.wait().unwrap();
        assert!(!st.success());
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(job.pids().is_empty());
    }

    #[test]
    fn closing_the_job_kills_the_tree() {
        let job = Job::new(None).unwrap();
        assert_eq!(job.memory_limit(), None);
        let mut cmd = Command::new("cmd.exe");
        cmd.args(["/c", "ping -n 30 127.0.0.1 >nul"]);
        let (mut child, _) = spawn_in_job(&mut cmd, &job, false).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let t = std::time::Instant::now();
        drop(job);
        child.wait().unwrap();
        // ping -n 30 runs ~29 s; ended at once means the job took it.
        assert!(t.elapsed() < std::time::Duration::from_secs(5), "{:?}", t.elapsed());
    }

    #[test]
    fn memory_cap_is_enforced() {
        // A child that tries to commit 1 GiB under a 400 MiB cap fails.
        let alloc = |limit: Option<usize>, mb: u32| {
            let job = Job::new(limit).unwrap();
            let mut cmd = Command::new("powershell.exe");
            let script = format!("try {{ $b = New-Object byte[] ({mb}MB); $b[0] = 1; exit 0 }} catch {{ exit 3 }}");
            cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
            let (mut child, _) = spawn_in_job(&mut cmd, &job, true).unwrap();
            let code = child.wait().unwrap().code();
            (code, job.peak_memory())
        };
        let cap = Some(400 << 20);
        assert_eq!(alloc(cap, 1024).0, Some(3), "a 1 GiB allocation got past a 400 MiB job cap");
        let (code, peak) = alloc(cap, 64);
        assert_eq!(code, Some(0), "a small allocation under the cap works");
        assert!(peak > 64 << 20 && peak < 400 << 20, "{peak}");
        // And with no cap the 1 GiB goes through: the cap is what stopped it.
        assert_eq!(alloc(None, 1024).0, Some(0));
    }

    #[test]
    fn kill_tree_ends_children() {
        let mut cmd = Command::new("cmd.exe");
        cmd.args(["/c", "ping -n 30 127.0.0.1 >nul"]).creation_flags(CREATE_NO_WINDOW);
        let mut child = cmd.spawn().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(400));
        let kids: Vec<u32> = snapshot().into_iter().filter(|(_, pp, _)| *pp == child.id()).map(|(p, _, _)| p).collect();
        assert!(!kids.is_empty());
        assert!(kill_tree(child.id()));
        child.wait().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        let alive: Vec<u32> = snapshot().into_iter().map(|(p, _, _)| p).collect();
        assert!(kids.iter().all(|k| !alive.contains(k)));
    }

    #[test]
    fn reapable_names() {
        assert!(is_reapable_name("python.exe"));
        assert!(is_reapable_name("forge-rs.exe"));
        assert!(is_reapable_name("PythonW.exe"));
        assert!(is_reapable_name("midi-player.exe"));
        assert!(!is_reapable_name("python3.exe.bak"));
        assert!(!is_reapable_name("explorer.exe"));
    }
}
