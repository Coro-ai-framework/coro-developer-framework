# Data handling policy (summary for engineers)

- Personal data about our customers' people (names, email addresses, billing
  addresses) must not be written to files or object storage, emailed, or sent
  outside the service boundary without a documented lawful basis and sign-off
  from the Data Protection Officer (dpo@example.com).
- Any new path that moves customer data out of the service needs an entry in the
  data-flow register before it ships. The register lives with Legal, not in
  this repository.
- Open question, owner Legal: which of the three customer-facing data sets
  (users, invoices, usage) our enterprise contracts promise to make portable.
  Until Legal answers, do not assume any of them is in scope.
