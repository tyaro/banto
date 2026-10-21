//! Spec §11.4 (LAN settings UX: documenting the OS-side Windows Firewall
//! behavior). Reads, without elevation, whether Windows Defender Firewall has
//! the rules the settings screen's administrator commands create (Issue #219,
//! stage 1 / PR-B), and compares them with what those commands would create
//! for the listener that is serving now.
//!
//! The rules are looked up by their deterministic `-Name` only
//! (`<identifier>.lan.tcp.program` / `.port`, the same names as
//! `firewallInfo.ts::firewallRuleNames`), and the `-Group <identifier>` is
//! only counted. The read never changes the firewall.
//!
//! How it reads: a child `powershell.exe` (the in-box Windows PowerShell,
//! by absolute path under `%SystemRoot%`, never `PATH`) runs a FIXED script
//! passed as `-EncodedCommand` (base64 of UTF-16LE), so nothing goes through
//! a command line that cmd/PowerShell would parse. The only values in the
//! script are the rule names, built from an identifier checked against
//! Tauri's identifier alphabet ([`rule_names`]) and still written as
//! PowerShell single-quoted literals ([`quote_powershell_literal`]). The
//! script prints one ASCII-only JSON object ([`evaluate`] parses it). A
//! failure, a timeout ([`PROBE_TIMEOUT`]) or any output that does not parse
//! is reported as `unknown` with a reason code - never as `missing`
//! (security audit 2026-10-21: a failed read is not "no rule").
//!
//! Codes and values only: the frontend builds every text (conventions §13).

use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

/// How long the read may take before it is reported as `unknown`/`timeout`.
/// PowerShell's start plus the NetSecurity module's first load is a few
/// seconds on a cold machine.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Upper bound on what is read from the child's stdout. The real output is
/// well under 4 KiB.
#[cfg_attr(not(windows), allow(dead_code))]
const MAX_OUTPUT: u64 = 64 * 1024;

/// What the administrator commands create (`firewallInfo.ts`: `Inbound`,
/// `TCP`, `Private`, `LocalSubnet`, `Allow`), as `Get-NetFirewall*` reports it.
const EXPECTED_ENABLED: &str = "True";
const EXPECTED_DIRECTION: &str = "Inbound";
const EXPECTED_ACTION: &str = "Allow";
const EXPECTED_PROTOCOL: &str = "TCP";
const EXPECTED_PROFILE: &str = "Private";
const EXPECTED_REMOTE_ADDRESS: &str = "LocalSubnet";
/// What a rule filter reports when it does not restrict the value.
const ANY: &str = "Any";

/// The rule names derived from the app identifier (Issue #219, PR #463).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RuleNames {
    pub(crate) group: String,
    pub(crate) program: String,
    pub(crate) port: String,
}

/// Whether `identifier` is in Tauri's bundle identifier alphabet - ASCII
/// letters, digits, `-` and `.`, starting with a letter or digit, at most 255
/// characters. Mirrors `firewallInfo.ts::isValidAppIdentifier`.
pub(crate) fn is_valid_identifier(identifier: &str) -> bool {
    let bytes = identifier.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 255
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'.' || *b == b'-')
}

/// The rule names for `identifier`, or `None` when it is not a valid
/// identifier (then nothing is read).
pub(crate) fn rule_names(identifier: &str) -> Option<RuleNames> {
    is_valid_identifier(identifier).then(|| RuleNames {
        group: identifier.to_string(),
        program: format!("{identifier}.lan.tcp.program"),
        port: format!("{identifier}.lan.tcp.port"),
    })
}

/// `value` as a PowerShell single-quoted literal: wrapped in `'` with every
/// character PowerShell treats as a single quote (ASCII `'` and U+2018-U+201B)
/// doubled, so nothing inside is expanded. `None` when `value` contains a
/// control character. Mirrors `firewallInfo.ts::quotePowerShellLiteral`.
pub(crate) fn quote_powershell_literal(value: &str) -> Option<String> {
    if value.chars().any(char::is_control) {
        return None;
    }
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('\'');
    for c in value.chars() {
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            quoted.push(c);
        }
        quoted.push(c);
    }
    quoted.push('\'');
    Some(quoted)
}

/// The fixed read-only script. `{GROUP}`, `{PROGRAM}` and `{PORT}` are
/// replaced with quoted literals. Each rule reports `s` = `missing` (only
/// when PowerShell says the object was not found), `error` (anything else
/// went wrong) or `present` with its values; `active` is whether the rule is
/// also in the ActiveStore (in effect), `null` when that could not be read;
/// `group` is how many OTHER rules carry the group, `-1` when unreadable.
/// The JSON is escaped to ASCII so the console code page cannot mangle a
/// non-ASCII path.
const PROBE_SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Test-BantoNotFound($e) { $e.CategoryInfo.Category -eq [System.Management.Automation.ErrorCategory]::ObjectNotFound }
function Read-BantoRule([string]$name) {
  try { $r = Get-NetFirewallRule -Name $name -ErrorAction Stop }
  catch { if (Test-BantoNotFound $_) { return @{ s = 'missing' } }; return @{ s = 'error' } }
  try {
    $app = $r | Get-NetFirewallApplicationFilter -ErrorAction Stop
    $pf = $r | Get-NetFirewallPortFilter -ErrorAction Stop
    $af = $r | Get-NetFirewallAddressFilter -ErrorAction Stop
  } catch { return @{ s = 'error' } }
  $active = $null
  try { $active = [bool](Get-NetFirewallRule -Name $name -PolicyStore ActiveStore -ErrorAction Stop) }
  catch { if (Test-BantoNotFound $_) { $active = $false } }
  return @{ s = 'present'; enabled = [string]$r.Enabled; direction = [string]$r.Direction; action = [string]$r.Action; profile = [string]$r.Profile; program = [string]$app.Program; protocol = [string]$pf.Protocol; localPort = @($pf.LocalPort | ForEach-Object { [string]$_ }); remoteAddress = @($af.RemoteAddress | ForEach-Object { [string]$_ }); active = $active }
}
$group = -1
try { $group = @(Get-NetFirewallRule -Group {GROUP} -ErrorAction Stop | Where-Object { $_.Name -ne {PROGRAM} -and $_.Name -ne {PORT} }).Count }
catch { if (Test-BantoNotFound $_) { $group = 0 } }
$out = @{ program = (Read-BantoRule {PROGRAM}); port = (Read-BantoRule {PORT}); group = $group }
$json = ConvertTo-Json -InputObject $out -Compress -Depth 5
$sb = New-Object System.Text.StringBuilder
foreach ($c in $json.ToCharArray()) { if ([int]$c -lt 128) { [void]$sb.Append($c) } else { [void]$sb.AppendFormat('\u{0:x4}', [int]$c) } }
[Console]::Out.Write($sb.ToString())
"#;

/// The script for `names`, or `None` if a name cannot be quoted (it always
/// can for names from [`rule_names`]).
pub(crate) fn probe_script(names: &RuleNames) -> Option<String> {
    let group = quote_powershell_literal(&names.group)?;
    let program = quote_powershell_literal(&names.program)?;
    let port = quote_powershell_literal(&names.port)?;
    Some(
        PROBE_SCRIPT
            .replace("{GROUP}", &group)
            .replace("{PROGRAM}", &program)
            .replace("{PORT}", &port),
    )
}

/// `script` as PowerShell's `-EncodedCommand` argument: base64 of its
/// UTF-16LE bytes. The result is only `[A-Za-z0-9+/=]`.
pub(crate) fn encode_command(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64_encode(&bytes)
}

/// Standard base64 with padding (RFC 4648 §4). Small enough to keep rather
/// than add a dependency for one call (conventions §3).
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Why a rule's state could not be told. Mirrors
/// `firewallRuleStatus.ts::FirewallUnknownReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum UnknownReason {
    /// This host is not Windows.
    #[cfg_attr(windows, allow(dead_code))]
    NotWindows,
    /// The app identifier is not a valid identifier, so no rule name exists.
    InvalidIdentifier,
    /// PowerShell could not be started.
    LaunchFailed,
    /// The read did not finish within [`PROBE_TIMEOUT`].
    Timeout,
    /// PowerShell reported an error (access refused, a policy that hides the
    /// rule store, the NetSecurity module unavailable, ...).
    QueryFailed,
    /// The output was not what the script prints.
    UnreadableOutput,
}

/// A rule value that differs from what the commands create (or could not be
/// compared). Mirrors `firewallRuleStatus.ts::FirewallField`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FirewallField {
    Enabled,
    Direction,
    Action,
    Protocol,
    Profile,
    Program,
    LocalPort,
    RemoteAddress,
    /// The rule is in the local store but not in the ActiveStore: a policy
    /// (e.g. Group Policy not merging local rules) keeps it from applying.
    Active,
}

/// The values of a rule that exists, as `Get-NetFirewall*` reports them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FirewallRuleValues {
    pub(crate) enabled: String,
    pub(crate) direction: String,
    pub(crate) action: String,
    pub(crate) protocol: String,
    pub(crate) profile: String,
    pub(crate) program: String,
    pub(crate) local_ports: Vec<String>,
    pub(crate) remote_addresses: Vec<String>,
    /// Whether the rule is in effect (in the ActiveStore); `None` when that
    /// could not be read.
    pub(crate) active: Option<bool>,
}

/// One rule's state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
// Two values per response, built once and serialized: boxing `Present` would
// only add an allocation.
#[allow(clippy::large_enum_variant)]
pub(crate) enum FirewallRuleCheck {
    /// No rule of this name in the local store.
    Missing,
    /// The rule exists. `mismatches` lists what differs from the command's
    /// rule (empty = as expected); `unchecked` what could not be compared
    /// (no live listener or executable path to compare with, or the
    /// ActiveStore was unreadable).
    Present {
        rule: FirewallRuleValues,
        mismatches: Vec<FirewallField>,
        unchecked: Vec<FirewallField>,
    },
    /// The state could not be read.
    Unknown { reason: UnknownReason },
}

/// What the rules were compared with: the server snapshot of `generation`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FirewallExpectation {
    /// `server_status.executablePath` of the same snapshot.
    pub(crate) executable_path: Option<String>,
    /// `server_status.live.port` of the same snapshot (`None` when nothing
    /// is serving).
    pub(crate) port: Option<u16>,
}

/// `firewall_rule_status`'s response. Mirrors
/// `firewallRuleStatus.ts::FirewallRuleStatus`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FirewallRuleStatus {
    /// `ServerSlot::generation` of the snapshot `expected` came from, so the
    /// screen can drop a result for a listener it no longer shows.
    pub(crate) generation: u64,
    pub(crate) expected: FirewallExpectation,
    /// The per-executable rule (`<identifier>.lan.tcp.program`).
    pub(crate) program: FirewallRuleCheck,
    /// The per-port rule (`<identifier>.lan.tcp.port`).
    pub(crate) port: FirewallRuleCheck,
    /// How many other rules carry `-Group <identifier>` (a hint that a rule
    /// was made under another name); `None` when unknown.
    pub(crate) group_other_rules: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuleShape {
    Program,
    Port,
}

/// Builds the response from the probe's outcome (`Ok` = the script's stdout).
pub(crate) fn evaluate(
    generation: u64,
    expected: FirewallExpectation,
    outcome: Result<String, UnknownReason>,
) -> FirewallRuleStatus {
    let parsed = outcome.and_then(|stdout| {
        serde_json::from_str::<Value>(stdout.trim())
            .ok()
            .filter(Value::is_object)
            .ok_or(UnknownReason::UnreadableOutput)
    });
    let (program, port, group_other_rules) = match parsed {
        Err(reason) => (
            FirewallRuleCheck::Unknown { reason },
            FirewallRuleCheck::Unknown { reason },
            None,
        ),
        Ok(value) => (
            check_rule(value.get("program"), RuleShape::Program, &expected),
            check_rule(value.get("port"), RuleShape::Port, &expected),
            value
                .get("group")
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok()),
        ),
    };
    FirewallRuleStatus {
        generation,
        expected,
        program,
        port,
        group_other_rules,
    }
}

fn check_rule(
    value: Option<&Value>,
    shape: RuleShape,
    expected: &FirewallExpectation,
) -> FirewallRuleCheck {
    let unknown = |reason| FirewallRuleCheck::Unknown { reason };
    let Some(value) = value else {
        return unknown(UnknownReason::UnreadableOutput);
    };
    match value.get("s").and_then(Value::as_str) {
        Some("missing") => FirewallRuleCheck::Missing,
        Some("error") => unknown(UnknownReason::QueryFailed),
        Some("present") => match parse_values(value) {
            Some(rule) => {
                let (mismatches, unchecked) = compare(&rule, shape, expected);
                FirewallRuleCheck::Present {
                    rule,
                    mismatches,
                    unchecked,
                }
            }
            None => unknown(UnknownReason::UnreadableOutput),
        },
        _ => unknown(UnknownReason::UnreadableOutput),
    }
}

fn parse_values(value: &Value) -> Option<FirewallRuleValues> {
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
    Some(FirewallRuleValues {
        enabled: text("enabled")?,
        direction: text("direction")?,
        action: text("action")?,
        protocol: text("protocol")?,
        profile: text("profile")?,
        program: text("program")?,
        local_ports: string_list(value.get("localPort")?)?,
        remote_addresses: string_list(value.get("remoteAddress")?)?,
        active: match value.get("active") {
            None | Some(Value::Null) => None,
            Some(Value::Bool(active)) => Some(*active),
            Some(_) => return None,
        },
    })
}

/// A JSON string array, or a lone string (PowerShell can unwrap a
/// one-element array).
fn string_list(value: &Value) -> Option<Vec<String>> {
    match value {
        Value::String(s) => Some(vec![s.clone()]),
        Value::Array(items) => items
            .iter()
            .map(|item| item.as_str().map(str::to_string))
            .collect(),
        _ => None,
    }
}

/// `list` is exactly the one value `expected` (ignoring ASCII case).
fn is_only(list: &[String], expected: &str) -> bool {
    matches!(list, [only] if only.eq_ignore_ascii_case(expected))
}

/// Compares `rule` with what the command for `shape` creates. Windows paths
/// are compared ignoring case.
fn compare(
    rule: &FirewallRuleValues,
    shape: RuleShape,
    expected: &FirewallExpectation,
) -> (Vec<FirewallField>, Vec<FirewallField>) {
    let mut mismatches = Vec::new();
    let mut unchecked = Vec::new();
    let mut expect = |field, ok: bool| {
        if !ok {
            mismatches.push(field);
        }
    };
    expect(
        FirewallField::Enabled,
        rule.enabled.eq_ignore_ascii_case(EXPECTED_ENABLED),
    );
    expect(
        FirewallField::Direction,
        rule.direction.eq_ignore_ascii_case(EXPECTED_DIRECTION),
    );
    expect(
        FirewallField::Action,
        rule.action.eq_ignore_ascii_case(EXPECTED_ACTION),
    );
    expect(
        FirewallField::Protocol,
        rule.protocol.eq_ignore_ascii_case(EXPECTED_PROTOCOL),
    );
    expect(
        FirewallField::Profile,
        rule.profile.eq_ignore_ascii_case(EXPECTED_PROFILE),
    );
    expect(
        FirewallField::RemoteAddress,
        is_only(&rule.remote_addresses, EXPECTED_REMOTE_ADDRESS),
    );
    match shape {
        RuleShape::Program => {
            match &expected.executable_path {
                Some(path) => expect(
                    FirewallField::Program,
                    rule.program.to_lowercase() == path.to_lowercase(),
                ),
                None => unchecked.push(FirewallField::Program),
            }
            expect(FirewallField::LocalPort, is_only(&rule.local_ports, ANY));
        }
        RuleShape::Port => {
            expect(
                FirewallField::Program,
                rule.program.eq_ignore_ascii_case(ANY),
            );
            match expected.port {
                Some(port) => expect(
                    FirewallField::LocalPort,
                    is_only(&rule.local_ports, &port.to_string()),
                ),
                None => unchecked.push(FirewallField::LocalPort),
            }
        }
    }
    match rule.active {
        Some(active) => expect(FirewallField::Active, active),
        None => unchecked.push(FirewallField::Active),
    }
    mismatches.sort();
    unchecked.sort();
    (mismatches, unchecked)
}

/// Reads the rules for `names` (blocking, up to [`PROBE_TIMEOUT`]). Returns
/// the script's stdout; [`evaluate`] interprets it.
pub(crate) fn probe(names: &RuleNames) -> Result<String, UnknownReason> {
    let script = probe_script(names).ok_or(UnknownReason::InvalidIdentifier)?;
    run_encoded(&encode_command(&script))
}

#[cfg(not(windows))]
fn run_encoded(_encoded: &str) -> Result<String, UnknownReason> {
    Err(UnknownReason::NotWindows)
}

/// The in-box Windows PowerShell under `%SystemRoot%`, so neither `PATH` nor
/// the working directory decides which program runs.
#[cfg(windows)]
fn windows_powershell() -> Option<std::path::PathBuf> {
    let root = std::path::PathBuf::from(std::env::var_os("SystemRoot")?);
    if !root.is_absolute() {
        return None;
    }
    let exe = root.join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    exe.is_file().then_some(exe)
}

#[cfg(windows)]
fn run_encoded(encoded: &str) -> Result<String, UnknownReason> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Instant;
    /// No console window flashes up for the child.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let exe = windows_powershell().ok_or(UnknownReason::LaunchFailed)?;
    let mut child = Command::new(exe)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            encoded,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|_| UnknownReason::LaunchFailed)?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(UnknownReason::LaunchFailed);
    };
    // Read on another thread so a full pipe cannot stall the child while
    // this one waits for it.
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        stdout.take(MAX_OUTPUT).read_to_end(&mut buf).map(|_| buf)
    });
    let deadline = Instant::now() + PROBE_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(UnknownReason::Timeout);
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(UnknownReason::QueryFailed);
            }
        }
    };
    let output = reader
        .join()
        .ok()
        .and_then(Result::ok)
        .ok_or(UnknownReason::UnreadableOutput)?;
    if !status.success() {
        return Err(UnknownReason::QueryFailed);
    }
    String::from_utf8(output).map_err(|_| UnknownReason::UnreadableOutput)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const EXE: &str = r"C:\Program Files\Banto\banto.exe";

    fn expected() -> FirewallExpectation {
        FirewallExpectation {
            executable_path: Some(EXE.to_string()),
            port: Some(8721),
        }
    }

    fn present(overrides: Value) -> Value {
        let mut rule = json!({
            "s": "present",
            "enabled": "True",
            "direction": "Inbound",
            "action": "Allow",
            "protocol": "TCP",
            "profile": "Private",
            "program": "Any",
            "localPort": ["Any"],
            "remoteAddress": ["LocalSubnet"],
            "active": true
        });
        for (key, value) in overrides.as_object().unwrap() {
            rule[key] = value.clone();
        }
        rule
    }

    fn program_rule(overrides: Value) -> Value {
        let mut rule = present(json!({ "program": EXE }));
        for (key, value) in overrides.as_object().unwrap() {
            rule[key] = value.clone();
        }
        rule
    }

    fn port_rule(overrides: Value) -> Value {
        let mut rule = present(json!({ "localPort": ["8721"] }));
        for (key, value) in overrides.as_object().unwrap() {
            rule[key] = value.clone();
        }
        rule
    }

    fn run(output: Value) -> FirewallRuleStatus {
        evaluate(7, expected(), Ok(output.to_string()))
    }

    fn mismatches(check: &FirewallRuleCheck) -> Vec<FirewallField> {
        match check {
            FirewallRuleCheck::Present { mismatches, .. } => mismatches.clone(),
            other => panic!("not present: {other:?}"),
        }
    }

    #[test]
    fn identifiers_follow_the_tauri_alphabet() {
        assert!(is_valid_identifier("com.example.banto"));
        assert!(is_valid_identifier("a"));
        assert!(is_valid_identifier(&"a".repeat(255)));
        for bad in [
            "",
            ".com.example",
            "-x",
            "com example",
            "com'example",
            "com.example;calc",
            "com.例",
            "a$b",
            &"a".repeat(256),
        ] {
            assert!(!is_valid_identifier(bad), "{bad:?}");
            assert_eq!(rule_names(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn rule_names_match_the_commands() {
        assert_eq!(
            rule_names("com.example.banto"),
            Some(RuleNames {
                group: "com.example.banto".into(),
                program: "com.example.banto.lan.tcp.program".into(),
                port: "com.example.banto.lan.tcp.port".into(),
            })
        );
    }

    #[test]
    fn quoting_doubles_every_single_quote_and_refuses_control_characters() {
        assert_eq!(quote_powershell_literal("abc").as_deref(), Some("'abc'"));
        assert_eq!(
            quote_powershell_literal("a'b\u{2018}c\u{2019}d\u{201A}e\u{201B}f").as_deref(),
            Some("'a''b\u{2018}\u{2018}c\u{2019}\u{2019}d\u{201A}\u{201A}e\u{201B}\u{201B}f'")
        );
        assert_eq!(
            quote_powershell_literal("$(calc) `x` \"y\"").as_deref(),
            Some("'$(calc) `x` \"y\"'")
        );
        assert_eq!(quote_powershell_literal("a\nb"), None);
        assert_eq!(quote_powershell_literal("a\u{0}b"), None);
        assert_eq!(quote_powershell_literal("a\u{85}b"), None);
    }

    #[test]
    fn the_script_names_only_the_quoted_rule_names_and_changes_nothing() {
        let names = rule_names("com.example.banto").unwrap();
        let script = probe_script(&names).unwrap();
        assert!(!script.contains("{GROUP}") && !script.contains("{PROGRAM}"));
        assert!(script.contains("Read-BantoRule 'com.example.banto.lan.tcp.program'"));
        assert!(script.contains("Read-BantoRule 'com.example.banto.lan.tcp.port'"));
        assert!(script.contains("-Group 'com.example.banto'"));
        // Read-only: no cmdlet that changes the firewall.
        for verb in [
            "New-NetFirewall",
            "Set-NetFirewall",
            "Remove-NetFirewall",
            "Enable-NetFirewall",
            "Disable-NetFirewall",
            "Rename-NetFirewall",
            "Copy-NetFirewall",
            "Invoke-Expression",
            "iex ",
        ] {
            assert!(!script.contains(verb), "{verb}");
        }
    }

    #[test]
    fn the_encoded_command_is_base64_of_utf16le() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        // `[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('dir'))`
        assert_eq!(encode_command("dir"), "ZABpAHIA");
        let names = rule_names("com.example.banto").unwrap();
        let encoded = encode_command(&probe_script(&names).unwrap());
        assert!(encoded
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'='));
    }

    #[test]
    fn rules_as_the_commands_create_them_match() {
        let status = run(
            json!({ "program": program_rule(json!({})), "port": port_rule(json!({})), "group": 0 }),
        );
        assert_eq!(mismatches(&status.program), vec![]);
        assert_eq!(mismatches(&status.port), vec![]);
        assert_eq!(status.group_other_rules, Some(0));
        assert_eq!(status.generation, 7);
        assert_eq!(status.expected, expected());
    }

    #[test]
    fn missing_rules_are_missing_and_errors_are_unknown() {
        let status =
            run(json!({ "program": { "s": "missing" }, "port": { "s": "error" }, "group": -1 }));
        assert_eq!(status.program, FirewallRuleCheck::Missing);
        assert_eq!(
            status.port,
            FirewallRuleCheck::Unknown {
                reason: UnknownReason::QueryFailed
            }
        );
        assert_eq!(status.group_other_rules, None);
    }

    #[test]
    fn a_failed_read_is_never_reported_as_missing() {
        for reason in [
            UnknownReason::NotWindows,
            UnknownReason::LaunchFailed,
            UnknownReason::Timeout,
            UnknownReason::QueryFailed,
        ] {
            let status = evaluate(1, expected(), Err(reason));
            assert_eq!(status.program, FirewallRuleCheck::Unknown { reason });
            assert_eq!(status.port, FirewallRuleCheck::Unknown { reason });
            assert_eq!(status.group_other_rules, None);
        }
        for garbage in [
            "",
            "not json",
            "[]",
            "#< CLIXML",
            "{\"program\":{\"s\":\"maybe\"}}",
        ] {
            let status = evaluate(1, expected(), Ok(garbage.to_string()));
            assert_eq!(
                status.program,
                FirewallRuleCheck::Unknown {
                    reason: UnknownReason::UnreadableOutput
                },
                "{garbage:?}"
            );
        }
        // A present rule with a missing value is not guessed at.
        let mut rule = program_rule(json!({}));
        rule.as_object_mut().unwrap().remove("action");
        let status = run(json!({ "program": rule, "port": { "s": "missing" } }));
        assert_eq!(
            status.program,
            FirewallRuleCheck::Unknown {
                reason: UnknownReason::UnreadableOutput
            }
        );
    }

    #[test]
    fn administrator_changes_are_told_apart() {
        let status = run(json!({
            "program": program_rule(json!({ "action": "Block" })),
            "port": port_rule(json!({ "remoteAddress": ["192.168.1.10"] })),
        }));
        assert_eq!(mismatches(&status.program), vec![FirewallField::Action]);
        assert_eq!(mismatches(&status.port), vec![FirewallField::RemoteAddress]);

        // Another executable; an old port.
        let status = run(json!({
            "program": program_rule(json!({ "program": r"D:\old\banto.exe" })),
            "port": port_rule(json!({ "localPort": ["8720"] })),
        }));
        assert_eq!(mismatches(&status.program), vec![FirewallField::Program]);
        assert_eq!(mismatches(&status.port), vec![FirewallField::LocalPort]);

        // Disabled, not in effect, broader profile, more than one address.
        let status = run(json!({
            "program": program_rule(json!({ "enabled": "False", "active": false })),
            "port": port_rule(json!({ "profile": "Private, Public", "remoteAddress": ["LocalSubnet", "10.0.0.0/8"] })),
        }));
        assert_eq!(
            mismatches(&status.program),
            vec![FirewallField::Enabled, FirewallField::Active]
        );
        assert_eq!(
            mismatches(&status.port),
            vec![FirewallField::Profile, FirewallField::RemoteAddress]
        );

        // Shape mixed up: a program rule narrowed to a port, a port rule
        // narrowed to a program, UDP, outbound.
        let status = run(json!({
            "program": program_rule(json!({ "localPort": ["8721"], "direction": "Outbound" })),
            "port": port_rule(json!({ "program": EXE, "protocol": "UDP" })),
        }));
        assert_eq!(
            mismatches(&status.program),
            vec![FirewallField::Direction, FirewallField::LocalPort]
        );
        assert_eq!(
            mismatches(&status.port),
            vec![FirewallField::Protocol, FirewallField::Program]
        );
    }

    #[test]
    fn paths_compare_ignoring_case_and_lone_strings_are_lists() {
        let status = run(json!({
            "program": program_rule(json!({ "program": EXE.to_uppercase(), "remoteAddress": "LocalSubnet", "localPort": "Any" })),
            "port": port_rule(json!({ "localPort": "8721" })),
        }));
        assert_eq!(mismatches(&status.program), vec![]);
        assert_eq!(mismatches(&status.port), vec![]);
    }

    #[test]
    fn values_without_a_basis_are_unchecked_not_mismatched() {
        let status = evaluate(
            3,
            FirewallExpectation {
                executable_path: None,
                port: None,
            },
            Ok(json!({
                "program": program_rule(json!({ "active": null })),
                "port": port_rule(json!({})),
            })
            .to_string()),
        );
        match &status.program {
            FirewallRuleCheck::Present {
                mismatches,
                unchecked,
                ..
            } => {
                assert_eq!(mismatches, &vec![]);
                assert_eq!(
                    unchecked,
                    &vec![FirewallField::Program, FirewallField::Active]
                );
            }
            other => panic!("{other:?}"),
        }
        match &status.port {
            FirewallRuleCheck::Present { unchecked, .. } => {
                assert_eq!(unchecked, &vec![FirewallField::LocalPort]);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_response_serializes_as_codes_and_values() {
        let status = run(json!({
            "program": program_rule(json!({ "action": "Block" })),
            "port": { "s": "missing" },
            "group": 2,
        }));
        let value = serde_json::to_value(&status).unwrap();
        assert_eq!(value["generation"], 7);
        assert_eq!(value["expected"]["executablePath"], EXE);
        assert_eq!(value["expected"]["port"], 8721);
        assert_eq!(value["program"]["state"], "present");
        assert_eq!(value["program"]["mismatches"], json!(["action"]));
        assert_eq!(value["program"]["rule"]["localPorts"], json!(["Any"]));
        assert_eq!(
            value["program"]["rule"]["remoteAddresses"],
            json!(["LocalSubnet"])
        );
        assert_eq!(value["port"], json!({ "state": "missing" }));
        assert_eq!(value["groupOtherRules"], 2);
        let unknown =
            serde_json::to_value(evaluate(1, expected(), Err(UnknownReason::Timeout))).unwrap();
        assert_eq!(
            unknown["program"],
            json!({ "state": "unknown", "reason": "timeout" })
        );
        assert_eq!(unknown["groupOtherRules"], Value::Null);
    }

    /// Reads this PC's real firewall (read-only). Not run by default - CI is
    /// Linux and the result depends on the machine; run it by hand with
    /// `cargo test --lib firewall_status -- --ignored --nocapture`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn reads_the_real_firewall() {
        let names = rule_names("com.example.banto.probe-test").unwrap();
        let outcome = probe(&names);
        println!("{outcome:?}");
        let status = evaluate(0, expected(), outcome);
        println!("{status:?}");
        assert_eq!(status.program, FirewallRuleCheck::Missing);
        assert_eq!(status.port, FirewallRuleCheck::Missing);
        assert_eq!(status.group_other_rules, Some(0));
    }

    #[cfg(not(windows))]
    #[test]
    fn other_platforms_report_not_windows() {
        let names = rule_names("com.example.banto").unwrap();
        assert_eq!(probe(&names), Err(UnknownReason::NotWindows));
    }
}
