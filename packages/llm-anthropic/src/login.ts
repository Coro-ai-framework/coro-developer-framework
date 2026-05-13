import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Logger } from 'pino'
import type { ClaudeAccountInfo } from './types'
import { ensureClaudeCodeCliExecutable, resolveClaudeCodeCliPath } from './cli-path'

export type ClaudeLoginStatus = 'idle' | 'authorizing' | 'connected' | 'error'

interface ClaudeLoginAuthorizingState {
  status: 'authorizing'
  manualUrl?: string
  automaticUrl?: string
  startedAt?: string
  completedAt?: string
}

interface ClaudeLoginConnectedState {
  status: 'connected'
  account?: ClaudeAccountInfo
  startedAt?: string
  completedAt?: string
}

interface ClaudeLoginErrorState {
  status: 'error'
  error?: string
  startedAt?: string
  completedAt?: string
}

interface ClaudeLoginIdleState {
  status: 'idle'
}

type ClaudeLoginInactiveState =
  | ClaudeLoginIdleState
  | ClaudeLoginConnectedState
  | ClaudeLoginErrorState

export type ClaudeLoginState =
  | ClaudeLoginIdleState
  | ClaudeLoginAuthorizingState
  | ClaudeLoginConnectedState
  | ClaudeLoginErrorState

export interface ClaudeLoginCallbackInput {
  authorizationCode: string
  state?: string
}

interface ClaudeLoginStartResponse {
  manualUrl?: string
  automaticUrl?: string
}

interface ClaudeLoginCompletionResponse {
  account?: ClaudeAccountInfo
}

interface ClaudeLoginRuntimeQuery extends Query {
  claudeAuthenticate(loginWithClaudeAi?: boolean): Promise<ClaudeLoginStartResponse>
  claudeOAuthCallback(authorizationCode: string, state?: string): Promise<ClaudeLoginCompletionResponse>
  claudeOAuthWaitForCompletion(): Promise<ClaudeLoginCompletionResponse>
}

interface ClaudeLoginSession {
  query: ClaudeLoginRuntimeQuery
  dispose(): void
}

interface ActiveClaudeLoginFlow extends ClaudeLoginAuthorizingState {
  status: 'authorizing'
  session: ClaudeLoginSession
  completion: Promise<void>
}

export interface ClaudeLoginManagerOptions {
  logger: Logger
  cwd?: string
  createSession?: () => ClaudeLoginSession | Promise<ClaudeLoginSession>
}

export class ClaudeLoginManager {
  private flow: ClaudeLoginInactiveState | ActiveClaudeLoginFlow = { status: 'idle' }
  private readonly logger: Logger
  private readonly cwd: string
  private readonly createSession: () => ClaudeLoginSession | Promise<ClaudeLoginSession>

  constructor(options: ClaudeLoginManagerOptions) {
    this.logger = options.logger
    this.cwd = options.cwd ?? process.cwd()
    this.createSession = options.createSession ?? (() => createClaudeLoginSession({
      logger: this.logger,
      cwd: this.cwd,
    }))
  }

  getState(): ClaudeLoginState {
    return toState(this.flow)
  }

  async start(): Promise<ClaudeLoginState> {
    if (this.flow.status === 'authorizing') {
      return this.getState()
    }

    const startedAt = new Date().toISOString()
    const session = await this.createSession()

    try {
      await session.query.initializationResult()

      const existingAccount = normalizeAccount(await session.query.accountInfo())
      if (existingAccount) {
        session.dispose()
        this.flow = {
          status: 'connected',
          account: existingAccount,
          startedAt,
          completedAt: new Date().toISOString(),
        }
        this.logger.info({ account: existingAccount.email ?? null }, 'Claude login already active')
        return this.getState()
      }

      const urls = await session.query.claudeAuthenticate(true)
      const flow: ActiveClaudeLoginFlow = {
        status: 'authorizing',
        startedAt,
        manualUrl: urls.manualUrl,
        automaticUrl: urls.automaticUrl,
        session,
        completion: Promise.resolve(),
      }
      this.flow = flow
      flow.completion = session.query
        .claudeOAuthWaitForCompletion()
        .then(result => {
          this.finalizeConnected(flow, result.account)
        })
        .catch(err => {
          this.finalizeError(flow, err)
        })

      this.logger.info('Claude login flow started')
      return this.getState()
    } catch (err) {
      session.dispose()
      this.flow = {
        status: 'error',
        error: getErrorMessage(err),
        startedAt,
        completedAt: new Date().toISOString(),
      }
      this.logger.warn({ err }, 'Claude login flow failed to start')
      return this.getState()
    }
  }

  async submitCallback(input: ClaudeLoginCallbackInput): Promise<ClaudeLoginState> {
    const flow = this.flow
    if (flow.status !== 'authorizing') {
      throw new Error('No active Claude login flow')
    }

    try {
      const result = await flow.session.query.claudeOAuthCallback(input.authorizationCode, input.state)
      this.finalizeConnected(flow, result.account)
      return this.getState()
    } catch (err) {
      this.finalizeError(flow, err)
      return this.getState()
    }
  }

  private finalizeConnected(flow: ActiveClaudeLoginFlow, account?: ClaudeAccountInfo): void {
    if (this.flow !== flow) return

    flow.session.dispose()
    this.flow = {
      status: 'connected',
      startedAt: flow.startedAt,
      completedAt: new Date().toISOString(),
      account: normalizeAccount(account),
    }
    this.logger.info({ account: this.flow.account?.email ?? null }, 'Claude login flow completed')
  }

  private finalizeError(flow: ActiveClaudeLoginFlow, err: unknown): void {
    if (this.flow !== flow) return

    flow.session.dispose()
    this.flow = {
      status: 'error',
      startedAt: flow.startedAt,
      completedAt: new Date().toISOString(),
      error: getErrorMessage(err),
    }
    this.logger.warn({ err }, 'Claude login flow failed')
  }
}

function createClaudeLoginSession(options: { logger: Logger; cwd: string }): ClaudeLoginSession {
  const { logger, cwd } = options
  // CLI resolution is anchored at the runner module (not `cwd`) so it works
  // when launched from any directory in the workspace.
  const claudeCodeCliPath = resolveClaudeCodeCliPath()
  ensureClaudeCodeCliExecutable(claudeCodeCliPath, logger)

  const idlePrompt = createIdlePromptStream()
  const authQuery = query({
    prompt: idlePrompt.stream,
    options: {
      pathToClaudeCodeExecutable: claudeCodeCliPath,
      cwd,
      settingSources: [],
      permissionMode: 'dontAsk',
      persistSession: false,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
      },
      stderr: (chunk: string) => {
        const text = String(chunk).trim()
        if (text) {
          logger.debug(`[claude-login-sdk] ${text}`)
        }
      },
    } as Parameters<typeof query>[0]['options'],
  })

  return {
    query: ensureRuntimeClaudeLoginQuery(authQuery),
    dispose() {
      idlePrompt.close()
      authQuery.close()
    },
  }
}

function ensureRuntimeClaudeLoginQuery(queryInstance: Query): ClaudeLoginRuntimeQuery {
  const runtime = queryInstance as Query & Partial<ClaudeLoginRuntimeQuery>

  if (
    typeof runtime.claudeAuthenticate !== 'function' ||
    typeof runtime.claudeOAuthCallback !== 'function' ||
    typeof runtime.claudeOAuthWaitForCompletion !== 'function'
  ) {
    throw new Error('Installed Claude Agent SDK runtime does not expose Claude login control methods')
  }

  return runtime as ClaudeLoginRuntimeQuery
}

function createIdlePromptStream(): { stream: AsyncIterable<SDKUserMessage>; close(): void } {
  let closed = false
  let resume: (() => void) | null = null

  return {
    stream: {
      async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
        while (!closed) {
          await new Promise<void>(resolve => {
            resume = resolve
          })
        }
      },
    },
    close() {
      if (closed) return
      closed = true
      resume?.()
      resume = null
    },
  }
}

function normalizeAccount(account: ClaudeAccountInfo | null | undefined): ClaudeAccountInfo | undefined {
  if (!account) return undefined

  const normalized: ClaudeAccountInfo = {
    email: account.email,
    organization: account.organization,
    subscriptionType: account.subscriptionType,
    tokenSource: account.tokenSource,
    apiKeySource: account.apiKeySource,
    apiProvider: account.apiProvider,
  }

  return hasAccountInfo(normalized) ? normalized : undefined
}

function hasAccountInfo(account: ClaudeAccountInfo | undefined): boolean {
  return Boolean(
    account?.email ||
      account?.organization ||
      account?.subscriptionType ||
      account?.tokenSource ||
      account?.apiKeySource ||
      account?.apiProvider,
  )
}

function toState(flow: ClaudeLoginInactiveState | ActiveClaudeLoginFlow): ClaudeLoginState {
  if (flow.status !== 'authorizing') {
    return { ...flow }
  }

  return {
    status: flow.status,
    manualUrl: flow.manualUrl,
    automaticUrl: flow.automaticUrl,
    startedAt: flow.startedAt,
    completedAt: flow.completedAt,
  }
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}