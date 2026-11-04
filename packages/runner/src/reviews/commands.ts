export type ReviewCommandName = 'review' | 'pause' | 'resume' | 'ignore' | 'explain'

export interface ParsedReviewCommand {
  name: ReviewCommandName
  arg?: string
}

const COMMAND_RE = /@coro\s+(review|pause|resume|ignore|explain)\b(?:\s+(\S+))?/i

export function parseReviewCommand(body: string | undefined): ParsedReviewCommand | null {
  if (!body) return null
  const match = body.match(COMMAND_RE)
  if (!match) return null
  return {
    name: match[1]!.toLowerCase() as ReviewCommandName,
    ...(match[2] ? { arg: match[2] } : {}),
  }
}

/** Commands are honored only from the PR author or the reviewer identity. */
export function commandIsAuthorised(actor: string | undefined, author: string, reviewerLogin: string): boolean {
  if (!actor) return false
  const who = actor.toLowerCase()
  return who === author.toLowerCase() || who === reviewerLogin.toLowerCase()
}
