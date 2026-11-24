//! Studio and its standalone Forge CLI both load user-owned native code. Refuse
//! elevation before starting that code; an unreadable token is not proof of safety.
use std::io;
use windows_sys::Win32::{Foundation::CloseHandle, Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY},
    System::Threading::{GetCurrentProcess, OpenProcessToken}};

pub(crate) fn require() -> io::Result<()> {
    let mut token = std::ptr::null_mut();
    let mut info = TOKEN_ELEVATION { TokenIsElevated: 1 };
    let mut size = 0;
    unsafe {
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 { return Err(io::Error::last_os_error()); }
        let ok = GetTokenInformation(token, TokenElevation, (&mut info as *mut TOKEN_ELEVATION).cast(),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32, &mut size);
        CloseHandle(token);
        if ok == 0 || info.TokenIsElevated != 0 {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied,
                "Close MIDI Studio and Forge, then reopen without Run as administrator to use per-user components."));
        }
    }
    Ok(())
}
