---
name: dotnet-conventions
description: >-
  .NET/C# coding standards: project layout, naming, controller conventions,
  DI, serialization, error handling, EF Core, testing, configuration.
  Use when reading, writing, or reviewing .NET code.
---

# .NET Coding Conventions

Coding standards for .NET/C# services. Agents reading or writing .NET code must follow these conventions.

## Coro job workspace

- **Job root:** `working/{jobId}/` — executor may start here; the `.sln` is usually in a repo subdirectory.
- **Repo:** `params.repoCheckoutAbsDir` — run `dotnet` from this tree via `cd <repoCheckoutDir> && …`; for git prefer `git -C <repoCheckoutDir> …` (chained `cd … && git …` only as fallback).

## Build verification (Coro runner)

```bash
cd "$REL" && dotnet build
```

Use the solution or project path from the implementation plan. Prefer the system NuGet cache (`~/.nuget`) — do not invent alternate package directories unless tenant memory says so.

If `dotnet restore` fails with `operation not permitted` writing under
`~/.nuget`, the host sandbox is denying the write (see the `sandbox-recovery`
skill). The existing cache is still readable, so restore into a job-local
package directory while keeping the warm cache as a source:

```bash
cd "$REL" && NUGET_PACKAGES="$JOB/.cache/nuget" \
  dotnet restore --source "$HOME/.nuget/packages" --source https://api.nuget.org/v3/index.json
```

## Test verification (Coro runner)

```bash
cd "$REL" && dotnet test
```

Redirect long output to a file under the job root when needed.

## Project Layout

```
{SolutionName}/
├── src/
│   ├── {ServiceName}.API/
│   │   ├── Controllers/          ← HTTP controllers (one per resource group)
│   │   ├── Filters/              ← Action filters, exception filters
│   │   ├── Middleware/           ← Custom middleware
│   │   ├── Program.cs            ← Entry point and host configuration
│   │   └── {ServiceName}.API.csproj
│   ├── {ServiceName}.Core/
│   │   ├── Models/               ← Domain models and DTOs
│   │   ├── Services/             ← Business logic interfaces and implementations
│   │   ├── Interfaces/           ← Service interfaces (for DI)
│   │   └── {ServiceName}.Core.csproj
│   └── {ServiceName}.Infrastructure/
│       ├── Data/                 ← EF Core DbContext, migrations, repositories
│       ├── Clients/              ← External HTTP clients
│       └── {ServiceName}.Infrastructure.csproj
├── tests/
│   ├── {ServiceName}.Tests/
│   │   └── {ServiceName}.Tests.csproj
│   └── {ServiceName}.IntegrationTests/
│       └── {ServiceName}.IntegrationTests.csproj
└── {SolutionName}.sln
```

## Naming

- **Types:** PascalCase (`UserService`, `OrderController`, `CreateUserRequest`)
- **Interfaces:** Prefix with `I` (`IUserService`, `IOrderRepository`)
- **Methods:** PascalCase (`GetUserById`, `CreateOrder`)
- **Local variables / parameters:** camelCase (`userId`, `orderRequest`)
- **Constants:** PascalCase (`MaxRetryCount`, `DefaultPageSize`)
- **Private fields:** `_camelCase` with underscore prefix (`_userService`, `_logger`)
- **Async methods:** Suffix with `Async` (`GetUserByIdAsync`, `CreateOrderAsync`)
- **Namespaces:** Match folder structure (`CompanyName.ServiceName.Core.Models`)

## Controller conventions

```csharp
[ApiController]
[Route("api/[controller]")]
public class UsersController : ControllerBase
{
    [HttpGet("{id:int}")]
    [ProducesResponseType(typeof(UserDto), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ProblemDetails), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<UserDto>> GetById(int id)
    {
        // ...
    }
}
```

- Use `[ApiController]` for automatic model validation and `ProblemDetails` responses
- Use `[ProducesResponseType]` for Swagger documentation and contract clarity
- Return `ActionResult<T>` for typed responses
- Use route constraints (`{id:int}`, `{slug:alpha}`)

## Dependency injection

- Register services in `Program.cs` or extension methods
- Use constructor injection exclusively
- Lifetimes:
  - **Scoped:** Services that hold request-specific state (DbContext, repositories)
  - **Singleton:** Stateless services, HTTP client factories, configuration
  - **Transient:** Lightweight, stateless helpers

## Serialization

### System.Text.Json (preferred for .NET 6+)
```csharp
[JsonPropertyName("user_name")]
public string UserName { get; set; }

[JsonIgnore]
public string InternalField { get; set; }
```

### Newtonsoft.Json (legacy)
```csharp
[JsonProperty("user_name")]
public string UserName { get; set; }

[JsonIgnore]
public string InternalField { get; set; }
```

- Check which serializer is configured in `Program.cs` / `Startup.cs`
- Null handling: System.Text.Json omits nulls by default; Newtonsoft includes them
- DateTime: ISO 8601 format by default
- Enums: string serialization via `[JsonConverter(typeof(JsonStringEnumConverter))]`

## Error handling

### ProblemDetails
```csharp
return Problem(
    detail: "User with ID 42 was not found",
    statusCode: StatusCodes.Status404NotFound,
    title: "Not Found",
    type: "https://tools.ietf.org/html/rfc7231#section-6.5.4"
);
```

### ValidationProblemDetails
Returned automatically by `[ApiController]` when model validation fails:
```json
{
  "type": "https://tools.ietf.org/html/rfc7231#section-6.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Email": ["The Email field is required."],
    "Age": ["The field Age must be between 1 and 150."]
  }
}
```

### Exception middleware
Global exception handling via `UseExceptionHandler` or `IExceptionFilter`:
- Catch all unhandled exceptions
- Log the exception
- Return a `ProblemDetails` response with status 500

## Validation attributes

```csharp
public class CreateUserRequest
{
    [Required]
    [StringLength(100, MinimumLength = 1)]
    public string Name { get; set; }

    [Required]
    [EmailAddress]
    public string Email { get; set; }

    [Range(1, 150)]
    public int Age { get; set; }

    [RegularExpression(@"^\+?[1-9]\d{1,14}$")]
    public string PhoneNumber { get; set; }
}
```

## EF Core conventions

```csharp
public class AppDbContext : DbContext
{
    public DbSet<User> Users { get; set; }
    public DbSet<Order> Orders { get; set; }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(AppDbContext).Assembly);
    }
}
```

- Use Fluent API over data annotations for complex configurations
- One `IEntityTypeConfiguration<T>` per entity
- Repository pattern wraps DbContext for testability
- Migrations in `Data/Migrations/` — never edit generated migration files manually

## Testing

### xUnit (preferred)
```csharp
public class UserServiceTests
{
    [Fact]
    public async Task GetById_ReturnsUser_WhenExists()
    {
        // Arrange
        var mockRepo = new Mock<IUserRepository>();
        // ...
    }

    [Theory]
    [InlineData("", false)]
    [InlineData("valid@email.com", true)]
    public void ValidateEmail_ReturnsExpected(string email, bool expected)
    {
        // ...
    }
}
```

- Use `[Fact]` for single test cases, `[Theory]` with `[InlineData]` for parameterized tests
- Mock interfaces with Moq or NSubstitute
- Integration tests use `WebApplicationFactory<Program>` for in-memory test server
- Test project references: only the projects being tested

## Configuration

```csharp
// appsettings.json structure maps to IOptions<T>
services.Configure<DatabaseSettings>(configuration.GetSection("Database"));

// Injected as:
public class UserRepository
{
    public UserRepository(IOptions<DatabaseSettings> settings) { }
}
```

- All configuration via `IConfiguration` / `IOptions<T>`
- Environment-specific settings in `appsettings.{Environment}.json`
- Secrets via environment variables or user secrets (never in source)

## Middleware patterns

```csharp
app.UseAuthentication();
app.UseAuthorization();
app.UseMiddleware<RequestLoggingMiddleware>();
app.UseExceptionHandler("/error");
```

- Middleware order matters — auth before authorization, logging early in pipeline
- Custom middleware implements `IMiddleware` or convention-based pattern
- Action filters for cross-cutting concerns at the controller/action level
