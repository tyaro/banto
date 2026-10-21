//! `admin-template-fw-elev.exe` (ADR-0021): the UAC-elevated firewall helper.
//!
//! The `requireAdministrator` manifest (embedded into this bin only by
//! build.rs) makes Windows ask for elevation when it starts; the helper has
//! no code that elevates itself. Everything is in the lib
//! (`admin_template_fw_elev`); this only passes the arguments and exits with
//! the code `run` returns.
//!
//! ```text
//! admin-template-fw-elev.exe firewall-allow | firewall-remove | firewall-status
//! ```

#[cfg(windows)]
fn main() {
    use admin_template_fw_elev::win::{CurrentExeProbe, PowerShellFirewall};
    use admin_template_fw_elev::{parse_args, run, usage_lines, EXIT_FAILED, EXIT_USAGE};

    // Decision 7: an elevated process's working directory is chosen by its
    // caller, so DLLs loaded from here on are looked up in System32 only.
    // SAFETY: changes a process-wide setting; no pointers are passed.
    unsafe {
        windows_sys::Win32::System::LibraryLoader::SetDefaultDllDirectories(
            windows_sys::Win32::System::LibraryLoader::LOAD_LIBRARY_SEARCH_SYSTEM32,
        );
    }

    let op = match parse_args(std::env::args_os().skip(1)) {
        Ok(op) => op,
        Err(reason) => {
            for line in usage_lines(&reason.to_string()) {
                eprintln!("{line}");
            }
            std::process::exit(EXIT_USAGE);
        }
    };
    let firewall = match PowerShellFirewall::new() {
        Ok(firewall) => firewall,
        Err(e) => {
            eprintln!("admin-template-fw-elev: {e}");
            std::process::exit(EXIT_FAILED);
        }
    };
    let code = run(op, &CurrentExeProbe, &firewall, &mut |line| {
        println!("{line}")
    });
    std::process::exit(code);
}

#[cfg(not(windows))]
fn main() {
    for line in admin_template_fw_elev::not_windows_lines() {
        eprintln!("{line}");
    }
    std::process::exit(admin_template_fw_elev::EXIT_USAGE);
}
