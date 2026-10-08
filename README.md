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
(`~/.vellum`), and the docker volume convention (`/data/.vellum`). A candidate
only counts when it carries a marker only the assistant creates. If more than
one plausible root is found, you pick one interactively; in non-interactive
runs the tool exits with code 9 and lists the candidates.

```sh
npx migrate-vellum-assistant-to-cadet --dry-run   # plan only, touches nothing
npx migrate-vellum-assistant-to-cadet --json      # machine-readable report
npx migrate-vellum-assistant-to-cadet --vellum-root /path/to/.vellum  # override discovery
```

On success the CLI prints a colorful summary plus **optional next steps**
(install and launch cadet, and — only once you've confirmed your data —
`rm -rf` the old root by hand).

## Guarantees

- The vellum root is a **read-only source of truth**: nothing in it is ever
  modified or deleted by this tool.
- A timestamped full backup with a sha256 manifest is written to
  `~/.cadet-migration-backups/<timestamp>` (cadet side) before any migration.
- `.cadet-migration-manifest.json` in the cadet root records what happened and
  makes re-runs verify-only.
- Running vellum assistant processes are stopped automatically before the
  migration; if one refuses to die, the run fails loudly with exit code 4.

## Releasing

`.github/workflows/release.yml` is dispatch-only and invocable by
@dvargasfuertes: it checks out the target branch, typechecks + tests, bumps
both package versions in lockstep, publishes to npm (trusted publishing via
OIDC), tags, and merges the branch into main. Rehearse with `dry-run: true`.

## Development

```sh
bun install
bun run typecheck   # both packages
bun test            # fixtures build synthetic vellum 0.12.6 trees
bun run build       # plain-node-compatible dist for packages/core
```
