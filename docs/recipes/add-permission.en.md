# Recipe: Add a per-user permission (`equipment.operate` style)

> The Japanese [`add-permission.md`](add-permission.md) is the source of truth; this English version follows it. If they diverge, the Japanese wins.

Created: 2026-11-19 (Issue #697 PR-3; a sibling of [add-role.md](add-role.en.md).
Design: [design/user-permissions-plan.md](../design/user-permissions-plan.md);
decision: [ADR-0031](../adr/0031-user-permissions-separate-axis.en.md)).

Intended reader: **developers and AI agents of the consuming app (Track A)**. Use
this when you need a permission the role ladder (`viewer < editor < admin`)
cannot express, such as separating "people who fix settings" from "people who
operate". **The banto template registers no permission at all** (the catalog is
empty and the admin screen shows no permission field). The vocabulary is added by
the consuming app.

## Prerequisite: add a role, or add a permission?

| Look at  | Role ([add-role.md](add-role.en.md))                | Permission (this recipe)                                                                       |
| -------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Order    | Total order; a higher step includes the lower ones  | Independent; ignores other permissions and the role step                                       |
| Granting | One per user                                        | Any number per user; a Viewer may hold one, an Admin does not unless granted                   |
| Check    | `RoleGuard`, `require_role` (`at_least`)            | `PermissionGuard`, `require_permission`, `has_permission`                                      |
| Impact   | Every path's floor, the CHECK constraint, picker UI | Only where the permission is checked; the `user_permissions` table and admin screen are shared |

- If "a higher step can do everything a lower one can", add a **role**.
- If any of "even an Admin does not have it by default", "a Viewer may hold it",
  or "it does not fit between editor and admin" applies, add a **permission**.
  Adding a role would let the steps above it do it automatically. For example
  "can only read the audit log" fits neither above nor below editor, so a
  permission is the natural fit.
- When unsure, choose a permission. Every role you add affects every path.

## Checklist (in order)

| #   | Step                                                                                                                                                                                                                                                                                                                                                                                                                                           | Where                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | Choose the key. Format `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$` (two or more segments, up to 64 bytes). Example `equipment.operate`                                                                                                                                                                                                                                                                                                             | -                                                          |
| 2   | **Register it in the catalog**: `PermissionCatalog::empty().register("equipment.operate", "perm.equipment_operate", "perm.equipment_operate_desc")?`. `admin_template_core::permission_catalog()` is the **only place that builds it**; both banto-serve (REST) and Tauri call it. A malformed or duplicate key fails at startup (never silently dropped)                                                                                      | `apps/admin-template/core/src/lib.rs`                      |
| 3   | **Display name and description i18n**: add the message keys from step 2 (`perm.equipment_operate`, `perm.equipment_operate_desc`) to `messages/{ja,en}.json`. The admin screen looks them up and falls back to the key itself (no description)                                                                                                                                                                                                 | `apps/admin-template/messages/{ja,en}.json`                |
| 4   | **Server-side check** (REST and Tauri symmetric, conventions §1): see "How to place the check" below                                                                                                                                                                                                                                                                                                                                           | routes using `crates/banto-server`; `src-tauri/src/lib.rs` |
| 5   | **Granting and revoking**: the user edit panel shows a checkbox per registered permission (hidden entirely when the catalog is empty). Admin only. REST: `permissions` in `PUT /api/users/{id}`; Tauri: `permissions` in `users_update`. Omitting it changes nothing. Each change bumps `version`, so a clash with another Admin's edit is a 409. Permissions are **not** granted at creation time (grant them from the edit panel afterwards) | no screen change needed (driven by the catalog)            |
| 6   | To give permissions to **no-login mode**, pick them in Settings > Security below "startup role" (`auth.disabledPermissions`; shown only when the app registers permissions; default none). Sent as `permissions` of Tauri `auth_config_apply`. Desktop-only entry; there is no REST entry                                                                                                                                                      | settings screen (no change needed)                         |
| 7   | **Frontend gating**: use `sessionStore.hasPermission(key)` (the session's `permissions`) to show or disable buttons. **Hiding is cosmetic only**; the decision is the server-side check from step 4                                                                                                                                                                                                                                            | your screens                                               |
| 8   | **Tests**: a holder passes; a non-holder (including an Admin) gets 403 `forbidden` plus a `denied` audit row, on both REST and Tauri                                                                                                                                                                                                                                                                                                           | `apps/admin-template/core/src/rest/tests.rs` etc.          |

### How to place the check (step 4)

- **Per route or command**:
  - REST: stack `middleware::from_fn_with_state(PermissionGuard { auth, permission, resource, audit }, require_permission)`
    after `require_auth`. Build `permission` with `PermissionKey::parse("equipment.operate")`.
    A refusal is 403 `forbidden` plus a `denied` audit row (same shape as a role refusal).
  - Tauri: call `require_permission(state, &permission, resource).await?` next to `require_role`
    (both are `async fn`).
    A refusal is `BantoError::Forbidden` plus a `denied` audit row. It reads the DB on
    every command, so a revoked permission stops working at the next command.
  - To require both, also apply `RoleGuard` / `require_role` (a permission never looks at the role).
- **Finer than a route** (e.g. per piece of equipment):
  - REST: the handler takes `Extension<SessionPermissions>` and calls `has(&PermissionKey)`
    (the `has_permission` check).
  - Tauri: read with `session_permissions(state).await?`. It returns
    `Option<(UserIdentity, SessionPermissions)>`; `None` means unauthenticated, so refuse it,
    then take the permissions out of the tuple and check with `has`:

    ```rust
    let Some((_identity, held)) = session_permissions(state).await? else {
        return Err(BantoError::Unauthorized);
    };
    if !held.has(&permission) {
        return Err(BantoError::Forbidden);
    }
    ```

    This form does not write a `denied` audit row by itself. If the refusal must be audited,
    use the route-level `require_permission`, or record it yourself as role refusals do.
- Viewer-public (grant) sessions **never hold permissions**. No-login mode holds only
  what is in `auth.disabledPermissions`.
- A key not in the catalog is treated as **held by nobody** (even if a row remains; the
  admin screen shows it as "unregistered" and lets you remove it). Guarding with a key
  you forgot to register refuses everyone.
- Permissions are read from the DB on each request, so a revoked one stops working at
  the next request (no session reissue needed).

## What lands in the audit log

- Grant/revoke: the user-update audit row (`action: "update"`, `resource: "users"`)
  carries `{ field: "permissions", added: [...], removed: [...] }` in `changes`,
  alongside role changes. The audit screen shows it as "added / removed".
- Refusals: a permission refusal is `denied` (same shape as a role refusal).
- No-login-mode permission changes: the `settings_change` detail gets
  `authDisabledPermissions: { added, removed }` only when it changed.
- An Admin granting a permission to themselves is **not forbidden** (it is audited;
  small sites often have a single Admin).

## Out of scope

- **Per-equipment or per-screen assignment** (granting `equipment.operate` for equipment A
  only). If needed, the consuming app checks its own table in addition to `has_permission`.
- Permission **expiry**.
- Permission **groups** (bundles like roles).
- Granting at creation time (`POST /api/users` and `users_create` are unchanged).

## Verification

```bash
pnpm check                 # frontend lint/types/i18n
pnpm verify:architecture   # rule 8: permission guard pairs (PERMISSION_PAIRS)
cargo test                 # check and audit tests
```

`src-tauri` may not compile in the sandbox (AGENTS.md). In that case, cover the Tauri
side of step 4 with code review and the weekly Tauri CI, and list it as an unrun verification.

## Do not

- Put the check on one path only (conventions §1), or protect only by hiding UI.
- Use a permission as a stand-in for a role so that "a higher step can do it all" (that is a role).
- Add fields to banto's public structs (`Identity`, `UserIdentity`, ...) to carry
  permissions around (a breaking change; permissions travel in the separate `SessionPermissions` type).
- Use a key without registering it in the catalog (nobody can hold it, so everyone is refused).
