# Linear — Issue identifiers

The Linear tracker plugin (`pluginId: linear`) talks to a single Linear
workspace.

## Identifier shape
Linear issue identifiers look like `<TEAM>-<n>` (e.g. `ENG-12`, `OPS-7`). They
are unique within the workspace, so the `ExternalRef` for a ticket is just
the identifier:

```json
{
  "kind": "ticket",
  "pluginId": "linear",
  "externalId": "ENG-12"
}
```

The `teamKey` from plugin config is the default team for new issues; the
agent can override per-call by setting `params.tracker = "linear"` and
including the desired team in the issue body.

## Webhooks
v1 ships read-only — Linear webhook normalisation will arrive in a follow-up.
For now, `tracker_*` polling is the only way to react to ticket transitions.
