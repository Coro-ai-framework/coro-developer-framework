---
name: sandbox-recovery
description: >-
  Recovery playbook for host-sandbox denials — `operation not permitted` /
  EPERM writing outside the job directory, blocked package registries, and
  unanswerable interactive permission prompts. Invoke the moment a build,
  restore, or fetch fails for an environment reason rather than a code reason.
---

# Host Sandbox Recovery

Coro asks the executor to disable OS-level sandboxing, but the machine or the
organisation running it may enforce one anyway through policy Coro cannot see
or override. When that happens the job does **not** get a clean error from
Coro — it gets a kernel-level `EPERM` from whatever tool you invoked.

This skill is the recovery path. Work it in order before escalating.

## 1. Confirm it is the host sandbox, not Coro's path guard

| Symptom | Gate | What it means |
|---|---|---|
| Tool result starts with `Blocked Bash:` | Coro path guard | The command never ran. Rewrite the path. |
| The command ran and *it* printed `operation not permitted` / `EPERM` | Host sandbox | The path is legal to name but not to write. |
| A fetch fails for a host that resolves and is up | Host sandbox | There is a network allowlist. |
| Bash asks for interactive permission | Host sandbox | The unsandboxed-retry escape hatch; nobody can answer it. Do not retry. |

Coro's `$HOME` package-cache exemptions mean the guard will not stop you from
*naming* `~/go/**`, `~/.nuget/**`, and friends. That is not a promise the OS
will let you write there.

Assume a typical host sandbox allows **reads almost everywhere**, allows
**writes only inside `$PWD`**, and restricts **outbound network to an
allowlist** that usually includes your SCM host but not public package mirrors.

## 2. Move every toolchain write inside the job directory

The job root (`$JOB`) is writable. Redirect caches there rather than fighting
the sandbox:

| Toolchain | Env var(s) |
|---|---|
| Go | `GOCACHE`, `GOMODCACHE` |
| .NET | `NUGET_PACKAGES` |
| npm / pnpm / yarn | `npm_config_cache`, `PNPM_STORE_DIR`, `YARN_CACHE_FOLDER` |
| Python | `PIP_CACHE_DIR`, `UV_CACHE_DIR` |
| Rust | `CARGO_HOME` |
| Java | `GRADLE_USER_HOME`, `MAVEN_OPTS=-Dmaven.repo.local=…` |

## 3. Read the warm host cache instead of refetching

A cache you cannot write to is still **readable**. This is the step agents
most often miss: they see "cannot write to the shared cache", switch to a
fresh cache directory, discover the fresh cache is cold, conclude the network
allowlist makes a cold cache impossible, and escalate — when the warm cache
was usable as a read-only source the whole time.

Point the package manager at the existing cache as a local source and let only
the genuinely missing artefacts hit the network. Go, for example:

```bash
cd "$REL" && GOFLAGS=-mod=mod \
  GOCACHE="$JOB/.cache/go-build" GOMODCACHE="$JOB/.cache/gomod" \
  GOPROXY="file://$HOME/go/pkg/mod/cache/download,direct" \
  go build -buildvcs=false ./...
```

Everything already cached resolves locally; only the missing module falls
through to `direct`. The equivalent for .NET is an extra `<add key>` source in
a job-local `NuGet.config` pointing at `~/.nuget/packages`; for npm, an
offline-first `--prefer-offline` install against the existing cache.

For three further Go-specific recipes this warm-cache fallback doesn't cover —
vendoring a module that ships a `.gitmodules` file, building a tool CLI from
inside the target module so `replace` directives apply, and a job-local
`GIT_CONFIG_GLOBAL` for private vanity-import modules — see the matching
sections in the `golang-conventions` skill.

## 4. Fetch what is missing from a host you know is reachable

Your SCM host is nearly always on the allowlist — you cloned through it.
Public mirrors (`proxy.golang.org`, `sum.golang.org`, PyPI, a tenant Nexus)
may not be. For a private dependency hosted on your own SCM, mark it private
so the toolchain fetches it directly from there and skips the public checksum
or index service:

```bash
GOPRIVATE='<scm-host>/<org>/*' GONOSUMDB='<scm-host>/<org>/*'
```

## 5. Chained commands can defeat host command exemptions

A host policy may exempt specific commands (`git` is a common one). The
exemption matches the command it is given, so `cd repo && git checkout …` can
be sandboxed while a bare `git -C repo checkout …` is not. If a normally
exempt command fails with `EPERM`, retry it once in its own un-chained form
using the tool's own directory flag before concluding it is blocked.

For a push specifically, if `git push origin <branch>` is stopped by an
unanswerable host permission prompt, `operation not permitted`, `EPERM`, or a
similar sandbox-like denial, try exactly one un-chained retry:

```bash
git -C <repoCheckoutDir> push origin <branch>
```

Do not wrap this retry in `cd`, `&&`, or a command wrapper intended to bypass
policy. If it fails, continue to escalation or a documented provider-native
fallback; do not retry it repeatedly.

## 6. If still blocked

Record `add_insight` with `category: "sandbox-quirk"`, the exact command, the
exact error, and which of the steps above you tried — then `escalate`.

**Never** bump, downgrade, or unpin a dependency to dodge a sandbox limit.
That converts an environment problem into an unreviewed production change and
hides the real fault from whoever can actually fix the policy.
