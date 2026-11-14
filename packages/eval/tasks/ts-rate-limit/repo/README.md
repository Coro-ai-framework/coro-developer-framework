# rate-limited-api

A small request handler for the catalogue API. It is transport-agnostic:
`app.handle({ method, path, headers })` returns `{ status, headers, body }`, and
the HTTP server that wraps it lives elsewhere.

```
npm install
npm test
npm run typecheck
```
