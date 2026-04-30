// ── Cloud state backend (runner side) ─────────────────────────────────────────
//
// Implements StateBackend by delegating every call to the cloud control plane
// via WebSocket RPC. Used in hybrid mode where state lives in Postgres on the
// cloud but the runner accesses it transparently through this adapter.

import type { StateBackend } from './backend'
import type { WebSocketTransport } from './ws-transport'
import type {
  Job,
  JobInput,
  JobType,
  PrMapping,
  Proposal,
  ProposalStatus,
} from '../jobs/types'

export class CloudStateBackend implements StateBackend {
  constructor(
    private transport: WebSocketTransport,
    public readonly tenantId: string,
  ) {}

  // ── Job CRUD ───────────────────────────────────────────────────────────────

  async createJob(input: JobInput): Promise<Job> {
    return await this.call('job:create', { data: input }) as Job
  }

  async getJob(jobId: string): Promise<Job | null> {
    return await this.call('job:get', { jobId }) as Job | null
  }

  async updateJob(jobId: string, patch: Partial<Job>): Promise<Job> {
    return await this.call('job:update', { jobId, patch }) as Job
  }

  async listJobs(): Promise<Job[]> {
    return await this.call('job:list', {}) as Job[]
  }

  async listJobsByType(type: JobType): Promise<Job[]> {
    return await this.call('job:listByType', { jobType: type }) as Job[]
  }

  async listChildJobs(parentJobId: string): Promise<Job[]> {
    return await this.call('job:listChildren', { parentJobId }) as Job[]
  }

  async deleteJob(jobId: string): Promise<void> {
    await this.call('job:delete', { jobId })
  }

  // ── Logs ───────────────────────────────────────────────────────────────────

  async appendLog(jobId: string, line: string): Promise<void> {
    // Use fire-and-forget log batching via the transport's emit
    await this.transport.emit({
      type: 'job:log',
      jobId,
      data: { line },
    })
  }

  async getLog(jobId: string, start?: number, end?: number): Promise<string[]> {
    return await this.call('job:logGet', { jobId, start, end }) as string[]
  }

  async logLength(jobId: string): Promise<number> {
    return await this.call('job:logLength', { jobId }) as number
  }

  // ── PR mappings ────────────────────────────────────────────────────────────

  async mapPrToJob(prId: number, jobId: string): Promise<void> {
    await this.call('job:prMapping', { prId, jobId })
  }

  async getJobByPr(prId: number): Promise<Job | null> {
    return await this.call('job:byPr', { prId }) as Job | null
  }

  async addPrMapping(jobId: string, mapping: PrMapping): Promise<Job> {
    return await this.call('job:prMappingAdd', { jobId, mapping }) as Job
  }

  async markPrMerged(jobId: string, prId: number, mergedAt: string): Promise<Job> {
    return await this.call('job:prMerged', { jobId, prId, mergedAt }) as Job
  }

  // ── Jira mappings ──────────────────────────────────────────────────────────

  async mapJiraTicketToJob(ticketId: string, jobId: string): Promise<void> {
    await this.call('job:jiraMapping', { ticketId, jobId })
  }

  async getJobByJiraTicket(ticketId: string): Promise<Job | null> {
    return await this.call('job:byJira', { ticketId }) as Job | null
  }

  // ── Repo mappings ──────────────────────────────────────────────────────────

  async mapRepoToJob(repoSlug: string, jobId: string): Promise<void> {
    await this.call('job:repoMapping', { repoSlug, jobId })
  }

  // ── Proposals ──────────────────────────────────────────────────────────────

  async createProposal(proposal: Omit<Proposal, 'id'>): Promise<Proposal> {
    return await this.call('proposal:create', { data: proposal }) as Proposal
  }

  async listProposals(tenantId: string, status?: ProposalStatus): Promise<Proposal[]> {
    return await this.call('proposal:list', { tenantId, status }) as Proposal[]
  }

  async getProposal(tenantId: string, id: string): Promise<Proposal | null> {
    return await this.call('proposal:get', { tenantId, proposalId: id }) as Proposal | null
  }

  async updateProposal(tenantId: string, id: string, updates: Partial<Proposal>): Promise<Proposal> {
    return await this.call('proposal:update', { tenantId, proposalId: id, updates }) as Proposal
  }

  // ── RPC helper ─────────────────────────────────────────────────────────────

  private async call(type: string, data: Record<string, unknown>): Promise<unknown> {
    const messageId = this.transport.newMessageId()
    return this.transport.rpc({ type, messageId, ...data } as never)
  }
}
