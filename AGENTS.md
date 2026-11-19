# devkit: Agent Instructions

devkit is the shared local development tooling for the web apps. It gives every Git checkout and worktree its own `*.localhost` hostname, derived ports and a private database container, and runs the routing proxy that serves them. Apps install it as a dev dependency pinned to a git tag, and it ships only through those tags. It is MIT licensed and builds on no other kit.

## Standards

This repo follows the shared standards at https://github.com/Dynamic-Solutions-Canada/app-standards. Read the index for this stack, https://github.com/Dynamic-Solutions-Canada/app-standards/blob/main/stacks/kits.md, then the topic file for the area you are changing. If `external/standards/` exists, it is the same content pinned for offline use. Where this file differs from the standards, this file wins and says why.

## Architecture

devkit owns a hostname, port and database per checkout and worktree, the routing proxy, `devkit.config.mjs`, the `devkit` and `devproxy` commands, and development data snapshots. It does not own production deployment, CI, or an app's own dev processes; it may supply templates that are written into an app, but it is never a runtime or production dependency of one.

| Area                                                        | Files                                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Command-line entry points                                   | `bin/devkit.mjs`, `bin/devproxy.mjs`                                                        |
| Public API (`.` and `./identity` exports)                   | `src/index.mjs`, `src/checkout-identity.mjs`                                                |
| Checkout lifecycle: prepare, install, run, Compose, cleanup | `src/checkout-*.mjs`, `src/background-runner.mjs`                                           |
| Project config and pinned Node runtime                      | `src/project-config.mjs`, `src/project-runtime.mjs`, `src/config.mjs`                       |
| Proxy, host routing and remote preflight                    | `src/proxy.mjs`, `src/host-routing.mjs`, `src/host-setup.mjs`, `src/preflight.mjs`          |
| Databases and baselines                                     | `src/database*.mjs`, `src/data-baseline.mjs`                                                |
| Dependencies on other checkouts                             | `src/project-dependencies.mjs`, `src/dependency-targets.mjs`                                |
| Compose definitions installed by bootstrap                  | `infra/`                                                                                    |
| Test discovery for apps (`devkit-test`)                     | `src/test-runner.mjs`, `bin/devkit-test.mjs`                                                |
| Generated dev and deploy files for apps (`devkit-init`)     | `src/app-templates.mjs`, `templates/`, `bin/devkit-init.mjs`                                |
| Database wait and Vite server helpers for apps              | `src/database-wait.mjs`, `bin/devkit-wait-for-db.mjs`, `src/vite.mjs` (the `./vite` export) |
| Icon generator for apps (`devkit-icons`)                    | `src/icons/`, `bin/devkit-icons.mjs`                                                        |
| Pre-commit check for apps (`devkit-precommit`)              | `src/precommit.mjs`, `bin/devkit-precommit.mjs`                                             |
| Third-party notices for apps (`devkit-notices`)             | `src/notices/`, `bin/devkit-notices.mjs`                                                    |
| VS Code browser bridge                                      | `vscode-extension/`, built by `scripts/build-browser-extension.mjs`                         |

## Conventions and gotchas

- Every change reaches apps only when a version is tagged and each app bumps its pin, so a breaking change needs a major version and the app updates planned with it.
- Keep devkit domain-neutral: no app names, app settings or app behaviour. When an app needs something different, add a general option in `devkit.config.mjs` and keep the policy in the app.
- Apps install from a git tag with no build step, so only what `files` in `package.json` lists reaches them. The `.vsix` under `vscode-extension/` is committed because `src/browser.mjs` loads it from the installed package, a documented exception to the no-build-output rule. Rebuild it with `npm run build:browser-extension` whenever the extension changes, and bump the extension's version when its behaviour changes, because installed copies update only on a new version. `npm run check:browser-extension` (run in CI) fails when the tracked file no longer matches a rebuild.
- The VS Code extension keeps the publisher and id `ryanewen.devkit-browser`: it is an installed identifier on existing machines, and the standards treat installed identifiers as permanent (BRAND-11). Do not rename it during the organisation move or later without a decision.
- `engines.node` is a range, not an exact pin, so apps still on an older Node line can install devkit with `engine-strict=true`. devkit itself is developed and tested on the version in `.nvmrc`.
- `templates/run-dev.mjs`, `templates/deploy-over-ssh.mjs` and `templates/generated-file-guard.mjs` are copied verbatim into every app and checked there by `devkit-init --check`, so any change to them, even whitespace, makes every app regenerate on its next pin bump. Change it only for a reason apps need, and say so in the release notes.
- `templates/deploy-over-ssh.mjs` runs during a deploy, so it must never import devkit (D-045). Its tests run the server script against fake `git` and `docker`, never a real server.
- `src/vite.mjs` is loaded by apps' `vite.config` during production builds, so it must stay import-free and side-effect free.
- Tests that need a private key build its PEM marker at run time, so no tracked file holds one for a scanner, or `devkit-precommit`, to refuse.
- The README is the canonical usage doc that apps link to; change behaviour and its README section together.

## Commands

| Command                           | Proves                                             | Does not prove                                                                                    |
| --------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `npm test`                        | The unit tests pass on this Node                   | Behaviour against a live proxy, Docker or Paseo; one host-listener test skips itself without them |
| `npm run build:browser-extension` | The VS Code browser bridge packages into a `.vsix` | That the extension works in VS Code                                                               |
| `npm run check:browser-extension` | The tracked `.vsix` matches a rebuild from source  | That the extension works in VS Code; it needs network for the pinned packager                     |

## Release

A `vX.Y.Z` tag runs `.github/workflows/release.yml`, which checks the tag against `package.json` and `release-notes/<version>.md` and creates the GitHub Release. The procedure is the `release` skill.

## Guidance map

| Guide, doc, or skill | Read or use when                                  | Governs                                    |
| -------------------- | ------------------------------------------------- | ------------------------------------------ |
| `README.md`          | Changing any command, config option or setup step | How apps install, configure and run devkit |
| `release` skill      | Releasing a version                               | Notes, bump, tag and the Release           |

## Keeping docs current

| What changed                                   | Update                         |
| ---------------------------------------------- | ------------------------------ |
| A command, option or `devkit.config.mjs` field | `README.md`                    |
| An area or entry point moved                   | The Architecture table above   |
| Anything a consuming app will notice           | The next `release-notes/` file |
