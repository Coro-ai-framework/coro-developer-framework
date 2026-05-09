# Debugging Recipes

Step-by-step playbooks for diagnosing recurring failure modes in this
tenant's repos. Read when you hit a failure that smells familiar — the
recipe that took someone three hours to discover should take you three
minutes to apply.

The Coder, Evaluator, or PR Reviewer populates this file via `propose_change`
when a debugging session produced a reusable recipe (not just a one-off
fix). The bar for inclusion: would the next agent / a future reader
*genuinely save time* by reading this before debugging?

## Entry format

```
## <symptom you would search for>

**Discovered:** YYYY-MM-DD | **Source job:** <job id> | **Applies to:** <repo / language / framework>

### Symptoms
- <observable thing that brought you here>
- <log line, error message, test failure>

### Root cause
<one paragraph: why it happens>

### Recipe
1. <copy-pasteable command>
2. <next step>
3. <verification — how you know the fix worked>

### Don't do
- <tempting wrong turn that will waste time>
```

---

*No entries yet. Agents populate this file when a debugging session produces
a reusable recipe.*
