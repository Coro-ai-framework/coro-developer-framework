---
name: migration-analysis
description: >-
  .NET codebase analysis patterns for migration: controller extraction, dependency
  mapping, serialization quirks, DI patterns, and ambiguity flags. Use when
  analyzing a .NET service prior to migration.
---

# Migration Analysis Guide

Domain-specific guidance for analyzing .NET services prior to migration. Supplements the generic Analyzer agent instructions with .NET-specific extraction patterns.

## Controller and endpoint extraction

For each controller in the scoped API projects, extract:

- **Route:** Full route including prefix from `[Route]` attribute and controller-level `[RoutePrefix]`
- **HTTP method:** GET/POST/PUT/PATCH/DELETE from `[HttpGet]`, `[HttpPost]`, etc.
- **Route parameters:** Names, types, constraints (e.g. `{id:int}`)
- **Query parameters:** Names, types, required vs optional, default values
- **Request body:** Full DTO shape (recursively — expand nested objects), JSON property names (check for `[JsonProperty]` overrides), required/optional fields, validation attributes (`[Required]`, `[Range]`, `[StringLength]`, `[RegularExpression]`)
- **Response body:** All return types per status code — check `[ProducesResponseType]`, `ActionResult<T>`, `IActionResult` return analysis
- **Auth:** `[Authorize]`, `[AllowAnonymous]`, custom auth attributes, policy names
- **Middleware:** Which filters/middleware apply to this endpoint (action filters, exception filters, model binding customizations)
- **Headers:** Any required request headers, any headers added to responses
- **Content negotiation:** Accepted content types, produced content types

## Dependency extraction

- **Database:** EF Core models and their table mappings, query patterns, stored procedures called. Look for `DbContext` subclasses, `DbSet<T>` properties, and LINQ query patterns.
- **HTTP clients:** Named `HttpClient` instances registered in DI, base URLs from `IConfiguration`, endpoints called. Check `Startup.cs` / `Program.cs` for `AddHttpClient` registrations.
- **Message queues / event bus:** Publishers and subscribers. Look for `IMediator`, MassTransit, or raw RabbitMQ/Azure Service Bus usage.
- **Cache:** Redis (`IDistributedCache`) or in-memory (`IMemoryCache`) cache usage patterns.
- **Configuration:** All `IConfiguration` keys accessed — these map to helm values. Check `appsettings.json`, `appsettings.{Environment}.json`, and direct `IConfiguration` / `IOptions<T>` injections.

## .NET-specific patterns to flag

### Model binding behavior
.NET automatically validates models annotated with `[Required]`, `[Range]`, etc., returning 400 with `ValidationProblemDetails` before the action method runs. This implicit behavior must be explicitly implemented in the target language.

### Exception handling middleware
Global exception filters (`IExceptionFilter`) or `UseExceptionHandler` middleware that catch unhandled exceptions and return `ProblemDetails` responses. Document the exact error shape returned.

### Action filters
`IActionFilter`, `IAsyncActionFilter`, and `[ServiceFilter]` / `[TypeFilter]` attributes that run logic before/after action methods. These often handle cross-cutting concerns (logging, metrics, validation) that need explicit porting.

### Route attribute conventions
- `[Route("api/[controller]")]` uses the controller name (minus "Controller" suffix)
- `[Route("[action]")]` uses the method name
- Route constraints like `{id:int}`, `{slug:alpha}`, `{page:int:min(1)}`

### Serialization quirks
- `[JsonProperty("name")]` (Newtonsoft) or `[JsonPropertyName("name")]` (System.Text.Json) can override field names
- `[JsonIgnore]` can hide fields from serialization
- Null handling differs between Newtonsoft (includes nulls by default) and System.Text.Json (omits nulls by default unless configured)
- Custom `JsonConverter` implementations that alter serialization behavior

### DI registration patterns
- Scoped vs Singleton vs Transient lifetimes affect behavior under concurrency
- `AddDbContext` is scoped by default — one context per request
- Named HttpClient instances with specific configurations (timeouts, base URLs, handlers)

## Ambiguity flags

In the analysis notes, flag:
- Any behavior that relies on .NET-specific defaults that don't exist in the target language (e.g., automatic model validation, global exception handling, `ProblemDetails` format)
- Any complex middleware that will require careful porting
- Any endpoints where the return type is unclear from static analysis (dynamic responses, `object` return types)
- Any config keys that have no obvious helm counterpart
- Any use of `System.Threading.Channels`, `BackgroundService`, or `IHostedService` for background processing
