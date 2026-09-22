# Overseer

Overseer watches whether a job stays faithful to what you asked. Jev scores each phase; Coro shows an on-track rating and can pause an interactive job.

Jev answers a fixed set of questions. It does not write the phase or pick the next one. Coro runs the same jobs with Overseer off. If Jev is unreachable or slow, the phase continues.

---

## What you see on a run

When Overseer has checked at least one phase, the run header shows a pill next to the status: **On track**, **Needs a look**, or **Off track**, with a percentage.

That percentage is the chance the work still serves the job's goal. It is the only input to the label:

| Percent | Label |
| --- | --- |
| 70% or more | On track |
| 40–69% | Needs a look |
| Under 40% | Off track |

Open the pill for a short readout: the same percentage, whether a phase requirement looks unmet, and whether the agent might be stuck. Earlier checks for this run are listed underneath. The readout is plain language. It does not show raw question ids or scores.

A run with no Overseer checks has no pill.

---

## Observe and Manage

The dashboard calls the two modes **Observe** and **Manage**. Config and the runner still store `shadow` and `live`.

| In the dashboard | Stored `decision.mode` | What happens |
| --- | --- | --- |
| Off | `off`, or the block is absent | No Jev calls. Jobs behave as they did before Overseer existed. |
| Observe | `shadow` | Every check is recorded. The pill updates. The job keeps running. |
| Manage | `live` | The same check can pause an **interactive** job when the stricter flag below trips. Non-interactive jobs are recorded only. |

Observe is the recommended way to turn it on. Switch to Manage after the ratings look right.

The setup wizard asks for a Jev API key on its own optional step. **Skip — I don't have a key** leaves Coro unchanged. If a key is already saved, skipping that step keeps it. The model step and the code-host step both offer **Skip for now**.

---

## When a check runs

The faithfulness check runs at the **end of each phase**, before an interactive checkpoint, when all of these are true:

- `decision.mode` is Observe or Manage, and an API key is available
- the Overseer site is not set to Off
- scope is **All workflows** (the default), or **Campaigns only** and this job is a campaign parent or child

Jev is also used, behind the same mode switch, at a few narrower sites. Each site can inherit the global mode or be set to Off, Observe, or Manage on its own:

| Site | What it watches |
| --- | --- |
| Overseer | End-of-phase faithfulness. In Manage mode, can pause interactive jobs. |
| Wake gate | Whether a webhook should resume a parked job. A plain-code bot filter runs first, so bot authors never call Jev. |
| Lane advisory | Whether the job still belongs in its workflow lane. It never switches the lane. |
| Input screen | Inbound comments that look like instruction overrides. |
| Review lens | A suggested review focus. It never skips review. |

---

## How a phase is judged

Jev does not write prose and does not choose the next phase. Coro sends the phase's obligations and a short trajectory, and asks four questions:

1. **Requirements** — which obligation, if any, the phase failed. `none` means every obligation was met.
2. **Goal** — the probability that the work still serves the stated objective. This probability, as a percent, is the pill.
3. **Seriousness** — 0 cosmetic, 1 worth a look, 2 a developer should review, 3 the run should stop.
4. **Stuck** — the probability the agent is waiting on something it cannot resolve itself.

Shipped workflows use this default obligation list. A phase may replace it with `obligations:` in workflow YAML:

- The phase produced the output its workflow contract requires.
- The work still serves the stated objective of this job.
- The phase made progress rather than repeating work an earlier run already did.
- Failures the phase hit were surfaced, not silently worked around.

### The pill and the pause use different thresholds

The pill follows the goal percentage above. Pausing uses a stricter rule, and only in Manage mode:

- the goal probability is **25% or lower**, or
- a requirement looks unmet with confidence **at least 0.5** and seriousness **at least 1.5**

An 85% goal with a low-confidence missed requirement stays **On track** and does not pause the job.

A pause also requires all of the following: Manage mode, **When flagged** set to park (the default), an interactive job, and this phase has not already been approved to continue. Observe mode never pauses. Non-interactive jobs are never paused. After you approve, that phase is not paused again for the same flag.

---

## What the working agent is told

The session that just finished does not see its own check. The **next** phase sees a `[process note]` only when the previous phase was flagged, or when the previous phase looked blocked (stuck probability 0.75 or higher). The note is context about process confidence. It is not a code-quality score and it is not an instruction to undo the previous phase.

---

## If Jev is unreachable

Every failure path continues the job: missing key, timeout (default **1500 ms**), HTTP errors, and malformed answers. The runner logs the skip and does not invent a rating. A guardrail kind named `decision` exists for operators who want to attach a policy, and it allows the tool call whenever the provider fails. No shipped guardrail uses it.

The model is pinned to **`jev-1.13.0`**. A floating alias would move the thresholds.

---

## Turn it on

**Settings → Extensions → Overseer**, or the optional step in **Run setup wizard**.

You need a Jev API key. Leave the key blank in Settings to use `CORO_DECISION_API_KEY`, or `TYPESAFE_API_KEY` when that variable is unset. Leave base URL blank for the provider default. Leave model blank for `jev-1.13.0`.

Environment variables, used when the matching config field is empty:

| Variable | Meaning |
| --- | --- |
| `CORO_DECISION_MODE` | `off`, `shadow` (Observe), or `live` (Manage) |
| `CORO_DECISION_API_KEY` | Jev API key |
| `CORO_DECISION_BASE_URL` | Provider origin |
| `CORO_DECISION_MODEL` | Model id |
| `TYPESAFE_API_KEY` | Legacy key, used only when `CORO_DECISION_API_KEY` is unset |

Both a non-off mode and a key are required. Either one alone leaves the layer off.

---

## Config

`~/.coro/config.json`:

```json
{
  "decision": {
    "mode": "shadow",
    "provider": "jev",
    "apiKey": "…",
    "model": "jev-1.13.0",
    "timeoutMs": 1500,
    "overseer": {
      "scope": "all",
      "onFlag": "park",
      "thresholds": {
        "offTrackNoul": 0.75,
        "severityScore": 1.5,
        "minChoiceConfidence": 0.5
      }
    },
    "sites": {
      "overseer": "live",
      "wake-gate": "shadow"
    }
  }
}
```

`mode: "shadow"` is Observe. `mode: "live"` is Manage. `overseer.scope` is `all`, `campaigns`, or `off`. `onFlag` is `park` or `flag-only`. `offTrackNoul` is the goal-probability cutoff used by the pause rule: the default `0.75` flags when the stored probability drops to `0.25` or below. The pill thresholds (70 / 40) are dashboard-only and are not in this file.

The API key is redacted in `GET /config`.

A phase can declare its own obligations:

```yaml
phases:
  - name: coding
    agent: agents/coder.md
    obligations:
      - The phase opened a pull request for the current work item.
      - Tests for the change were run, or the reason they were not was written down.
```

---

## Where the code lives

The job loop talks to a `DecisionLayer`. With no resolved config, that layer is a no-op and does not import the Jev client.

Jev's HTTP client lives in `packages/runner/src/plugins/builtin/jev/` and is loaded only when `decision.provider` is `jev`. It is not registered as an executor, SCM, or tracker plugin. Question text, the pause rule, and the per-site checks stay in the runner (`packages/runner/src/overseer/`, `packages/runner/src/decision/`) because they are Coro behaviour any decision provider would serve.

Records are appended to `job.decisionRecords` (capped). The dashboard reads the `overseer` site from that list to draw the pill.
