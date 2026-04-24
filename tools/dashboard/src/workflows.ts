export interface WorkflowOption {
  id: string
  name: string
  workflowPath: string
  description: string
}

export const IMPLEMENTATION_WORKFLOWS: WorkflowOption[] = [
  {
    id: 'implementation-job',
    name: 'Implementation Job',
    workflowPath: 'workflows/job/workflow.md',
    description: 'General-purpose work-item workflow for scoped changes in an existing repository.',
  },
]