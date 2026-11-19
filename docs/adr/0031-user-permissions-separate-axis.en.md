# ADR-0031: Keep per-user permissions as an axis separate from roles

> 日本語: [0031-user-permissions-separate-axis.md](0031-user-permissions-separate-axis.md)

- Status: Accepted (2026-11-19)
- Date: 2026-11-19
- Related: Issue #697 / [design/user-permissions-plan](../design/user-permissions-plan.md) /
  implementation PRs #701 (PR-1 server), #702 (PR-2a admin screen), #703 (PR-2b no-login mode) /
  conventions §1, §2, §6, §11 / [recipes/add-permission](../recipes/add-permission.en.md) /
  [recipes/add-role](../recipes/add-role.en.md) / [ADR-0014](0014-account-bound-session-revocation.en.md) /
  [ADR-0017](0017-credential-less-grant.en.md)

## Context

banto-industrial's SCADA (temp-scada) must separate "people who fix settings" from
"people who operate". It needs the permissions `equipment.operate` (operate equipment) and
`alarm.ack` (acknowledge alarms), and **even an Admin does not hold them by default**.
Admins grant and revoke them, and the change is audited.

banto's roles are the total order `Role { Viewer < Editor < Admin }`, checked with `at_least`
(REST `RoleGuard`, Tauri `require_role`). Adding a step would let the steps above it operate
automatically, so "an Admin cannot operate" is inexpressible. Adding a role also touches the
`Role` enum, the DB CHECK constraint, both paths' floors, and the picker UI
([add-role](../recipes/add-role.en.md)). A permission like `equipment.operate` is a
consuming-app vocabulary that grows per facility and operation, and does not belong in a
generic template.

## Decision

Keep per-user permissions as an axis **independent of roles**. Details are decisions 1-8 of
[plan §8](../design/user-permissions-plan.md).

1. **The name is permission** (Rust `Permission`-family types, TS `UserPermission`, table
   `user_permissions`). "capability" is already used for resource operation rights (ADR-0030,
   `lib/resource/permissions.ts`) and dock-svelte pane capabilities.
2. **The consuming app registers the vocabulary in a catalog** (`PermissionCatalog`; one function,
   `admin_template_core::permission_catalog()`, shared by banto-serve and Tauri). The banto
   template registers nothing (no field is shown). banto-industrial registers `equipment.operate`
   and `alarm.ack`.
3. **Audit rides on the existing `update`.** A grant/revoke is `{ field: "permissions", added, removed }`
   in the user update's `changes`, not a separate action. Refusals are `denied`.
4. **No-login mode holds no permissions by default.** Grant them with `auth.disabledPermissions`
   (next to `disabled_role`). Viewer-public (grant) sessions never hold permissions.
5. **An Admin may grant to themselves** (audited; small sites often have one Admin).
6. **Grant/revoke rides on user update** (`permissions?` of `PUT /api/users/{id}` and Tauri
   `users_update`; omitted = unchanged; the `users.version` optimistic lock applies). No dedicated entry.
7. **Do not add fields to public structs** (`Identity`, `UserIdentity`, ...). Permissions travel in
   a separate type `SessionPermissions`: a request extension on REST, read from the DB per call on
   Tauri. Adding `permissions` to the session response JSON is an additive field and not breaking.
8. **Do not grant at user creation.** Grant from the edit panel afterwards (`POST /api/users` and
   `users_create` are unchanged).

A check **ignores the role step** (a Viewer may hold one; an Admin does not unless granted). It is
enforced server-side (`PermissionGuard`, `require_permission`, `has_permission`), symmetric across both
paths, and read from the DB on every request (the same route as ADR-0014 / Issue #204), so a revoked
permission stops working at the next request (`auth_epoch` is not bumped). A key missing from the
catalog is treated as not held. Data lives in migration 0013 (`user_permissions`, both dialects).

## Alternatives considered

| Alternative                                            | Why rejected                                                                                                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a role (e.g. `operator`)                           | A total order lets higher steps operate automatically; "an Admin cannot operate" is inexpressible, and non-total orders do not fit the model (add-role's prerequisite) |
| Make `Role` a non-total order (a set)                  | A breaking change rippling into every path's floor, the CHECK constraint, and 42 struct-literal sites; too large for the gain                                          |
| banto ships `equipment.operate` / `alarm.ack` built in | SCADA terms enter a generic template; vocabularies differ per consuming app                                                                                            |
| Store a JSON array in a users column                   | Cannot answer "who holds `alarm.ack`"; imports the JSON differences between the two dialects                                                                           |
| Add `permissions` to `Identity` / `UserIdentity`       | All fields are pub and built as struct literals at 42 in-repo sites and by consumers; adding one stops them compiling and forces a major                               |
| Carry permissions in the session (token)               | A revoke would not reach issued sessions; would need `auth_epoch` bumps to sign everyone out                                                                           |
| A dedicated `PUT /api/users/{id}/permissions`          | More entries, and the `version` lock and audit must be matched separately; riding on user update suffices                                                              |
| The name "capability"                                  | Collides with the two existing uses                                                                                                                                    |

## Consequences

- **The release is minor.** No existing public type or function signature changed; only additions
  (new types such as `SessionPermissions`, additive JSON fields,
  `SettingsService::set_auth_config_and_disabled_permissions`). Derived apps that build structs by
  literal still compile.
- Consuming apps register in the catalog, add the message keys, and place checks following
  [add-permission](../recipes/add-permission.en.md). The role-or-permission decision is written
  cross-referenced in add-role and add-permission.
- Migration 0013 is added (forward-only; [upgrading](../upgrading.md) §4). `user_permissions` rows go
  with their user (`ON DELETE CASCADE`).
- `verify:architecture` rule 8 now covers permission guard pairs (`PERMISSION_PAIRS`);
  `permissions_catalog` <-> `GET /api/permissions` is registered.
- The no-login-mode permission entry (`auth.disabledPermissions`) is desktop-only (no REST entry).
- Out of scope: per-equipment or per-screen assignment (the app checks its own table), expiry, groups.
  Handle them in a separate ADR when needed.
