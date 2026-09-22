import type { DecisionAnswer, DecisionRecord } from '../types'

/**
 * The checklist the runner uses when a workflow does not declare its own.
 * Kept in step with `packages/runner/src/overseer/questions.ts`.
 */
const DEFAULT_OBLIGATIONS = [
  'The phase produced the output its workflow contract requires.',
  'The work still serves the stated objective of this job.',
  'The phase made progress rather than repeating work an earlier run already did.',
  'Failures the phase hit were surfaced, not silently worked around.',
]

export type OnTrackLabel = 'On track' | 'Needs a look' | 'Off track'
export type OnTrackTone = 'success' | 'warning' | 'danger'

export interface OnTrackLine {
  label: string
  value: string
}

export interface OnTrackReadout {
  label: OnTrackLabel
  tone: OnTrackTone
  /** 0–100. How sure we are the run still serves its goal. This number picks the label. */
  confidence: number | null
  summary: string
  lines: OnTrackLine[]
  checkedAfter: string
  earlier: Array<{ phase: string; label: OnTrackLabel; confidence: number | null }>
}

function noul(answers: Record<string, DecisionAnswer>, id: string): number | undefined {
  const answer = answers[id]
  return answer?.type === 'noul' ? answer.noul : undefined
}

function obligationLabel(choice: string): string | undefined {
  const match = /^obligation\[(\d+)\]$/.exec(choice)
  if (!match) return undefined
  return DEFAULT_OBLIGATIONS[Number(match[1])]
}

/** Rounded percent. The displayed figure and the label are the same number, so they cannot disagree. */
function confidencePercent(record: DecisionRecord): number | null {
  const onGoal = noul(record.answers, 'off_track')
  if (onGoal === undefined) return null
  const clamped = Math.min(1, Math.max(0, onGoal))
  return Math.round(clamped * 100)
}

function verdict(confidence: number | null): { label: OnTrackLabel; tone: OnTrackTone } {
  if (confidence === null || confidence >= 70) return { label: 'On track', tone: 'success' }
  if (confidence >= 40) return { label: 'Needs a look', tone: 'warning' }
  return { label: 'Off track', tone: 'danger' }
}

function summaryFor(label: OnTrackLabel, record: DecisionRecord): string {
  if (label === 'On track') return 'This run still looks like it is doing what it set out to do.'
  if (label === 'Off track') return 'This run looks like it has drifted away from what it set out to do.'
  const breach = record.answers['breach']
  if (breach?.type === 'choice' && breach.choice !== 'none' && breach.confidence >= 0.5) {
    const text = obligationLabel(breach.choice)
    if (text) return `Something from this phase looks unfinished: ${text}`
  }
  return 'Something about this phase is worth a look before more work piles on.'
}

function linesFor(record: DecisionRecord): OnTrackLine[] {
  const lines: OnTrackLine[] = []
  const confidence = confidencePercent(record)
  if (confidence !== null) {
    lines.push({
      label: 'Goal',
      value: confidence >= 70 ? 'Still on it' : confidence >= 40 ? 'Unclear' : 'Drifting',
    })
  }

  const breach = record.answers['breach']
  if (breach?.type === 'choice') {
    if (breach.choice === 'none' || breach.confidence < 0.5) {
      lines.push({ label: 'Requirements', value: 'Nothing we’re sure was missed' })
    } else {
      const text = obligationLabel(breach.choice) ?? 'A requirement for this phase'
      lines.push({ label: 'Requirements', value: text })
    }
  }

  const blocked = noul(record.answers, 'blocked')
  if (blocked !== undefined) {
    lines.push({
      label: 'Stuck',
      value: blocked >= 0.6 ? 'Might be waiting on something' : 'No',
    })
  }

  return lines
}

/**
 * The latest overseer check, in words. Other call sites (wake gate, review
 * hints) are not a statement about whether the run is on track.
 */
export function readOnTrack(records: readonly DecisionRecord[] | undefined): OnTrackReadout | null {
  const checks = (records ?? []).filter(record => record.site === 'overseer')
  const latest = checks[checks.length - 1]
  if (!latest) return null

  const confidence = confidencePercent(latest)
  const { label, tone } = verdict(confidence)
  const earlier = checks.slice(0, -1).slice(-3).reverse().map(record => {
    const earlierConfidence = confidencePercent(record)
    return {
      phase: record.phase,
      label: verdict(earlierConfidence).label,
      confidence: earlierConfidence,
    }
  })

  return {
    label,
    tone,
    confidence,
    summary: summaryFor(label, latest),
    lines: linesFor(latest),
    checkedAfter: latest.phase,
    earlier,
  }
}
