# Local Development Setup

This guide walks through running the full A5 AI agent platform locally for development and testing.

## Prerequisites

| Tool | Purpose | Install |
|------|---------|---------|
| Docker Desktop | Run all services locally | https://docker.com |
| ngrok | Expose local webhook endpoint to BitBucket | https://ngrok.com |
| Node.js 20+ | Run the CLI locally | https://nodejs.org |
| Git | Clone repos | system |

## Overview

The local stack runs three containers:

```
docker-compose
├── agent-host    Port 3000   The agent orchestration service
├── redis         Port 6379   Job queue and state
└── ngrok         Port 4040   Tunnel → BitBucket can reach your local webhook
```

The CLI (`a5`) runs on your machine and talks to `agent-host` at `localhost:3000`.

---

## Step 1: Clone and configure

```bash
# You should already have this repo
cd a5-ai/tools

# Install dependencies (once agent host code exists)
npm install

# Copy the example settings file
cp config/settings.example.json config/settings.json
```

Edit `config/settings.json` — see the [Settings Reference](#settings-reference) below.

---

## Step 2: Set credentials

The credentials file is gitignored. Fill it in:

```
a5-ai/config/credentials.md
```

All values in that file are read by agents. The Agent Host also reads them at startup to configure its API clients.

Alternatively, create `tools/.env` (also gitignored) with the same values as environment variables — Docker Compose will load this automatically.

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

ngrok creates a public HTTPS URL that tunnels to your local `agent-host`. BitBucket uses this URL to send webhook events.

```bash
# Authenticate ngrok (one-time, free account works)
ngrok config add-authtoken YOUR_NGROK_TOKEN

# Or set it in settings.json (see Settings Reference)
```

---

## Step 4: Start the stack

```bash
cd a5-ai/tools
docker-compose up
```

You will see output like:

```
agent-host  | Agent Host running on port 3000
agent-host  | Webhook endpoint: POST /webhook
redis       | Ready to accept connections
ngrok       | Tunnel established: https://abc123.ngrok-free.app → localhost:3000
ngrok       | Webhook URL: https://abc123.ngrok-free.app/webhook
```

The ngrok URL changes every time you restart unless you have a paid ngrok account with a static domain. For consistent local development, consider a free static ngrok domain.

---

## Step 5: Register webhooks in BitBucket

For each repository involved (the .NET source repo, the `a5-ai` repo):

1. Go to **Repository Settings → Webhooks → Add webhook**
2. URL: `https://YOUR-NGROK-URL/webhook`
3. Secret: the value of `WEBHOOK_SECRET` from your `.env`
4. Triggers: select these events:
   - Pull Request: Created, Updated, Approved, Fulfilled (merged), Comment created

You only need to do this once per repo. When you move to production, you update the URL to the stable K8s ingress.

---

## Step 6: Install the CLI

```bash
cd a5-ai/tools
npm link   # makes 'a5' available globally
```

Test it:
```bash
a5 --help
a5 status
```

---

## Step 7: Run your first migration

```bash
a5 migrate \
  --repo my-service \
  --projects MyService.API,MyService.Models \
  --reviewers alice,bob \
  --staging-url https://staging.my-service.a5labs.com
```

The CLI submits the job to the Agent Host and streams progress. You can close the terminal — the job continues running. Check back with:

```bash
a5 status --job my-service-migration
```

---

## Shared Volume in Local Development

In production, the shared volume is a Kubernetes PersistentVolumeClaim. Locally, it is a Docker named volume mapped to `./data/` on your machine:

```
tools/data/
├── working/                 ← Per-job state
│   └── my-service/
└── a5-ai/                   ← Checked-out copy of this repo (agents read from here)
```

The Agent Host pulls the latest `a5-ai` repo into `data/a5-ai/` on startup and before each new job phase.

To inspect job state while a job is running:
```bash
cat tools/data/working/my-service/migration-plan.md
cat tools/data/working/my-service/test-results/feature-1.json
```

---

## Settings Reference

`tools/config/settings.json`:

```jsonc
{
  // Agent Host
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
    "workspace": "",              // e.g. "a5labs"
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
    "workingDir": "./data/working",     // Per-job state root
    "a5aiDir": "./data/a5-ai"           // Checked-out a5-ai repo
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
    "authToken": "",              // From ngrok dashboard
    "staticDomain": ""           // Optional: paid ngrok static domain
  }
}
```

---

## Resetting local state

```bash
# Stop everything
docker-compose down

# Wipe job state (keeps credentials and settings)
rm -rf tools/data/working/

# Wipe everything including a5-ai checkout (will re-clone on next start)
rm -rf tools/data/

# Nuke Redis state
docker-compose down -v
```

---

## Troubleshooting

**Webhooks not arriving:**
- Check ngrok dashboard at `http://localhost:4040` — it shows all incoming requests
- Verify the webhook URL in BitBucket matches the current ngrok URL (it changes on restart)
- Verify `WEBHOOK_SECRET` matches between `.env` and BitBucket webhook config

**Agent not finding credentials:**
- Check `config/credentials.md` is populated
- Or check `tools/.env` has the environment variables set

**Job stuck or lost:**
- Check job state: `cat tools/data/working/{service}/job.md`
- Check Redis: `docker exec -it a5-redis redis-cli keys '*'`
- Restart the job from the last checkpoint: `a5 resume --job {service}-migration`

**BitBucket API rate limits:**
- The Agent Host has built-in rate limiting. If you hit limits, jobs will pause and retry automatically.
