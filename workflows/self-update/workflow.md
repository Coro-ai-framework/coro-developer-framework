---
initial_phase: tracking
initial_status: awaiting-pr-merge

phases:
  - name: tracking
    agent: null
    model: planning
    status: awaiting-pr-merge
---

# Workflow: Self Update Tracking

This workflow exists so internally created self-update jobs use the same
workflowPath-driven job model as every other job. These jobs are not executed
by an agent phase loop; they are persisted for PR tracking and visibility only.