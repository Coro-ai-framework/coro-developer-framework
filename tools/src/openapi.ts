/**
 * OpenAPI 3.0 specification for the A5 Agent Host Service.
 * Served at GET /openapi.json and rendered at GET /docs via Swagger UI.
 */
export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'A5 Agent Host',
    version: '0.1.0',
    description:
      'Orchestration service that drives AI agents through migration and feature workflows. ' +
      'Receives job requests from the `a5` CLI or external webhooks, runs Claude API sessions, ' +
      'and parks/resumes jobs on BitBucket and Jira events.',
  },
  tags: [
    { name: 'jobs', description: 'Job lifecycle management' },
    { name: 'webhooks', description: 'Incoming BitBucket and Jira webhook events' },
    { name: 'system', description: 'Health and diagnostics' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['system'],
        summary: 'Health check',
        operationId: 'getHealth',
        responses: {
          200: {
            description: 'Service is healthy',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthResponse' },
                example: { status: 'ok', version: '0.1.0' },
              },
            },
          },
        },
      },
    },

    '/jobs': {
      get: {
        tags: ['jobs'],
        summary: 'List all jobs',
        description: 'Returns a summary of all jobs (conversation history omitted). Use `?type=` to filter by job type.',
        operationId: 'listJobs',
        parameters: [
          {
            name: 'type',
            in: 'query',
            required: false,
            schema: { $ref: '#/components/schemas/JobType' },
            description: 'Filter jobs by type',
          },
        ],
        responses: {
          200: {
            description: 'List of job summaries',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/JobListResponse' },
              },
            },
          },
        },
      },
    },

    '/jobs/migrate': {
      post: {
        tags: ['jobs'],
        summary: 'Create a migration job',
        description:
          'Starts a .NET → Go migration workflow for the specified service. ' +
          'Returns immediately with a `streamUrl` the CLI uses to tail logs.',
        operationId: 'createMigrationJob',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/MigrationJobInput' },
            },
          },
        },
        responses: {
          201: {
            description: 'Job created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/JobCreatedResponse' },
              },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
        },
      },
    },

    '/jobs/feature': {
      post: {
        tags: ['jobs'],
        summary: 'Create a feature job',
        description:
          'Starts a feature implementation workflow. ' +
          'Accepts either a full CLI-triggered body (repo + description + reviewers) ' +
          'or a Jira-triggered body (jiraTicketId only — spec-writer agent infers the rest).',
        operationId: 'createFeatureJob',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/FeatureJobCliInput' },
                  { $ref: '#/components/schemas/FeatureJobJiraInput' },
                ],
                discriminator: { propertyName: 'jiraTicketId' },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Job created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/JobCreatedResponse' },
              },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
        },
      },
    },

    '/jobs/{jobId}': {
      get: {
        tags: ['jobs'],
        summary: 'Get a job',
        description: 'Returns full job state (conversation history omitted — use /stream for log output).',
        operationId: 'getJob',
        parameters: [{ $ref: '#/components/parameters/jobId' }],
        responses: {
          200: {
            description: 'Job details',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Job' } },
            },
          },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/jobs/{jobId}/stream': {
      get: {
        tags: ['jobs'],
        summary: 'Stream job logs (SSE)',
        description:
          'Opens a Server-Sent Events stream of log lines for the job. ' +
          'Sends all existing lines immediately, then polls for new ones every 500 ms. ' +
          'Sends a heartbeat comment (`: heartbeat`) every 15 s to keep proxies alive. ' +
          'Stream closes when the job reaches a terminal state.',
        operationId: 'streamJobLogs',
        parameters: [{ $ref: '#/components/parameters/jobId' }],
        responses: {
          200: {
            description: 'SSE stream of log lines',
            headers: {
              'Content-Type': { schema: { type: 'string', enum: ['text/event-stream'] } },
              'Cache-Control': { schema: { type: 'string', enum: ['no-cache'] } },
              'X-Accel-Buffering': { schema: { type: 'string', enum: ['no'] } },
            },
            content: {
              'text/event-stream': {
                schema: {
                  type: 'string',
                  description: 'One `data: <line>\\n\\n` event per log line. Heartbeat: `: heartbeat\\n\\n`',
                  example: 'data: 2026-04-04T10:00:00.000Z Cloning repository...\n\n',
                },
              },
            },
          },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/jobs/{jobId}/resume': {
      post: {
        tags: ['jobs'],
        summary: 'Resume a parked job',
        description: 'Manually resumes a job that is parked awaiting a human decision. Wired in Phase 6.',
        operationId: 'resumeJob',
        parameters: [{ $ref: '#/components/parameters/jobId' }],
        responses: {
          200: { description: 'Job resumed' },
          404: { $ref: '#/components/responses/NotFound' },
          501: {
            description: 'Not yet implemented',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },

    '/jobs/{jobId}/message': {
      post: {
        tags: ['jobs'],
        summary: 'Send a message to a running agent',
        description:
          'Injects a developer message into the active Agent SDK query via streamInput(). ' +
          'The message is framed as developer guidance so the agent treats it as a hint, not a new task. ' +
          'Returns 409 if the job is not actively running (parked, failed, or complete).',
        operationId: 'sendMessage',
        parameters: [{ $ref: '#/components/parameters/jobId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SendMessageInput' },
            },
          },
        },
        responses: {
          200: {
            description: 'Message sent to agent',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SendMessageResponse' },
              },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          409: {
            description: 'Job is not actively running',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },

    '/webhook': {
      post: {
        tags: ['webhooks'],
        summary: 'Receive a BitBucket or Jira webhook event',
        description:
          'Entry point for all external webhook events. ' +
          'HMAC-SHA256 signature is verified from the `X-Hub-Signature` header before processing. ' +
          'Event source is detected from `X-Event-Key` (BitBucket) or `X-Atlassian-Token` (Jira).',
        operationId: 'receiveWebhook',
        parameters: [
          {
            name: 'X-Hub-Signature',
            in: 'header',
            required: true,
            schema: { type: 'string', example: 'sha256=abc123...' },
            description: 'HMAC-SHA256 signature of the raw request body',
          },
          {
            name: 'X-Event-Key',
            in: 'header',
            required: false,
            schema: { type: 'string', example: 'pullrequest:fulfilled' },
            description: 'BitBucket event type (present on BitBucket webhooks)',
          },
          {
            name: 'X-Atlassian-Token',
            in: 'header',
            required: false,
            schema: { type: 'string' },
            description: 'Jira webhook token (present on Jira webhooks)',
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                description: 'Webhook payload (structure varies by event source)',
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Event received and queued for processing',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/WebhookAckResponse' },
              },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: {
            description: 'HMAC signature verification failed',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: { error: 'Invalid signature' },
              },
            },
          },
        },
      },
    },
  },

  components: {
    parameters: {
      jobId: {
        name: 'jobId',
        in: 'path',
        required: true,
        schema: { type: 'string', example: 'my-service-migration-1712123456789' },
        description: 'Job identifier returned on creation',
      },
    },

    responses: {
      BadRequest: {
        description: 'Invalid request body or missing required fields',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ErrorResponse' },
          },
        },
      },
      NotFound: {
        description: 'Job not found',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ErrorResponse' },
            example: { error: 'Job not found: my-service-migration-123' },
          },
        },
      },
    },

    schemas: {
      // ── Enums ───────────────────────────────────────────────────────────────

      JobType: {
        type: 'string',
        enum: ['migration', 'feature', 'self-update'],
        description: 'The type of work a job performs',
      },

      JobStatus: {
        type: 'string',
        enum: [
          'queued', 'initializing', 'spec-writing', 'analyzing', 'planning',
          'awaiting-plan-approval', 'repo-setup', 'coding', 'awaiting-pr-merge',
          'testing', 'evaluating', 'reporting', 'complete', 'escalated', 'failed',
        ],
        description: 'Lifecycle status of a job',
      },

      JobPhase: {
        type: 'string',
        enum: [
          'init', 'spec-writing', 'analysis', 'planning', 'repo-setup',
          'coding', 'review', 'testing', 'evaluation', 'reporting',
        ],
        description: 'The current phase within the workflow (maps to an agent MD file)',
      },

      // ── Sub-objects ─────────────────────────────────────────────────────────

      PrMapping: {
        type: 'object',
        required: ['prId', 'feature', 'repoSlug', 'openedAt'],
        properties: {
          prId: { type: 'integer', example: 42 },
          feature: { type: 'string', example: 'feature-3-users-endpoints' },
          repoSlug: { type: 'string', example: 'my-service-go' },
          openedAt: { type: 'string', format: 'date-time' },
          mergedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },

      // ── Job ─────────────────────────────────────────────────────────────────

      Job: {
        type: 'object',
        required: [
          'id', 'type', 'workflowPath', 'serviceName', 'repoSlug', 'projects',
          'reviewers', 'stagingUrl', 'triggerSource', 'status', 'phase',
          'currentFeature', 'prMappings', 'createdAt', 'updatedAt',
        ],
        properties: {
          id: { type: 'string', example: 'my-service-migration-1712123456789' },
          type: { $ref: '#/components/schemas/JobType' },
          workflowPath: { type: 'string', example: 'workflows/migration/workflow.md' },
          serviceName: { type: 'string', example: 'my-service' },
          repoSlug: { type: 'string', example: 'my-service' },
          projects: { type: 'array', items: { type: 'string' }, example: ['MyService.API'] },
          reviewers: { type: 'array', items: { type: 'string' }, example: ['alice', 'bob'] },
          stagingUrl: { type: 'string', example: 'https://staging.my-service.a5labs.com' },
          triggerSource: { type: 'string', enum: ['cli', 'jira', 'internal'] },
          jiraTicketId: { type: 'string', nullable: true, example: 'A5-1234' },
          status: { $ref: '#/components/schemas/JobStatus' },
          phase: { $ref: '#/components/schemas/JobPhase' },
          currentFeature: { type: 'string', nullable: true },
          prMappings: { type: 'array', items: { $ref: '#/components/schemas/PrMapping' } },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
          awaitingEvent: { type: 'string', nullable: true },
          awaitingPrId: { type: 'integer', nullable: true },
          escalationMessage: { type: 'string', nullable: true },
        },
      },

      JobSummary: {
        type: 'object',
        description: 'Lightweight job view returned by GET /jobs (no conversation history)',
        required: ['id', 'type', 'serviceName', 'status', 'phase', 'prCount', 'createdAt', 'updatedAt'],
        properties: {
          id: { type: 'string' },
          type: { $ref: '#/components/schemas/JobType' },
          serviceName: { type: 'string' },
          status: { $ref: '#/components/schemas/JobStatus' },
          phase: { $ref: '#/components/schemas/JobPhase' },
          currentFeature: { type: 'string', nullable: true },
          triggerSource: { type: 'string', enum: ['cli', 'jira', 'internal'] },
          prCount: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },

      // ── Inputs ──────────────────────────────────────────────────────────────

      MigrationJobInput: {
        type: 'object',
        required: ['repo', 'projects', 'reviewers', 'stagingUrl', 'serviceName'],
        properties: {
          repo: { type: 'string', description: 'BitBucket repo slug', example: 'my-service' },
          projects: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: 'C# project names within the .NET solution',
            example: ['MyService.API', 'MyService.Models'],
          },
          reviewers: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: 'BitBucket usernames to tag as PR reviewers',
            example: ['alice', 'bob'],
          },
          stagingUrl: {
            type: 'string',
            description: 'Base URL of the .NET staging service (used for request comparison)',
            example: 'https://staging.my-service.a5labs.com',
          },
          serviceName: { type: 'string', example: 'my-service' },
        },
      },

      FeatureJobCliInput: {
        type: 'object',
        required: ['repo', 'reviewers', 'description', 'serviceName'],
        properties: {
          repo: { type: 'string', example: 'my-service-go' },
          reviewers: { type: 'array', items: { type: 'string' }, minItems: 1 },
          description: {
            type: 'string',
            description: 'Natural language description of the feature to implement',
            example: 'Add rate limiting to /api/users — 100 req/min per IP',
          },
          serviceName: { type: 'string', example: 'my-service' },
        },
      },

      FeatureJobJiraInput: {
        type: 'object',
        required: ['jiraTicketId'],
        properties: {
          jiraTicketId: {
            type: 'string',
            description: 'Jira ticket ID — spec-writer agent infers repo, reviewers, and description',
            example: 'A5-1234',
          },
        },
      },

      // ── Responses ───────────────────────────────────────────────────────────

      HealthResponse: {
        type: 'object',
        required: ['status', 'version'],
        properties: {
          status: { type: 'string', enum: ['ok'] },
          version: { type: 'string' },
        },
      },

      JobCreatedResponse: {
        type: 'object',
        required: ['jobId', 'type', 'status', 'streamUrl'],
        properties: {
          jobId: { type: 'string', example: 'my-service-migration-1712123456789' },
          type: { $ref: '#/components/schemas/JobType' },
          status: { $ref: '#/components/schemas/JobStatus' },
          streamUrl: { type: 'string', example: '/jobs/my-service-migration-1712123456789/stream' },
        },
      },

      JobListResponse: {
        type: 'object',
        required: ['jobs', 'count'],
        properties: {
          jobs: { type: 'array', items: { $ref: '#/components/schemas/JobSummary' } },
          count: { type: 'integer' },
        },
      },

      WebhookAckResponse: {
        type: 'object',
        required: ['received', 'source'],
        properties: {
          received: { type: 'boolean', enum: [true] },
          source: { type: 'string', enum: ['bitbucket', 'jira'] },
          eventKey: { type: 'string', nullable: true, example: 'pullrequest:fulfilled' },
        },
      },

      SendMessageInput: {
        type: 'object',
        required: ['message'],
        properties: {
          message: {
            type: 'string',
            description: 'Message text to send to the running agent',
            example: 'Use the existing auth middleware instead of creating a new one',
          },
        },
      },

      SendMessageResponse: {
        type: 'object',
        required: ['sent', 'jobId'],
        properties: {
          sent: { type: 'boolean', enum: [true] },
          jobId: { type: 'string' },
        },
      },

      ErrorResponse: {
        type: 'object',
        required: ['error'],
        properties: {
          error: { type: 'string' },
        },
      },
    },
  },
} as const
