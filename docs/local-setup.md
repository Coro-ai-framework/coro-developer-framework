# Local Development Setup

This guide walks through running the full Coro agent platform locally for
development and testing of the runner + cloud control plane.

## Prerequisites

| Tool | Purpose | Install |
|------|---------|---------|
| Docker Desktop | Run all services locally | https://docker.com |
| ngrok | Expose local webhook endpoint to BitBucket | https://ngrok.com |
| Node.js 20+ | Run the CLI and runner locally | https://nodejs.org |
| pnpm 9+ | Workspace package manager | `corepack enable` |
| Git | Clone repos | system |

## Overview

The local stack runs three containers (legacy monolith mode):

```
docker-compose
├── coro-runner   Port 3000   Legacy agent orchestration service
├── redis         Port 6379   Job queue and state
└── ngrok         Port 4040   Tunnel → BitBucket can reach your local webhook
```

The CLI (`coro`) runs on your machine and talks to `coro-runner` at
`localhost:3000`.

> **Note:** This guide describes the legacy monolith mode that ships with the
> repo today. The recommended deployment going forward is hybrid mode (local
> runner + cloud control plane) or solo local mode (SQLite). See the
> multi-tenant architecture plan for the desktop-first onboarding flow that
> replaces most of this manual setup.

---

## Step 1: Clone and configure

```bash
# You should already have this repo
cd a5-ai

# Install workspace dependencies (generates pnpm-lock.yaml)
pnpm install

# Copy the example settings file
cp packages/runner/config/settings.example.json packages/runner/config/settings.json
```

Edit `packages/runner/config/settings.json` — see the
[Settings Reference](#settings-reference) below.

---

## Step 2: Set credentials

The credentials file is gitignored. Fill it in:

```
config/credentials.md
```

All values in that file are read by agents. The runner also reads them at
startup to configure its API clients.

Alternatively, create `packages/runner/.env` (also gitignored) with the same
values as environment variables — Docker Compose will load this automatically.

```env
BITBUCKET_WORKSPACE=a5labs
BITBUCKET_USERNAME=a5-coder-agent
BITBUCKET_APP_PASSWORD=your-app-password
ANTHROPIC_API_KEY=your-claude-api-key
LOKI_BASE_URL=https://loki.a5labs.internal
LOKI_API_KEY=your-loki-key
TEMPO_BASE_URL=https://tempo.a5labs.internal
TEMPO_API_KEY=your-tempo-key
REDIS_URL=redis://redis:6379
WEBHOOK_SECRET=generate-a-random-string
```

---

## Step 3: Configure ngrok

ngrok creates a public HTTPS URL that tunnels to your local `coro-runner`.
BitBucket uses this URL to send webhook events.

```bash
# Authenticate ngrok (one-time, free account works)
ngrok config add-authtoken YOUR_NGROK_TOKEN

# Or set it in settings.json (see Settings Reference)
```

---

## Step 4: Start the stack

```bash
cd packages/runner
docker compose up
```

You will see output like:

```
coro-runner  | Coro Runner is ready
coro-runner  | Webhook endpoint: POST /webhook
redis        | Ready to accept connections
ngrok        | Tunnel established: https://abc123.ngrok-free.app → localhost:3000
ngrok        | Webhook URL: https://abc123.ngrok-free.app/webhook
```

The ngrok URL changes every time you restart unless you have a paid ngrok
account with a static domain.

---

## Step 5: Register webhooks in BitBucket

For each repository involved (the .NET source repo, the intelligence repo):

1. Go to **Repository Settings → Webhooks → Add webhook**
2. URL: `https://YOUR-NGROK-URL/webhook`
3. Secret: the value of `WEBHOOK_SECRET` from your `.env`
4. Triggers:
   - Pull Request: Created, Updated, Approved, Fulfilled (merged), Comment created

You only need to do this once per repo. When you move to production, you update
the URL to the stable K8s ingress.

---

## Step 6: Install the CLI

```bash
cd packages/runner
pnpm link --global   # makes 'coro' available globally
```

Test it:
```bash
coro --help
coro status
```

---

## Step 7: Run your first job

```bash
coro job \
  --repo my-service \
  --description "Add rate limiting to /api/users" \
  --reviewers alice,bob \
  --workflow workflows/job/workflow.md
```

The CLI submits the job to the runner and streams progress. You can close the
terminal — the job continues running. Check back with:

```bash
coro status --job my-service-job-1712123456789
```

---

## Shared Volume in Local Development

In production, the shared volume is a Kubernetes PersistentVolumeClaim.
Locally, it is a Docker named volume mapped to `./data/` on your machine:

```
packages/runner/data/
├── working/                  ← Per-job state
│   └── my-service/
└── coro-intelligence/        ← Checked-out copy of the intelligence repo
```

The runner pulls the latest intelligence repo into
`data/coro-intelligence/` on startup and before each new job phase.

To inspect job state while a job is running:
```bash
cat packages/runner/data/working/my-service-job-1712123456789/implementation-plan.md
cat packages/runner/data/working/my-service-job-1712123456789/test-results/work-item-1.json
```

---

## Settings Reference

`packages/runner/config/settings.json`:

```jsonc
{
  // Runner host (legacy monolith mode)
  "host": {
    "port": 3000,
    "webhookSecret": "",          // Must match BitBucket webhook secret
    "logLevel": "info"            // debug | info | warn | error
  },

  // Claude API
  "claude": {
    "apiKey": "",                 // Or set ANTHROPIC_API_KEY env var
    "planningModel": "claude-opus-4-6",    // Used by Analyzer, Planner, Evaluator
    "codingModel": "claude-sonnet-4-6"     // Used by Coder, Tester, PR Reviewer
  },

  // BitBucket
  "bitbucket": {
    "workspace": "",
    "coderAccount": {
      "username": "a5-coder-agent",
      "appPassword": ""
    },
    "reviewerAccount": {
      "username": "a5-reviewer-agent",
      "appPassword": ""
    },
    "baseUrl": "https://api.bitbucket.org/2.0"
  },

  // Redis
  "redis": {
    "url": "redis://localhost:6379"  // docker-compose uses redis://redis:6379
  },

  // Shared volume paths
  "paths": {
    "workingDir": "./data/working",                    // Per-job state root
    "coroIntelligenceDir": "./data/coro-intelligence"  // Checked-out intelligence repo
  },

  // Observability
  "loki": {
    "baseUrl": "",
    "apiKey": ""
  },
  "tempo": {
    "baseUrl": "",
    "apiKey": ""
  },

  // ngrok (local only)
  "ngrok": {
    "authToken": "",
    "staticDomain": ""
  }
}
```

---

## Resetting local state

```bash
# Stop everything
docker compose down

# Wipe job state (keeps credentials and settings)
rm -rf packages/runner/data/working/

# Wipe everything including the intelligence checkout (will re-clone on next start)
rm -rf packages/runner/data/

# Nuke Redis state
docker compose down -v
```

---

## Troubleshooting

**Webhooks not arriving:**
- Check ngrok dashboard at `http://localhost:4040` — it shows all incoming requests
- Verify the webhook URL in BitBucket matches the current ngrok URL
- Verify `WEBHOOK_SECRET` matches between `.env` and the BitBucket webhook config

**Agent not finding credentials:**
- Check `config/credentials.md` is populated
- Or check `packages/runner/.env` has the environment variables set

**Job stuck or lost:**
- Check job state: `cat packages/runner/data/working/{job-id}/job.md`
- Check Redis: `docker exec -it coro-runner-redis redis-cli keys '*'`
- Restart the job from the last checkpoint: `coro resume --job {job-id}`

**BitBucket API rate limits:**
- The runner has built-in rate limiting. If you hit limits, jobs pause and
  retry automatically.
