# Spec: Vellum → Cadet migration, built into the Cadet desktop app

The engine's own index says the endgame: *"the npx CLI and (later) the desktop
wrapper are thin shells over the same engine."* This spec is that wrapper.
v0.14.0 shipped the desktop app; the next milestone is the vellum user's
first-run moment: they install the Cadet desktop app on the machine where
Vellum already lives, and the app should meet them there — detect the old
install, show them what will move, and land them in their migrated assistant
without a terminal.

## 0. The engine already does the heavy lifting

Everything below leans on `@mycadet/vellum` (packages/core) as it exists:

| Engine export | Desktop use |
| --- | --- |
| `detectInstall()` → `DetectInfo` | silent background probe at boot: root, assistants, retired count, deployment kind, docker state, **running processes**, root size, existing manifest |
| `migrate({ confirm, processOps, … })` | the run itself; `confirm` is a **callback** — the desktop consent screen implements it instead of a CLI prompt |
| `StepItemEvent` | live progress stream for the run screen (one event per step, honest skipped/failed statuses) |
| `ProcessOps` | the host adapter — the app supplies its own implementations (see §3) instead of the CLI's |
| `migrateFromExport` + `validateStagedRoot` | the "I have a backup file" path (`.vbundle` / export tar) that works **without a vellum install or docker** — the mac/win story and the restored-machine story |
| `verify` + the manifest | re-runs are verify-only; the UI promise "re-running never double-migrates" is the engine's, not ours |
| `uninstall` module | the deferred "remove Vellum for good" affordance, DELETE-typed confirmation included |

The wrapper adds **zero migration logic**. Every UX decision below is
presentation and seam-filling.

## 1. The journey, end to end

**Land (silent).** Desktop app boots with an empty cadet state (no
assistants in the lockfile). The main process runs `detectInstall()` once,
off the boot path (it's fs probes + a docker call; ~free on machines
without vellum, and the negative result is cached for the session).

**Offer (first-run branch).** With a detected root, the onboarding funnel's
hosting step grows a third card above "hatch fresh":

> **Bring your Vellum assistant** — We found Vellum on this computer
> (N assistants, ~X GB, plus M retired archives). Import it and pick up
> where you left off.

The happy path (fresh hatch) stays the default for machines with no
vellum root — detection that finds nothing changes nothing.

**Consent (the `confirm` callback).** The plan screen renders
`ConfirmMigrationInfo` as two sentences and three facts:

1. **What sleeps:** the assistant names (running processes get a "Quit
   Vellum first" arm when `runningProcesses` is non-empty — see §4).
2. **What moves:** root size + docker volume bytes (the measured numbers;
   "size unknown" when the daemon is unreachable — the engine already
   reports that honestly).
3. **What it costs:** the assistants are unavailable during the copy
   (tens of GB), old signed tokens are revoked (browsers survive via
   refresh rotation; other clients re-pair), and cloud login happens
   through the app.

A disk-space preflight warning (`free < rootSizeBytes + volumeBytes ×
margin`) lives on this screen, not mid-run. Declining continues to the
normal fresh-hatch walk — no dark patterns, the offer just waits in
Settings (§5).

**Run (progress, not a modal).** The run executes in the **main process**.
The renderer gets `StepItemEvent`s over IPC and renders the engine's step
names as a checklist (detect → preflight → stop → copy → dbs →
credentials → lockfile → verify → login → wake), with the
`dockerVolumeToDir` `onProgress` byte counts as the one determinate
progress bar. The window closing does not kill the run (the engine's
detached-worker story, already proven by the CLI's `--internal-run`):
reopening the app mid-run reattaches to the log and shows the same
checklist. A "keep this window open" hint is honest, not load-bearing.

**Land.** `verify` completes → `wake-assistants` → the app re-reads the
lockfile. Because the protocol handler's config reads are already lazy
(#1020), the migrated assistant's identity appears without re-registering
anything. The user lands in chat with the migrated assistant — same name,
same workspace, same memories. A final card names the two things that
changed (tokens revoked; re-pair any third-party client) and offers —
deferred, dismissible — "Remove Vellum" (§6).

## 2. Where the app's own machinery replaces the CLI's

The `ProcessOps` the desktop app supplies — this is the whole integration:

| Op | Desktop implementation |
| --- | --- |
| `vellumVersion`, `vellumSleep`, `find` | shell out to the **discovered vellum install's** CLI (its bin path is known from the root discovery); `find` reads `/proc`-style process tables the same way the CLI's ops do |
| `cadetVersion` | the **app's embedded runtime version** — the migrated entries' image refs must match the version the app itself runs, not a globally-installed CLI's |
| `installCadet`, `bunInstallCadet`, `cadetBinAvailable` | **no-op / satisfied**: the app is the runtime; the npm-permission `retryInstallAsSudo` hook is never needed |
| `cadetLogin` | **satisfied from the app's session** when the user is already logged in (the app's cloud session IS the login the step wants); when not, the app routes the user through its own auth flow **before** the run starts — a mid-run browser dance is the one UX hole left in the CLI's flow and the desktop can close it |
| `cadetWakeAll`, `cadetSleep` | the app's own wake/sleep (local-mode), not a global CLI |
| `dockerVolumeToDir` / `dockerDirToVolume` | the app's existing docker access (the local-hosting arm already runs containers) |

Consequence: the desktop migration never needs `npm install -g`, never
needs the cadet CLI on PATH, and never prompts for a sudo password.

## 3. Platform reality

The engine's copy + volume steps are **ext4-only today**. The vellum
desktop deployment (`desktop` deploymentKind, `.vellum-assistant` marker)
ran beyond Linux. Phasing:

- **Phase 1 (this milestone): Linux.** Full in-app migration — the same
  machines the CLI serves today, minus the terminal.
- **Phase 2: everywhere, via the export contract.** `migrateFromExport`
  ingests a `.vbundle`/export tar with no vellum root, no docker, no
  ext4 — the app grows a **"I have a Vellum backup file"** picker on the
  same onboarding card (file chooser → `validateStagedRoot` → same
  consent → run with `stoppedByConstruction`). This also covers
  restored/new machines that kept only a backup.
- **Phase 3 (optional):** native mac/win direct migration if the engine's
  fs/volume steps ever grow non-ext4 arms — explicitly out of scope here.

On unsupported platforms the card doesn't hide; it shows the honest state:
*"Direct import is Linux-only today — import a Vellum backup file, or
finish this later on Linux."*

## 4. Edge cases the spec commits to

- **Vellum is running right now:** detection already lists the pids. The
  consent screen asks the user to quit the Vellum app and re-checks
  before enabling "Import"; the engine's `stop-assistant` step still runs
  as the backstop (sleeping assistants, never pattern-matching processes).
- **Cadet root already populated:** the confirm screen names it (the
  engine flags an existing cadet root at detect time); existing cadet
  files are preserved; the migrated assistant lands alongside in the
  picker.
- **Re-run / retry:** the manifest makes every re-run verify-only. The
  failure UI's only recovery button is "Try again" — safe by
  construction, so the run screen needs no cancel machinim. (Interrupting
  the process mid-step is recoverable by the same verify-only re-run.)
- **Ambiguous roots (multiple vellum installs):** the engine asks which
  root; the desktop renders the chooser as a step in the flow.
- **Encrypted bundles:** `.vbundle.enc` is refused with the keys-gone
  explanation — shown at picker time, before any staging.
- **Never silent:** detection is silent; migration never is. Tens of GB
  moved and assistants put to sleep only ever happen behind the consent
  screen — including when the app auto-updates into a build that has the
  feature.

## 5. Beyond first-run

The same machinery, mounted in Settings under **"Import from Vellum"**
(discoverable later, missed the prompt, or second machine): same detect →
consent → run → land flow, same backup-file picker. The boot detection
result caches so the settings entry renders instantly.

## 6. The uninstall nudge

Not in the migration flow. After the migrated assistant has been awake
and used for a while, a single dismissible card offers "Remove Vellum"
→ summary screen (what will be deleted, what is kept: the cadet side and
`~/.cadet-migration-backups`) → type-DELETE confirmation, the engine's
`uninstall` module verbatim. The vellum root stays read-only-untouched
until the user does this — the original IS the backup.

## 7. Open questions

1. **Engine dependency shape:** bundle `@mycadet/vellum` into the desktop
   app (versioned with it, offline, but every engine fix ships on an app
   release) vs. spawn the npx CLI (always current, but network-dependent
   and the processOps/IPC story gets harder). Leaning: bundle — the
   desktop milestone should not require npm at run time.
2. **Repo boundary:** the engine lives here (the only repo where vellum
   exists); the wrapper screens live in the desktop app. Does the
   `ProcessOps` implementation belong in a small `@mycadet/vellum-desktop`
   package here (tested against fixtures) with the electron IPC thin over
   it — or directly in the app? Leaning: the package here, so the ops are
   testable without Electron.
3. **Login pre-flight:** require cloud login BEFORE the run (cleaner
   progress bar, one less mid-run branch) or satisfy it lazily at the
   engine's cadet-login step? Leaning: pre-flight when the app has no
   session.
4. **Docker presence:** the desktop app's local arm requires docker — if
   it's missing, is the migration blocked (same as hatch) or does the
   consent screen offer install-then-continue? Leaning: same treatment
   hatch gets today, stated on the consent screen.
