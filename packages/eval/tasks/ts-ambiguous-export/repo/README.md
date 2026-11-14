# account-service

Read-side helpers for the customer account area: users, invoices and daily
usage. Data is held in memory in this repository; the real stores sit behind
these functions in production.

```
npm install
npm test
npm run typecheck
```

See `docs/DATA-POLICY.md` before changing how data leaves the service.
