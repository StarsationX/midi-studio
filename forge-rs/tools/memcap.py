"""Cap this process (and any children) with a Windows Job Object.

Import and call apply() FIRST, before torch/onnxruntime load. The job sets
JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY |
KILL_ON_JOB_CLOSE, so an allocation past the cap fails (MemoryError /
bad_alloc) instead of the machine paging itself to death.

    import memcap; memcap.apply()          # 7.5 GiB default
    ...
    memcap.report()                        # peak commit + peak working set
"""
import ctypes
import ctypes.wintypes as wt
import sys

GIB = 1024 ** 3
DEFAULT_LIMIT = int(7.5 * GIB)

JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100
JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JobObjectExtendedLimitInformation = 9


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [(n, ctypes.c_ulonglong) for n in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", wt.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wt.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wt.DWORD),
        ("SchedulingClass", wt.DWORD),
    ]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("cb", wt.DWORD),
        ("PageFaultCount", wt.DWORD),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
    ]


_k32 = ctypes.WinDLL("kernel32", use_last_error=True)
_k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wt.LPCWSTR]
_k32.CreateJobObjectW.restype = wt.HANDLE
_k32.SetInformationJobObject.argtypes = [wt.HANDLE, ctypes.c_int, ctypes.c_void_p, wt.DWORD]
_k32.SetInformationJobObject.restype = wt.BOOL
_k32.QueryInformationJobObject.argtypes = [wt.HANDLE, ctypes.c_int, ctypes.c_void_p, wt.DWORD,
                                           ctypes.POINTER(wt.DWORD)]
_k32.QueryInformationJobObject.restype = wt.BOOL
_k32.AssignProcessToJobObject.argtypes = [wt.HANDLE, wt.HANDLE]
_k32.AssignProcessToJobObject.restype = wt.BOOL
_k32.GetCurrentProcess.argtypes = []
_k32.GetCurrentProcess.restype = wt.HANDLE

_psapi = ctypes.WinDLL("psapi", use_last_error=True)
_psapi.GetProcessMemoryInfo.argtypes = [wt.HANDLE, ctypes.POINTER(PROCESS_MEMORY_COUNTERS), wt.DWORD]
_psapi.GetProcessMemoryInfo.restype = wt.BOOL

_job = None


def apply(limit_bytes: int = DEFAULT_LIMIT) -> None:
    global _job
    if _job is not None:
        return
    job = _k32.CreateJobObjectW(None, None)
    if not job:
        raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")
    info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    info.BasicLimitInformation.LimitFlags = (
        JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY
        | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
    info.ProcessMemoryLimit = limit_bytes
    info.JobMemoryLimit = limit_bytes
    if not _k32.SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                        ctypes.byref(info), ctypes.sizeof(info)):
        raise OSError(ctypes.get_last_error(), "SetInformationJobObject failed")
    if not _k32.AssignProcessToJobObject(job, _k32.GetCurrentProcess()):
        raise OSError(ctypes.get_last_error(), "AssignProcessToJobObject failed")
    _job = job
    print(f"[memcap] job memory limit {limit_bytes / GIB:.2f} GiB", file=sys.stderr)


def peaks() -> dict:
    out = {}
    if _job is not None:
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        if _k32.QueryInformationJobObject(_job, JobObjectExtendedLimitInformation,
                                          ctypes.byref(info), ctypes.sizeof(info), None):
            out["peak_job_commit_gib"] = info.PeakJobMemoryUsed / GIB
            out["peak_process_commit_gib"] = info.PeakProcessMemoryUsed / GIB
    pmc = PROCESS_MEMORY_COUNTERS()
    pmc.cb = ctypes.sizeof(pmc)
    if _psapi.GetProcessMemoryInfo(_k32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb):
        out["peak_working_set_gib"] = pmc.PeakWorkingSetSize / GIB
    return out


def report() -> None:
    p = peaks()
    print("[memcap] " + "  ".join(f"{k}={v:.3f}" for k, v in p.items()), file=sys.stderr)


if __name__ == "__main__":
    # Self-test: the cap must refuse a 9 GiB allocation.
    apply()
    try:
        buf = bytearray(9 * GIB)
        print("FAIL: 9 GiB allocation succeeded under the cap")
        sys.exit(1)
    except MemoryError:
        print("OK: 9 GiB allocation refused (MemoryError)")
    small = bytearray(512 * 1024 ** 2)   # 0.5 GiB must still work
    del small
    report()
