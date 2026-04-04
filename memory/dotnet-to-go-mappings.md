# .NET to Go Translation Mappings

Discovered equivalents for .NET/C# constructs in Go. Verified through real migrations.

---

*No entries yet. The Analyzer and Evaluator agents will populate this file as patterns are discovered.*

## Pre-seeded known mappings

These are well-known translations seeded before any migration runs:

### `IActionResult` / `ActionResult<T>` → handler function with `http.ResponseWriter`
- .NET handlers return objects; Go handlers write directly to `ResponseWriter`
- Status code must be written explicitly before the body

### `[Route("prefix")]` + `[HttpGet("path")]` → chi router `r.Get("/prefix/path", handler)`
- Combine controller route prefix with method route attribute for the full path
- Route constraints like `{id:int}` become chi route patterns `{id}`; validate the type manually in the handler

### `[Required]` + model binding returning 400 → manual validation returning 400 with ValidationProblemDetails shape
- .NET does this automatically; Go requires explicit validation logic in the handler or middleware

### `DateTime` → `time.Time` serialized as RFC3339 (`"2006-01-02T15:04:05Z07:00"`)
- .NET's default JSON DateTime format is ISO 8601 which is compatible with RFC3339
- Watch for nullable DateTime (`DateTime?`) → `*time.Time`

### `async Task<T>` → synchronous Go handler
- Go's HTTP handlers are synchronous by default; concurrency is handled by the server
- Fire-and-forget async patterns require explicit goroutine management

### `ILogger<T>` → `zerolog.Logger` passed via context or dependency injection
