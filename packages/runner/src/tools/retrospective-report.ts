// ── Retrospective report gate ────────────────────────────────────────────────
//
// `post_artifact` stores whatever it is handed, and `summarizeRetrospective`
// reads it back defensively — a finding with no `id` is dropped, evidence with
// no `jobId` is dropped, an unknown `category` silently becomes
// `base-intelligence`. That is right for the list page, which must render an
// old artefact rather than crash, but it means a malformed report reaches the
// human ballot with findings quietly missing or misrouted.
//
// This module is the other half: a write-time check that refuses the artefact
// and says what to fix, so the analyst repairs it in the same phase instead of
// a developer approving a report that lost a finding on the way in.
//
// It also closes the split-finding gap. One defect surfaces in several of the
// signal types the `retrospective-analysis` skill enumerates — a failing tool
// is a tool-failure cluster, a cost outlier, rework on the phase that calls it,
// and a repeated insight — and the analyst writes one candidate per signal
// because that is what the threshold table asks for. Nothing downstream ever
// rejoins them: `fingerprintFinding` hashes title and paths, so N symptoms
// become N upstream issues.
//
// Detecting the overlap is arithmetic, so it is done here rather than asked of
// the model. Naming the shared cause is judgement, so that is asked of the
// model. The gate refuses only silence.

import {
  isSupportedMetricName,
  describeMetricVocabulary,
  metricNameError,
} from './job-trace'

/** Categories and severities accepted at write time — no silent defaulting. */
const CATEGORIES = ['tenant-intelligence', 'base-intelligence', 'runner-code']
const SEVERITIES = ['high', 'medium', 'low']

/**
 * How much of two findings' evidence has to coincide before they are treated
 * as the same story. Set at half because in a window of a few dozen jobs a
 * single shared job is ordinary co-occurrence: on the report this rule was
 * derived from, the true pair scored 0.75 and every coincidental pair scored
 * 0.33 or less.
 */
export const EVIDENCE_OVERLAP_THRESHOLD = 0.5

export interface FindingOverlap {
  a: string
  b: string
  /** Why the pair was flagged, in the words the analyst will need to answer. */
  reason: string
}

/** The only fields the overlap rule reads. */
export interface OverlapCandidate {
  id: string
  category: string
  evidenceJobIds: string[]
  targetPaths: string[]
}

interface ReadFinding {
  index: number
  label: string
  id: string
  title: string
  category: string
  severity: string
  evidenceJobIds: string[]
  targetPaths: string[]
  rootCause: string
  deliveryGroup: string
  independentOf: Array<{ findingId: string; reason: string }>
  hasPredictedMetric: boolean
  predictedMetricName: string
}

/**
 * Problems that must be fixed before the report is worth a human's attention,
 * or `[]` when it is clean. Every problem is phrased as an instruction: the
 * analyst gets one message listing all of them and repairs them in one turn.
 */
export function validateRetrospectiveReport(data: Record<string, unknown> | undefined): string[] {
  const raw = data?.['findings']
  if (raw === undefined) {
    return ['The report must carry a `findings` array (use `[]` when the window was clean).']
  }
  if (!Array.isArray(raw)) {
    return ['`findings` must be an array.']
  }

  const problems: string[] = []
  const findings: ReadFinding[] = []

  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      problems.push(`findings[${index}] is not an object.`)
      return
    }
    const finding = readFinding(entry, index)
    if (!finding.id) {
      problems.push(`findings[${index}] has no \`id\` — it would be dropped before the ballot.`)
    }
    if (!finding.title) {
      problems.push(`${finding.label} has no \`title\` — it would be dropped before the ballot.`)
    }
    if (finding.id && finding.title) findings.push(finding)
  })

  const seen = new Set<string>()
  for (const finding of findings) {
    if (seen.has(finding.id)) {
      problems.push(`Two findings share the id "${finding.id}" — the ballot addresses findings by id.`)
    }
    seen.add(finding.id)
  }

  for (const finding of findings) {
    problems.push(...validateFinding(finding))
  }

  problems.push(...validateGroups(findings))
  problems.push(...validateOverlaps(findings))

  return problems
}

function validateFinding(finding: ReadFinding): string[] {
  const problems: string[] = []

  if (!CATEGORIES.includes(finding.category)) {
    problems.push(
      `${finding.label} has category "${finding.category || '(missing)'}" — expected one of ` +
      `${CATEGORIES.join(', ')}. The category picks the destination, so a wrong one ships it to the wrong layer.`,
    )
  }
  if (!SEVERITIES.includes(finding.severity)) {
    problems.push(
      `${finding.label} has severity "${finding.severity || '(missing)'}" — expected one of ${SEVERITIES.join(', ')}.`,
    )
  }

  // The two-job bar. It is the main thing keeping a retrospective from
  // becoming a code review, and until now it lived only in the skill prose.
  if (finding.evidenceJobIds.length === 0) {
    problems.push(`${finding.label} cites no job in \`evidence[]\`. No number, no finding.`)
  } else if (finding.evidenceJobIds.length === 1 && finding.severity !== 'high') {
    problems.push(
      `${finding.label} cites one job. A finding needs evidence from two, unless it is an ` +
      'evidence-pipeline defect (the report, ledger, or cluster schema itself is broken), ' +
      'which must be severity `high`.',
    )
  }

  if (!finding.hasPredictedMetric) {
    problems.push(
      `${finding.label} has no \`predictedMetric\`. Without one the next retrospective scores it ` +
      `\`unverifiable\` and the remedy is never checked. Pick a name from:\n${describeMetricVocabulary()}`,
    )
  } else if (!isSupportedMetricName(finding.predictedMetricName)) {
    problems.push(
      `${finding.label} predicts "${finding.predictedMetricName}", which the scorer cannot compute ` +
      `(${metricNameError(finding.predictedMetricName) ?? 'unrecognised'}). Supported names:\n` +
      describeMetricVocabulary(),
    )
  }

  return problems
}

/**
 * A root cause is the unit that ships: one issue, one work item, one ballot
 * group. That only holds if its members agree on where they go and what they
 * claim to move — a group split across categories has no single destination,
 * and one split across metrics is not making one prediction.
 */
function validateGroups(findings: ReadFinding[]): string[] {
  const problems: string[] = []
  const groups = new Map<string, ReadFinding[]>()
  for (const finding of findings) {
    if (!finding.rootCause) continue
    groups.set(finding.rootCause, [...(groups.get(finding.rootCause) ?? []), finding])
  }

  for (const [rootCause, members] of groups) {
    if (members.length < 2) continue
    const ids = members.map(member => member.id).join(', ')

    const categories = new Set(members.map(member => member.category))
    if (categories.size > 1) {
      problems.push(
        `Findings ${ids} share rootCause "${rootCause}" but have different categories ` +
        `(${[...categories].join(', ')}). One root cause ships to one destination — split the ` +
        'root cause, or correct the categories.',
      )
    }

    const metrics = new Set(members.map(member => member.predictedMetricName).filter(Boolean))
    if (metrics.size > 1) {
      problems.push(
        `Findings ${ids} share rootCause "${rootCause}" but predict different metrics ` +
        `(${[...metrics].join(', ')}). They ship as one change, so they make one prediction — ` +
        'give the group a single `predictedMetric`, or they are not one root cause.',
      )
    }
  }

  return problems
}

function validateOverlaps(findings: ReadFinding[]): string[] {
  return detectOverlaps(findings)
    .filter(overlap => !isResolved(findings, overlap))
    .map(overlap =>
      `Findings ${overlap.a} and ${overlap.b} overlap (${overlap.reason}). Resolve it one of three ways: ` +
      'merge them into a single finding; give both the same `rootCause` if they are one defect seen twice; ' +
      'give both the same `deliveryGroup` if they are separate defects that edit the same files and must ' +
      'ship together; or add the other id to `independentOf` with a `reason` if the overlap is coincidental.',
    )
}

/**
 * Pairs that look like one story told twice.
 *
 * Same category, and then either signal is enough — because splitting happens
 * two ways and each leaves a different trace. A function with several bugs
 * produces findings that share a file and no jobs; a single gap that surfaces
 * as several signal types produces findings that share jobs and no file.
 * Requiring both signals at once catches neither.
 */
export function detectOverlaps(findings: ReadonlyArray<OverlapCandidate>): FindingOverlap[] {
  const overlaps: FindingOverlap[] = []

  for (let i = 0; i < findings.length; i += 1) {
    for (let j = i + 1; j < findings.length; j += 1) {
      const a = findings[i]
      const b = findings[j]
      if (a.category !== b.category) continue

      const sharedPaths = intersect(a.targetPaths, b.targetPaths)
      const similarity = jaccard(a.evidenceJobIds, b.evidenceJobIds)

      const reasons: string[] = []
      if (similarity >= EVIDENCE_OVERLAP_THRESHOLD) {
        reasons.push(`${Math.round(similarity * 100)}% of their cited jobs are the same`)
      }
      if (sharedPaths.length > 0) {
        reasons.push(`both change ${sharedPaths.join(', ')}`)
      }
      if (reasons.length === 0) continue

      overlaps.push({ a: a.id, b: b.id, reason: reasons.join('; ') })
    }
  }

  return overlaps
}

function isResolved(findings: ReadFinding[], overlap: FindingOverlap): boolean {
  const a = findings.find(finding => finding.id === overlap.a)
  const b = findings.find(finding => finding.id === overlap.b)
  if (!a || !b) return true

  if (a.rootCause && a.rootCause === b.rootCause) return true
  if (a.deliveryGroup && a.deliveryGroup === b.deliveryGroup) return true

  // A declaration only counts when it carries a reason — the whole point is
  // that dismissing an overlap costs a sentence of justification.
  return declaresIndependence(a, b.id) || declaresIndependence(b, a.id)
}

function declaresIndependence(finding: ReadFinding, otherId: string): boolean {
  return finding.independentOf.some(entry => entry.findingId === otherId && entry.reason.trim().length > 0)
}

function readFinding(entry: Record<string, unknown>, index: number): ReadFinding {
  const id = str(entry['id'])
  const predictedMetric = isRecord(entry['predictedMetric']) ? entry['predictedMetric'] : undefined

  return {
    index,
    label: id ? `Finding "${id}"` : `findings[${index}]`,
    id,
    title: str(entry['title']),
    category: str(entry['category']),
    severity: str(entry['severity']),
    evidenceJobIds: unique(list(entry['evidence']).map(item => (isRecord(item) ? str(item['jobId']) : ''))),
    targetPaths: unique(strList(entry['targetPaths'])),
    rootCause: str(entry['rootCause']),
    deliveryGroup: str(entry['deliveryGroup']),
    independentOf: list(entry['independentOf']).flatMap(item =>
      isRecord(item) && str(item['findingId'])
        ? [{ findingId: str(item['findingId']), reason: str(item['reason']) }]
        : [],
    ),
    hasPredictedMetric: predictedMetric !== undefined && str(predictedMetric['name']).length > 0,
    predictedMetricName: predictedMetric ? str(predictedMetric['name']) : '',
  }
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const shared = intersect(a, b).length
  const union = new Set([...a, ...b]).size
  return union === 0 ? 0 : shared / union
}

function intersect(a: string[], b: string[]): string[] {
  const other = new Set(b)
  return a.filter(item => other.has(item))
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(value => value.length > 0))]
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function strList(value: unknown): string[] {
  return list(value).map(item => (typeof item === 'string' ? item.trim() : ''))
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
