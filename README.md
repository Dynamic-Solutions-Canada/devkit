# devkit

devkit is the shared local development tooling for the web apps. It gives each Git checkout and worktree its own `*.localhost` hostname, application port, database container, and database volume, so several branches of one app, and several apps, run side by side on one machine. The editor stays on the host; project processes run in containers that mount the source tree. Apps install it as a dev dependency pinned to a git tag; it is never a runtime or production dependency.

```text
printstream        -> http://printstream.localhost
worktree fix-123   -> http://fix-123.printstream.localhost
game-is-up         -> http://game-is-up.localhost
```

By default, the only machine-wide service is Traefik on loopback port 80. It starts when the first routed project starts and is removed when the last route closes, allowing Docker Desktop to idle. Checkout stacks do not share Docker networks or databases. Inactive stacks keep only their named volumes.

## Add devkit to an app

Requires Node 22.12 or later on the 22 or 24 line. devkit is developed on the Node version in `.nvmrc`, but `engines.node` stays a range so apps still on Node 22 can install it with `engine-strict=true`. This is a deliberate, temporary exception to the exact-pin rule for a shared library; the range narrows to the exact fleet version once every app has moved to it.

```bash
npm install --save-dev github:Dynamic-Solutions-Canada/devkit#vX.Y.Z
npx devkit bootstrap
```

Replace `vX.Y.Z` with the latest release tag. Apps pin a tag, never a branch, so every change reaches them only through a pin bump.

Bootstrap installs the proxy and database Compose definitions under `~/.config/devkit` and writes the marker that enables Devkit. Devkit stays off inside containers, when `DEVKIT=0`, or before bootstrap. An app then opts in with a `devkit.config.mjs` and by calling `preflight()` from its dev runner, both described below.

### Project configuration

`devkit.config.mjs` contains only what cannot be derived from the checkout path:

```js
export default {
  ports: ['web'],
  database: {
    engine: 'postgres',
    version: '16-bookworm',
    name: 'my_app',
    // Opt in only when host-side tools need the checkout database.
    hostAccess: true,
  },
  migrationsTable: '_prisma_migrations',
  baselinePaths: ['data/uploads'],
  worktreeFiles: ['.env'],
  install: {
    command: ['npm', 'ci'],
    inputs: ['package.json', 'package-lock.json', '.nvmrc'],
    output: 'node_modules',
  },
  dependencies: [{ name: 'public-api', healthPath: '/api/_health' }],
  browser: { path: '/', healthPath: '/_health' },
  env: ({ database, url }) => ({
    CLIENT_ORIGIN: url,
    DATABASE_URL: database.url,
    VITE_DEV_PORT: '5173',
  }),
}
```

Application processes use fixed internal ports. The browser-facing port is published to the checkout-specific host port. `database.hostAccess` additionally publishes the database on a derived `127.0.0.1` port for host-side migration and validation tools; it is never exposed on the LAN.

### The dev runner

The host runner combines the Devkit database definition with the project's `compose.dev.yml`:

```js
import path from 'node:path'
import {
  checkoutCompose,
  checkoutComposeLifecycle,
  preflight,
} from '@dynamic-solutions-canada/devkit'

const teardown = process.argv.includes('--down')
const state = await preflight({ repoRoot, teardown })
const invocation = checkoutCompose(state, {
  projectDirectory: repoRoot,
  files: [path.join(repoRoot, 'compose.dev.yml')],
  env: {
    DEVKIT_WEB_PORT: String(state.ports.web),
    HOST_UID: String(process.getuid?.() ?? 1000),
    HOST_GID: String(process.getgid?.() ?? 1000),
  },
})
const lifecycle = checkoutComposeLifecycle(state, invocation)

if (teardown) process.exit(lifecycle.stop())
process.exit(await lifecycle.run(['up', '--remove-orphans']))
```

The lifecycle relays termination signals, removes the route, tears down the whole checkout stack, and removes the shared proxy after the final route closes. Named volumes are preserved. Pass `profiles` when profiled services also belong to the stack. Pass `teardown: true` to preflight for a `down` path so stopping a checkout does not start it first. Routes carry their runner's process identity, so the next lifecycle operation removes stale routes left by an abrupt process exit.

Only one development runner can own a checkout at a time. A second start fails before changing dependencies, containers, or routes; other worktrees still run independently. A killed runner's lease is recovered on the next start.

To leave development running after the terminal closes, pass `--background`:

```bash
npm run dev -- --background
npm run dev -- --down
```

Background mode detaches the same Node runner, keeps its arguments and environment, and writes its output to a log file (see [Logs](#logs)). The starting command reports the runner PID and log path after preflight succeeds; application readiness still depends on the project's startup and health checks. Startup failures return an error pointing to that log. `--down` gracefully stops the existing runner before tearing down its stack. Runners must forward that choice with `preflight({ repoRoot, teardown: true })` if arguments are consumed in another process; preflight recognizes `--down` in its own process automatically. Background mode can also be requested with `preflight({ repoRoot, background: true })`; it exits the invoking process after the child finishes preflight. It requires a Node file entry point and cannot be combined with teardown. Devkit's off switch still takes precedence over these options.

Starting development leaves the browser alone by default, even when `browser` is configured. Pass `--open` to the project's dev runner to request opening after its health check succeeds:

```bash
npm run dev -- --open
npm run dev -- --open=native
npm run dev -- --open=vscode
```

`--open` chooses the VS Code integrated browser when its window-scoped bridge is available, otherwise the operating system browser. An explicit `--open=vscode` reports an unavailable bridge instead of opening another browser. Existing VS Code terminals must be relaunched after the bundled bridge is installed or updated.

Preflight reads these arguments from its own process. Runners that consume arguments in another process must forward the choice as `preflight({ repoRoot, openBrowser: true })`, or use `openBrowser: 'native'` or `'vscode'`. Pass `false` to suppress opening for a particular call. `DEVKIT_OPEN_BROWSER=1` (or `native`/`vscode`) also opts in when a runner cannot forward arguments; command-line options take precedence. `DEVKIT_OPEN_BROWSER=0` leaves opening disabled.

### Generated dev files

`devkit-init` writes the dev glue every app would otherwise copy by hand, and keeps it current:

| Output                                   | What devkit owns                                                                                                                                                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/dev/run-dev.mjs`                | The whole file. Do not edit it.                                                                                                                                                                                                    |
| `package.json`                           | Exactly `dev` and the lifecycle scripts `dev:background`, `dev:down`, `dev:cleanup`, `dev:doctor`, `dev:bootstrap`, `dev:host` and `dev:prepare-worktree`. Every other script stays the app's.                                     |
| `paseo.json`                             | `worktree.setup`, `worktree.teardown`, and one script entry for each of `dev`, `dev:background`, `dev:down`, `dev:prepare-worktree`, `dev:doctor`, `validate`, `test` and `build` that the app defines. Other keys stay the app's. |
| `scripts/deploy/deploy-over-ssh.mjs`     | The whole file, and the `deploy:prod` script that runs it. See [Deploying](#deploying).                                                                                                                                            |
| `scripts/hooks/generated-file-guard.mjs` | The whole file, and its one `PreToolUse` registration in `.claude/settings.json`. See [Guarding generated files](#guarding-generated-files).                                                                                       |
| `compose.dev.yml`                        | Nothing after the first write. It is created with a `node` service only when missing, and its environment list is the app's to complete.                                                                                           |

The runner is the same in every app. On the host it does what [The dev runner](#the-dev-runner) shows; inside the container it runs the app's own `dev:container` npm script, which prepares the database and starts the dev servers (it sees `DEVKIT_FRESH=1` after `npm run dev -- --fresh`). Stop signals reach that script. `devkit-init` warns when `dev:container` is missing.

The same pattern covers worktree setup: the owned `dev:prepare-worktree` runs `devkit prepare` and then the app's `dev:postprepare` script if it has one, for steps such as generating a database client or building a shared package. Put app steps there rather than editing `dev:prepare-worktree`.

Run `npm exec devkit-init` after adding devkit and after every pin bump, and commit what it changes. Add `"check:devkit": "devkit-init --check"` to the app's `validate`: it writes nothing and fails when a generated file is out of date or was edited. JSON files are compared by value, so a formatter may lay them out differently.

An app that needs its own version of an output opts out in `devkit.config.mjs`, and the check then ignores it:

```js
export default {
  // A hand-written runner also keeps its own `dev` script and compose file.
  generated: { runner: false },
}
```

`generated` takes `runner`, `paseo`, `scripts`, `deploy` and `guard`, each `true` by default. Like `devkit-test`, `devkit-init` needs no bootstrapped machine and runs on the Node that started it.

### Deploying

The generated `scripts/deploy/deploy-over-ssh.mjs` deploys the current commit to a server that holds a checkout of the app and runs it with Docker Compose. It imports nothing from devkit: devkit supplies the script and takes no part in a deploy. `npm run deploy:prod` runs it, loading `.env` when there is one.

It refuses to start unless the local tree is clean and `HEAD` is a freshly fetched `origin/main`, then runs `npm run validate` (`--skip-validate` skips it). On the server, in order, it:

1. refuses a checkout with tracked changes;
2. dumps the database from its container (`pg_dump`, or `mariadb-dump` when `database.engine` is `mariadb`), and stops unless the gzip file is intact and ends with the dump's completion line. An incomplete dump is deleted. The newest `backupsKept` dumps are kept. `--skip-backup` or `DEPLOY_BACKUP=0` skips this only when a dump exists another way. A first deploy with no database container has nothing to dump;
3. fast-forwards the checkout to `main`, and stops unless it landed on the commit validated locally;
4. runs `docker compose up --build -d --wait`, and stops with the status and recent logs if a service is not healthy in time;
5. installs the nginx site file if it changed: the previous file is copied to `site-backups/` beside the sites folder, the new one must pass `nginx -t`, and nginx reloads gracefully. A failed test puts the previous file back and fails the deploy;
6. prunes dangling images (`--no-prune` or `DEPLOY_PRUNE=0` skips it).

`--dry-run` runs the local refusals and prints the server script without running anything.

The server comes from the environment, usually the app's untracked `.env`:

| Variable                 | Default                              |
| ------------------------ | ------------------------------------ |
| `DEPLOY_SSH_HOST`        | required                             |
| `DEPLOY_SSH_PORT`        | `22`                                 |
| `DEPLOY_REPO_PATH`       | required: the checkout on the server |
| `DEPLOY_BACKUP_DIR`      | `.backups`, in the server checkout   |
| `DEPLOY_NGINX_SITES_DIR` | `/home/apps/nginx/conf.d`            |
| `DEPLOY_NGINX_CONTAINER` | `nginx`                              |

What belongs to the app goes in `devkit.config.mjs`, all optional:

```js
export default {
  deploy: {
    databaseService: 'db', // the production database service
    composeFiles: ['compose.server.yml'], // compose.override.yml is added when the server has one
    backupsKept: 10,
    site: { source: 'nginx.server.conf', name: 'my-app.conf' }, // name defaults to <package name>.conf; null for no site
    healthWaitSeconds: 300,
  },
}
```

An app that keeps its own deploy script sets `generated: { deploy: false }`.

### Guarding generated files

The generated `scripts/hooks/generated-file-guard.mjs` is a Claude Code `PreToolUse` hook that refuses an agent's edit to a generated file and tells it to change the generator and regenerate instead. A file counts as generated when its header says so (for example "Generated by devkit. Do not edit", which every file `devkit-init` writes carries) or when it sits under a folder listed in `scripts/hooks/generated-file-guard.json`:

```json
{ "generatedDirectories": ["apps/mobile/android"] }
```

That JSON file is the app's, and so is `scripts/hooks/README.md`, which says what each hook blocks. `devkit-init` owns only the script and its registration in `.claude/settings.json`; other settings and hooks there are kept. Shell commands, including the regeneration itself, are never inspected, and a failure in the guard lets the edit through with a message rather than blocking all editing. It is guidance during a session, not enforcement: anything that must never be committed belongs in a git hook.

### Waiting for the database and the Vite server block

Two small helpers replace code every app copied. Both need no bootstrapped machine.

`devkit-wait-for-db` waits until the database in `DATABASE_URL` accepts connections, for the app's `db:wait` script inside `dev:container`: `"db:wait": "devkit-wait-for-db"`. It knows the default PostgreSQL and MariaDB ports, never prints the password, and exits 1 after `DB_WAIT_TIMEOUT_MS` (default 60000), retrying every `DB_WAIT_RETRY_MS` (default 1000). From code, `waitForDatabase({ url })` does the same and resolves `{ ok, host, port }`.

`devkitViteServer(env)` from `@dynamic-solutions-canada/devkit/vite` returns the `server` options devkit's environment decides: the in-container port, the bind address the proxy can reach, the checkout's allowed hostnames, and a watcher that ignores `.worktrees/`. The app spreads it and keeps its own proxy:

```ts
import { devkitViteServer } from '@dynamic-solutions-canada/devkit/vite'

export default defineConfig(({ mode }) => {
  // loadEnv reads .env files only; devkit's values arrive through process.env, so they win.
  const env = { ...loadEnv(mode, repoRoot, 'VITE_'), ...process.env }
  return {
    server: {
      ...devkitViteServer(env),
      proxy: { '/api': { target: `http://localhost:${env.VITE_API_PORT}` } },
    },
  }
})
```

Vite loads its config for production builds too, so this module has no imports and no side effects, and its options only matter to `vite dev`. A build still needs devkit installed, which it already is wherever the app's dev dependencies are.

### Icons

`devkit-icons` sizes and packs a repo's SVG masters into every icon its platforms need, and `devkit-icons --check` (for `validate`) fails when a committed icon no longer matches its master. It draws nothing: the art is the masters in `assets/brand/`:

| Master              | Needed for                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `icon.svg`          | everything; text converted to outlines                                                              |
| `icon-maskable.svg` | web (`purpose: maskable`, art inside the central 80%)                                               |
| `icon-mono.svg`     | Windows (its light-taskbar form is this drawn dark) and Android (monochrome and notification icons) |

`assets/brand/icons.json` names the repo's targets and where their files go:

```json
{
  "background": "#17181D",
  "targets": {
    "web": { "dir": "apps/web/public" },
    "windows": {
      "images": "AppMSIX/Images",
      "ico": "App/Resources/App.ico",
      "tiles": false
    },
    "android": {
      "res": "android/app/src/main/res",
      "legacy": false,
      "play": true
    }
  }
}
```

Every run also writes `assets/generated/icon-256.png` and `icon-512.png` for the README, website and promo catalog. The web target writes `icon.svg`, `icon-192.png`, `icon-512.png`, `maskable-icon-192.png`, `maskable-icon-512.png` and an opaque `apple-touch-icon.png`. The Windows target writes the MSIX logos at every scale, the `Square44x44Logo` target sizes in their plain, unplated and light-unplated forms, the `.ico` with all fifteen frames, and the 256 px `.png` beside it. All of them are transparent, because Windows draws its own plate. The Android target writes the adaptive vector icon, its monochrome layer and the notification icon, plus legacy launcher PNGs when `legacy` is true and the 512 px Play icon when `play` is true. `background` fills the opaque icons and the Android background layer.

Android vectors need masters made only of `<path d fill>` elements, the shape outlined art usually takes; anything else (groups, transforms, gradients, strokes, other shapes) is refused with the element that stopped it.

Rendering uses `@resvg/resvg-js`, which devkit does not install: add it to the repo as an exact dev dependency. The check compares bytes, so every machine must render with the same version.

### Refusing secrets and oversized files at commit time

`devkit-precommit` is the shared pre-commit check. It refuses staged:

- signing material and keys: `*.pfx`, `*.p12`, `*.jks`, `*.der`, `*.cer`, `*.keystore`;
- environment files: `.env` and `.env.*`, except names ending in `.example`;
- anything under a `.secrets/` folder;
- text containing a PEM private key, wherever it was pasted;
- files over the size limit, 5 MB unless set.

It checks what is staged, not the working tree: names from the index, sizes and contents from the staged blobs. Deleted files are ignored, a rename is checked at its new path, and submodule pointers are skipped. It lists every problem and fails the commit. Run it from `lefthook.yml`, with the repo's policy on the run line:

```yaml
pre-commit:
  commands:
    forbidden-files:
      run: npx devkit-precommit --allow android/app/debug.keystore --max-size 5MB
```

`--allow <path>` (repeatable, an exact repo-relative path) lets one file through every check, such as the debug keystore Android builds share. `--allow-large <path>` exempts one file from the size limit only. `git commit --no-verify` still skips the hook, so the check stays fast and is a guard, not a wall. Like the other `devkit-*` commands it needs no bootstrapped machine.

### Running tests

`devkit-test` finds and runs every `node --test` file in the app, so a test added in a new folder runs without editing a script. Point the app's `test` script at it:

```json
"scripts": {
  "test": "devkit-test",
  "test:api": "devkit-test apps/api",
  "test:integration": "devkit-test --integration"
}
```

It walks the whole repository for `*.test.ts`, `*.test.tsx` and `*.test.mjs`, skipping `node_modules`, `dist`, `build`, `coverage`, `external`, `tmp` and every folder whose name starts with a dot (so `.worktrees/` and `.git/` are never searched). Symlinked folders are not followed. Paths narrow the search; arguments starting with `--` pass through to `node --test`, for example `devkit-test -- --test-concurrency=1`. TypeScript tests run with `--import tsx`, so the app needs `tsx` as a dev dependency; devkit does not provide it. Finding no test files is a failure, not a pass.

Tests that need a database are named `*.integration.test.ts` (or `.tsx`, `.mjs`). The default run leaves them out, so `validate` needs nothing provisioned, and `devkit-test --integration` runs only those, one file at a time, because they share one database. Every test file belongs to exactly one of the two runs.

Two options in `devkit.config.mjs` cover the rest:

```js
export default {
  test: {
    // Folder names skipped at any depth, or repo-relative folder paths.
    ignore: ['android', 'ios'],
    // Extra file endings the default run leaves out.
    skipSuffixes: ['.e2e.test.ts'],
  },
}
```

Unlike the `devkit` commands, `devkit-test` needs no bootstrapped machine and does not switch Node through nvm: it runs on the Node that started it, so it works the same in CI and inside containers.

### Pinned host runtimes

Devkit CLI commands respect the current checkout's `.nvmrc`, including non-interactive worktree hooks. They select an already-installed runtime from `NVM_DIR` (default `~/.nvm`), put its tools first on PATH, and check exact npm pins in `package.json`. Installed nvm aliases are supported; exact versions make setup reproducible. Missing runtimes or conflicting pins stop before installs or infrastructure changes. Devkit never installs Node/npm or changes nvm's default.

Use `devkit run npm run dev` to select the runtime before a project runner starts. A Paseo setup hook can invoke `node "$PASEO_SOURCE_CHECKOUT_PATH/node_modules/@dynamic-solutions-canada/devkit/bin/devkit.mjs" prepare` when the new worktree has no dependencies yet; `prepare` selects the target worktree's runtime. Apply the same launcher to dev, teardown, build and agent-hook commands. Projects without `.nvmrc` retain their invoking runtime.

Library calls to `preflight`, `prepareDatabase` and `prepareCheckout` validate the executing runtime before preparing dependencies. They fail with an actionable message instead of replaying a runner that might already hold a checkout lease. Command entrypoints own runtime selection. A stale outer npm identity is cleared so preparation and startup use the same dependency fingerprint.

Host-side tools that need only the database can call `prepareDatabase({ repoRoot })`. It installs declared checkout dependencies, starts and provisions the database, and returns its loopback URL without starting the proxy, checking other projects, restoring data, or opening a browser.

## Commands

| Command                                                          | Purpose                                                                                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `devkit bootstrap`                                               | configure the machine proxy and database definitions; routing options are under [Remote development](#remote-development-and-an-existing-nginx-server) |
| `devkit prepare`                                                 | copy this checkout's `worktreeFiles` and install its dependencies, without starting anything                                                           |
| `devkit run <command> [arguments...]`                            | run host tooling with the checkout's pinned Node/npm                                                                                                   |
| `devkit doctor`                                                  | inspect this checkout's URLs, proxy, container, database, baseline, and dependencies                                                                   |
| `devkit snapshot`                                                | capture this checkout as the baseline for new worktrees                                                                                                |
| `devkit reset`                                                   | rebuild a worktree database from its baseline (`--empty` skips it)                                                                                     |
| `devkit prune`                                                   | find orphaned checkout database volumes (`--yes` removes them)                                                                                         |
| `devkit cleanup`                                                 | preview private linked-worktree resources; `--yes` permanently removes them                                                                            |
| `devkit infra`                                                   | start the proxy and current checkout database                                                                                                          |
| `devkit use [<dependency> <worktree> \| <dependency> --primary]` | show or choose which checkout of each dependency this checkout uses                                                                                    |
| `devkit nginx`                                                   | print nginx configuration for the configured machine domains                                                                                           |
| `devproxy add <name> <port>`                                     | route any host process through `<name>.localhost`                                                                                                      |
| `devproxy rm <name>`                                             | remove a route added with `devproxy add`                                                                                                               |
| `devproxy ls`                                                    | list every route and whether it is answering                                                                                                           |
| `devkit-test [--integration] [paths...]`                         | run the app's `node --test` files, or only its database tests; see [Running tests](#running-tests)                                                     |
| `devkit-init [--check]`                                          | write or check the generated dev files; see [Generated dev files](#generated-dev-files)                                                                |
| `devkit-wait-for-db`                                             | wait until `DATABASE_URL` accepts connections; see [Waiting for the database](#waiting-for-the-database-and-the-vite-server-block)                     |
| `devkit-icons [--check]`                                         | write or check every icon size from the SVG masters; see [Icons](#icons)                                                                               |
| `devkit-precommit [--allow <path>] [--max-size <n>]`             | refuse staged secrets, keys and oversized files; see [Refusing secrets](#refusing-secrets-and-oversized-files-at-commit-time)                          |

`devkit` with no command prints the full option list.

## Data and worktrees

Every checkout gets one private PostgreSQL or MariaDB server at `database:5432` or `database:3306`. The internal database name can therefore stay identical across worktrees. Port blocks and Compose project names are derived from checkout paths; no allocation registry or shared database profile exists.

`devkit snapshot` writes a portable SQL baseline under `~/.config/devkit/baselines`. A new worktree restores that dump before the project applies its migrations. `baselinePaths` can capture checkout-local files with the same baseline, and `worktreeFiles` copies allowlisted ignored config from the primary checkout only when missing.

Filesystem restore completion is recorded in `data/.devkit-baseline-restored`, only after a successful extraction. Files created by tests before the first start do not suppress restoration of the remaining baseline. Extraction never overwrites existing files. Existing checkouts without a receipt receive one non-overwriting restore; this does not replace identities they have already created. The receipt is excluded from snapshots. Remove it to retry a restore of missing files; removing `data/` also resets it. Refreshing the baseline does not reseed an already restored checkout.

`devkit prepare` is the dependency-only entry point for a newly created checkout. It copies the project's declared `worktreeFiles` and materializes its declared checkout-local install without starting Docker, a database, the proxy, or the application. It is safe to run repeatedly and is available from the PATH link created by bootstrap even when the checkout has no `node_modules` yet.

An `install` declaration makes the first preflight replace a missing, stale, or externally linked dependency tree with a checkout-local install. Devkit fingerprints the declared inputs, command, Node runtime, and invoking npm identity. Before installing, it moves any existing stale tree aside so npm cannot traverse borrowed links into a read-only checkout; a failed replacement restores the original tree. Devkit adds the short-lived backup pattern to Git's local exclude file automatically, so projects do not need to commit a tool-specific ignore rule. This lets a worktree start with shared dependencies while still guaranteeing that source-mounted containers receive a real local directory.

### Using a dependency's worktree

A declared dependency normally resolves to its project's primary checkout, such as `platform.localhost`. To test two branches together, point one checkout's dependency at a linked worktree of the other project:

```bash
devkit use platform bulk-email-pickup-limits   # use bulk-email-pickup-limits.platform.localhost
devkit use                                     # list each dependency, its checkout, and its health
devkit use platform --primary                  # go back to platform.localhost
```

The worktree name is the first part of that worktree's hostname, as shown by its `devkit doctor`. Git can name a worktree differently from its directory, so `devkit use` only accepts a worktree whose dev server is running, lists the running ones when the name does not match, and shows the directory and branch it selected. Startup repeats that line, so a surprising branch is visible. The choice applies only to the checkout where you ran the command, and takes effect on its next dev start: the startup health check, `devkit doctor`, and the `dependencyOrigins` passed to `env()` all use the selected worktree. A container that resolves dependency hostnames through `extra_hosts` should derive the hostname from `dependencyOrigins` rather than hard-coding it, and map it to `proxyAddress`, for example `"${PLATFORM_HOSTNAME}:${DEVKIT_PROXY_ADDRESS}"`.

The choice is stored under `~/.config/devkit/dependency-targets`, never in either repository, with the path of the checkout that made it. If that checkout moves, or a new worktree reuses a removed one's name, startup stops and asks you to choose again with `devkit use`, rather than guessing. `devkit cleanup --yes` removes it with the worktree's other private state. A damaged file stops startup and makes `devkit doctor` report the dependency as unknown, rather than silently falling back to the primary checkout; stopping a checkout still works.

### Removing a worktree

Keep ordinary `dev:down` non-destructive: it stops development and keeps the data. For permanent worktree removal, add `"dev:cleanup": "devkit cleanup --yes"` to the project's npm scripts, and run `devkit cleanup` first for a preview. Cleanup gracefully stops the checkout runner, removes its Compose-labelled containers and networks, releases its proxy route, and deletes its private database volume. It refuses primary checkouts and never removes the Git worktree itself, baseline snapshots, images, or shared caches.

Declare additional **private** volumes in `devkit.config.mjs`, for example:

```js
cleanup: {
  volumes: ['{project}_slicer-data', '{project}_slicer-work']
}
```

Names must start with `{project}-` or `{project}_`; cleanup also verifies each existing volume's Compose project label. Shared engine caches, CLI credentials, and other repositories' volumes must never appear here. Docker refuses removal of any volume still mounted by a container.

For Paseo, set `worktree.teardown` to `node "$PASEO_SOURCE_CHECKOUT_PATH/node_modules/@dynamic-solutions-canada/devkit/bin/devkit.mjs" cleanup --paseo --yes`. The source checkout CLI works even when worktree setup failed before installing dependencies. `--paseo` requires the matching teardown environment and queries all active workspaces, including background workspaces, before stopping anything and again before deleting data. Remaining references preserve resources; an unavailable or malformed query fails closed. The CLI uses `PASEO_HOME`/`PASEO_HOST` and discovers `paseo-plus-plus` or `paseo` on PATH (`PASEO_CLI` overrides the executable). Paseo remains responsible for the final reference check and directory removal. Do not reopen a worktree while its archive operation is running.

## Remote development and an existing nginx server

Localhost remains the default domain. Machine settings in `~/.config/devkit/host.json` can add secondary domains and choose one for printed URLs, browser opening, dependency origins, and application environment values. The domain preference is machine configuration, so an app's own settings stay portable. Every configured domain routes to the same checkout; changing a preference does not change application ports, database names, volumes, or Compose project names. Once a secondary domain is preferred, `npm run dev` uses it while keeping the localhost aliases, and `devkit doctor` lists the checkout's preferred URL and each alternate.

For a host nginx server that already owns port 80:

```bash
devkit bootstrap --secondary-domain server.home --preferred-domain server.home \
  --proxy-port 8080 --public-port 80
devkit nginx --allow 192.168.2.0/24 > /tmp/devkit.conf
```

Install the generated file in nginx's `http` configuration, validate with `nginx -t`, and reload nginx. The generated rule preserves Host and WebSocket headers and disables response buffering. Exact nginx virtual hosts retain precedence, so an existing `speedtest.server.home` site can coexist with the wildcard. The base `server.home` site is not claimed by devkit. The generator permits loopback clients plus each subnet explicitly passed with `--allow`.

Clients need DNS for `*.server.home` pointing to the server's LAN IP, including nested names such as `fix-123.printstream.server.home`. The default localhost aliases still resolve to the browser machine; use the secondary domain from a remote browser. Rerunning bootstrap preserves the saved settings. Restart existing runners after changing routing settings so their routes, Vite allowed hosts, and application origins are refreshed. Existing permanent `devproxy` routes can be refreshed by repeating `devproxy add <name> <port>`.

On native Linux, checkout ports bound only to host loopback need Traefik's host networking mode. When nginx also runs in Docker, its loopback is separate from the host's. Bind Traefik to nginx's Docker bridge gateway, and use that private address as nginx's upstream. For example, if nginx's bridge gateway is `172.24.0.1`:

```bash
devkit bootstrap --secondary-domain server.home --preferred-domain server.home \
  --proxy-network host --proxy-bind-address 172.24.0.1 \
  --proxy-port 18080 --public-port 80
devkit nginx --allow 192.168.2.0/24 --allow 172.24.0.1 > /tmp/devkit.conf
```

Use your actual bridge gateway and client subnet. Host networking requires Docker's host networking support; bridge mode remains the default. IPv4 loopback (`127.0.0.1`) is always the required listener. IPv6 loopback (`::1`) and the selected private interface each run in a separate optional proxy container. A disconnected LAN, a stale saved address, or an unavailable IPv6 listener produces a warning and leaves IPv4 local routes working. No listener binds a wildcard interface.

Localhost aliases always use HTTP and `proxyPort` directly, even when remote names use HTTPS or a different `publicPort`. For the example above, `http://app.localhost:18080` remains available while `http://app.server.home` continues to use nginx. Public preferred origins are preserved for application URLs and dependency origins; internal readiness checks use `127.0.0.1:proxyPort` with the public Host header, so remote DNS and TLS termination are not startup requirements.

After upgrading Devkit, the next startup or `devkit bootstrap` refreshes the managed proxy configuration, including machines with an older single-interface host listener. Existing route files and route leases remain compatible. Startup repairs the proxy before probing independently running dependency projects. `devkit doctor` checks required loopback HTTP and reports optional listener failures as warnings. To restore remote access after a network change, update the saved private address with `devkit bootstrap --proxy-bind-address <current-private-IP>` and check your secondary-domain DNS; this is independent of local startup.

The machine marker (`~/.config/devkit/host.json`, honoring `DEVKIT_CONFIG_DIR` and XDG) stores:

```json
{
  "enabled": true,
  "domain": "localhost",
  "secondaryDomains": ["server.home"],
  "preferredDomain": "server.home",
  "proxyPort": 18080,
  "publicPort": 80,
  "publicScheme": "http",
  "proxyNetwork": "host",
  "proxyBindAddress": "172.24.0.1"
}
```

Without `--preferred-domain`, secondary domains add aliases while localhost stays preferred. `--secondary-domain` can be repeated; providing it replaces the saved secondary-domain list. `preflight()` provides the preferred `url` and all configured `urls` (preferred first), also exposed as `DEVKIT_URL` and JSON-encoded `DEVKIT_URLS`. `proxyAddress` (also `DEVKIT_PROXY_ADDRESS`) is the address a container should map dependency hostnames to in Compose `extra_hosts`: the private bind address in host-network mode, where Docker's `host-gateway` does not reach the proxy, and `host-gateway` otherwise. The `domain` context value is the preferred suffix for constructing sibling service hostnames without a runtime dependency. Projects that enforce browser origins should use `urls` to populate their own allowlist if they need both origins for cross-origin requests or auth. Vite's allowed hosts include every configured checkout hostname automatically. Browser storage, cookies, and authentication registrations remain specific to each origin.

For HTTPS on nginx, set `--public-scheme https --public-port 443`. When generating the nginx file, also pass `--ssl-certificate` and `--ssl-certificate-key` with paths visible inside nginx. Certificates must be trusted by the browser and cover the configured names; a wildcard certificate covers one hostname level, so nested worktree names need additional coverage. Internal readiness checks use the private HTTP listener with the correct Host header and do not require LAN DNS or client CAs. Plain SSH sessions print the requested browser URL; VS Code Remote can use its existing client browser bridge.

## Logs

- **Foreground runs** write to the terminal that started them; devkit keeps no log file for them.
- **Background runs** (`--background`) append the runner's output to `<devkit config directory>/logs/<checkout slug>.log`, which is `~/.config/devkit/logs/` unless `DEVKIT_CONFIG_DIR` or `XDG_CONFIG_HOME` moves it. The file is created readable only by the user and is never rotated, so delete it when it grows.
- **The proxy** (Traefik) logs warnings and errors to its container output; read them with `docker logs` on the Traefik container. Access logging is off on purpose.

## Limits and gotchas

- Devkit is development tooling only. It does not deploy, run in CI, or take part in an app's production runtime.
- `devkit reset` refuses the primary checkout, and `devkit cleanup` refuses primary checkouts; both act only on linked worktrees.
- Only one runner owns a checkout at a time; start a second copy of the same checkout and it fails before changing anything.
- Devkit never installs Node or npm. A missing runtime named by `.nvmrc` stops startup with the `nvm install` to run.
- A permanent route created with `devproxy add` is also a proxy consumer. Traefik remains running until that route is removed with `devproxy rm`, even when no checkout projects are active.
- After the VS Code browser bridge is installed or updated, existing VS Code terminals must be relaunched before `--open=vscode` can find it.
- A wildcard TLS certificate covers one hostname level, so nested worktree names on a remote domain need their own coverage.
- Worktrees can live inside the main checkout at `.worktrees/<name>/`; devkit names and isolates each one from its git metadata, not its folder. Two things follow for the app. The primary checkout's containers mount the whole source tree, so its dev server, linters and test discovery must ignore `.worktrees/` (for Vite, `server.watch.ignored: ['**/.worktrees/**']`). And Node resolves packages by walking up parent folders, so a worktree without its own `node_modules` silently uses the primary checkout's; declare `install` in `devkit.config.mjs` so every worktree gets a local install.

## License

MIT. See [LICENSE](LICENSE). Copyright (c) 2026 Dynamic Solutions.
