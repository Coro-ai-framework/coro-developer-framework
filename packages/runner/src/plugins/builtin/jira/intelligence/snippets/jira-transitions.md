# Jira — Tickets, Transitions, and References

The Jira tracker plugin (`pluginId: jira`) talks to a single Atlassian Cloud
or Server site (configured at install time).

## Issue keys
Jira keys are project-prefixed (`ENG-123`, `OPS-42`) and globally unique
within the site, so an `ExternalRef` for a ticket only needs the key:

```json
{
  "kind": "ticket",
  "pluginId": "jira",
  "externalId": "ENG-123"
}
```

`repoKey` is unused for tickets and is stored as the empty string.

## Transitions
Jira transition names are **case-sensitive** and project-specific. Use
`tracker_transition_issue` and pass the exact transition name you fetched
from `tracker_get_issue` (or the project's workflow); guessing names like
`"Done"` vs `"Done!"` is the most common cause of write failures.

## Spec writer flow
The spec-writer agent reads tickets through the Jira plugin's legacy
read-skewed API (richer ADF-aware comment rendering). Other agents should
prefer the generic `tracker_*` tools — they are normalised and provider-
agnostic.
