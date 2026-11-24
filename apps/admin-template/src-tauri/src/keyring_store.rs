//! OS keyring storage for the desktop auto-login credential (spec M11).
//!
//! Deliberately its own tiny module rather than inline in `lib.rs`: this is
//! the one piece of `src-tauri` that talks to `keyring` directly, and
//! keeping it a thin, uniformly-erroring wrapper makes the "keyring backend
//! unavailable" degrade path (spec M11: "keyring 不在環境（一部Linux）で機能
//! が安全に degrade する") a single place to reason about instead of
//! scattered `keyring::Error` matches through the command handlers below.
//!
//! The credential is looked up by `(service, account)` where `service` is
//! fixed for this app and `account` is the account's `username` - the same
//! convention `keyring`'s own examples use, and one `Entry` per username
//! means a future "switch which account autologs in" never collides with a
//! previously-configured one still sitting in the OS store under its own
//! username.

use banto_core::BantoError;

/// Keyring service name for every credential this app stores. Not derived
/// from `CARGO_PKG_NAME` at runtime on purpose: renaming the crate later must
/// not silently orphan credentials users already saved in their OS keyring.
///
/// This is the template's shipped default; `scripts/rename.mjs` rewrites it to
/// the app's `--identifier` on the initial template→app rename so that
/// multiple Banto-derived apps on the same OS user get separate keyring
/// namespaces instead of colliding on one `(service, account)` (issue #147).
const SERVICE_NAME: &str = "dev.banto.admin-template";

/// Turns any `keyring::Error` (backend missing, permission denied, no entry
/// found, ...) into a `BantoError::Other` with a Japanese message, so callers
/// never need to know `keyring`'s error type - this is the "safe degrade"
/// spec M11 asks for when a platform has no usable keyring backend (e.g. some
/// headless Linux setups without a secret-service provider).
fn degrade(context: &str, err: keyring::Error) -> BantoError {
    BantoError::Other(format!("{context}: {err}"))
}

fn entry(username: &str) -> Result<keyring::Entry, BantoError> {
    keyring::Entry::new(SERVICE_NAME, username)
        .map_err(|err| degrade("OSキーリングへのアクセスに失敗しました", err))
}

/// Store `password` in the OS keyring under `username`, overwriting any
/// existing entry for that username.
pub fn set_password(username: &str, password: &str) -> Result<(), BantoError> {
    #[cfg(test)]
    if let Some(result) = fake::set(username, password) {
        return result;
    }
    entry(username)?
        .set_password(password)
        .map_err(|err| degrade("OSキーリングへの資格情報の保存に失敗しました", err))
}

/// Retrieve the password previously stored for `username`, or an error if
/// there is none (or the backend is unavailable).
pub fn get_password(username: &str) -> Result<String, BantoError> {
    #[cfg(test)]
    if let Some(result) = fake::get(username) {
        return result;
    }
    entry(username)?
        .get_password()
        .map_err(|err| degrade("OSキーリングからの資格情報の取得に失敗しました", err))
}

/// Remove the stored credential for `username`. Idempotent-ish in intent
/// (callers here treat "already gone"/backend errors as best-effort - see
/// `autologin_disable` in `lib.rs`, which logs and proceeds rather than
/// failing the whole command on a keyring delete error).
pub fn delete_password(username: &str) -> Result<(), BantoError> {
    #[cfg(test)]
    if let Some(result) = fake::delete(username) {
        return result;
    }
    entry(username)?
        .delete_credential()
        .map_err(|err| degrade("OSキーリングからの資格情報の削除に失敗しました", err))
}

/// Test-only seam: a per-thread fake store that tests can read back and make
/// fail. `keyring`'s own mock gives every `Entry` a private value, so a test
/// cannot see whether a credential was stored or removed through it. Off
/// (None) unless a test calls [`fake::install`]; tokio tests run on one
/// thread, so a thread-local is isolated per test.
#[cfg(test)]
pub(crate) mod fake {
    use banto_core::BantoError;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Fake {
        entries: HashMap<String, String>,
        fail_delete: bool,
        on_delete: Option<Box<dyn Fn()>>,
    }

    thread_local! {
        static FAKE: RefCell<Option<Fake>> = const { RefCell::new(None) };
    }

    pub(crate) fn install() {
        FAKE.with(|f| *f.borrow_mut() = Some(Fake::default()));
    }

    pub(crate) fn fail_delete(on: bool) {
        FAKE.with(|f| f.borrow_mut().as_mut().expect("installed").fail_delete = on);
    }

    /// Runs `hook` at every delete (before it applies).
    pub(crate) fn on_delete(hook: impl Fn() + 'static) {
        FAKE.with(|f| f.borrow_mut().as_mut().expect("installed").on_delete = Some(Box::new(hook)));
    }

    pub(crate) fn stored(username: &str) -> Option<String> {
        FAKE.with(|f| {
            f.borrow()
                .as_ref()
                .and_then(|f| f.entries.get(username).cloned())
        })
    }

    pub(super) fn set(username: &str, password: &str) -> Option<Result<(), BantoError>> {
        FAKE.with(|f| {
            f.borrow_mut().as_mut().map(|f| {
                f.entries.insert(username.to_string(), password.to_string());
                Ok(())
            })
        })
    }

    pub(super) fn get(username: &str) -> Option<Result<String, BantoError>> {
        FAKE.with(|f| {
            f.borrow().as_ref().map(|f| {
                f.entries
                    .get(username)
                    .cloned()
                    .ok_or_else(|| BantoError::Other("no entry".to_string()))
            })
        })
    }

    pub(super) fn delete(username: &str) -> Option<Result<(), BantoError>> {
        FAKE.with(|f| {
            f.borrow_mut().as_mut().map(|f| {
                if let Some(hook) = &f.on_delete {
                    hook();
                }
                if f.fail_delete {
                    return Err(BantoError::Other("delete failed".to_string()));
                }
                f.entries.remove(username);
                Ok(())
            })
        })
    }
}
