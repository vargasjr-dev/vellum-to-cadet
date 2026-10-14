# vellum-to-cadet

Migrates a vellum assistant workspace to cadet. This is the only repo where
the word "vellum" is allowed to exist.

## Packages

| Package | Purpose |
| --- | --- |
| `@mycadet/vellum` | The engine: library + `migrate-vellum-assistant-to-cadet` bin |
| `migrate-vellum-assistant-to-cadet` | Unscoped npx alias for the engine |

## Usage

Self-hosters run npx directly:

```sh
npx migrate-vellum-assistant-to-cadet
```

The vellum root is **discovered automatically** from the legacy env overrides
(`VELLUM_DATA_DIR`, `VELLUM_WORKSPACE_DIR`), the default home location
(`~/.vellum`). A candidate only counts when it carries a marker only the
assistant creates. If more than
one plausible root is found, the CLI asks which one to migrate.

```sh
npx migrate-vellum-assistant-to-cadet --dry-run   # plan only, touches nothing
npx migrate-vellum-assistant-to-cadet --json      # machine-readable report
```

The CLI starts a logged worker and runs detection and preflight before
asking for confirmation. It lists the assistants it will put to sleep, the
host data and Docker volumes it will migrate, and the Cadet data root.
Press Enter to continue (`-y`/`--yes` skips the prompt). After confirmation,
the detached worker survives dropped SSH sessions; follow its log with
`tail -f ~/.cadet-migration-logs/<run>.log`.

Shared retired archives, backups, and upgrade logs are copied from the
Vellum XDG data root into the Cadet data root. CLI logs are copied from
`~/.config/vellum/logs` to `~/.config/cadet/logs`. Existing Cadet files are
preserved. Environment-specific roots and XDG overrides are respected.

The migration installs Cadet, establishes cloud login when needed, and
wakes the migrated assistants. Detached login prints a browser URL and
polls for approval for up to five minutes; a timeout warns and continues.
This requires a Cadet release and cloud platform with terminal login
polling support. CES security and metadata use separate `-ces-sec` and
`-ces-data` volumes; the metadata volume is ensured before wake.

Legacy `vellum-principal-…` guardian IDs become `principal-…`, with stored
identity references updated together. Old signed access tokens are revoked;
browser refresh credentials remain valid and rotate into the renamed identity.
Clients without a refresh credential must re-pair with the assistant. A
uniqueness collision preserves the original identity references and reports a
warning instead of partially renaming them.

Once you've confirmed your Cadet is online, you can optionally delete
Vellum for good with `npx migrate-vellum-assistant-to-cadet uninstall`.

## Guarantees

- The vellum root is a **read-only source of truth**: nothing in it is ever
  modified or deleted by this tool — the original IS the backup, so no
  separate backup copy is made.
- The user-facing workspace is migrated byte-for-byte **except one
  sanctioned sweep**: files that reference `VELLUM_WORKSPACE_DIR` get that
  single token rewritten to `CADET_WORKSPACE_DIR` (other `VELLUM_*` vars and
  vellum prose are never touched — a workspace script's other bugs are its
  own). The CES credential index additionally drops legacy product-service
  placeholder entries, and the legacy `platform` section lands as cadet's
  `cloud` section with `baseUrl` pointed at `https://cloud.mycadet.ai`.
- `.cadet-migration-manifest.json` in the cadet root records what happened and
  makes re-runs verify-only.
- Running vellum assistant processes are put to sleep automatically (via
  `vellum sleep`) before the migration starts.

## Uninstalling vellum

After your cadet assistant is confirmed and you want vellum gone for good:

```sh
npx migrate-vellum-assistant-to-cadet uninstall --dry-run   # list, delete nothing
npx migrate-vellum-assistant-to-cadet uninstall
```

Uninstall first asks the vellum CLI to put running assistants to sleep
(`vellum sleep` — the CLI's own command; uninstall never pattern-matches
processes, since guessing at what "belongs" to vellum is how unrelated
processes die). It sweeps every vellum location on the machine — the
legacy home root, the modern XDG data roots (including env-suffixed
siblings like `vellum-dev`), the XDG config dirs, and the old home-level
lockfiles — and removes the migrator's own npx cache. It demands the word `DELETE` be
typed (`--yes` for non-interactive runs) and prints a full warning: the
deletion is irreversible and the data is unrecoverable. The cadet side is
never touched — the cadet assistant and the migration backups in
`~/.cadet-migration-backups` are kept (delete those by hand if you're
truly done with them).

## Releasing

`.github/workflows/release.yml` is dispatch-only and invocable by
@dvargasfuertes: it checks out the target branch, typechecks + tests, bumps
both package versions in lockstep, publishes to npm (trusted publishing via
OIDC), tags, and merges the branch into main. Rehearse with `dry-run: true`.

## Development

```sh
npm install
npm run typecheck   # both packages, src + tests
npm test            # node:test; fixtures build synthetic vellum 0.12.6 trees
npm run build       # dist for packages/core
```

### Docker credential-store permissions

The CES security volume is imported with ownership `1001:1001`, matching the
Cadet credential-executor container. Its files remain owner-only readable and
writable. The host account used to run migration does not become the owner of
the imported credential store. An ownership or permission failure aborts the
volume import before wake.

For an already migrated installation reporting a reachable CES health endpoint
but HTTP 500 from `/v1/credentials`, inspect ownership of `keys.enc` and
`store.key` in the credential-executor container. Host-owned mode-600 files
must be reassigned to CES, preserving both file contents and the existing key.
