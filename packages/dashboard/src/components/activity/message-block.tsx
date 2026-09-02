const BRIEF_TAG_REGEX = /<brief>[\s\S]*?<\/brief>/gi
const BRIEF_READY_MESSAGES = [
  "Brief's ready — give it a look below and start the run when you're happy.",
  'Drafted a brief for you. Check it below and tweak anything before starting.',
  'Brief is below. Edit anything that feels off, then start the run.',
]

function hashString(input: string): number {
  let h = 0
  for (let i = 0; i < input.length; i++) {
    h = (h << 5) - h + input.charCodeAt(i)
    h |= 0
  }
  return h
}

function displayContent(role: 'user' | 'assistant', content: string): string {
  if (role !== 'assistant') return content
  if (!BRIEF_TAG_REGEX.test(content)) return content
  BRIEF_TAG_REGEX.lastIndex = 0
  const stripped = content.replace(BRIEF_TAG_REGEX, '').trim()
  if (stripped) return stripped
  const idx = Math.abs(hashString(content)) % BRIEF_READY_MESSAGES.length
  return BRIEF_READY_MESSAGES[idx]
}

export default function MessageBlock({
  role,
  text,
  streaming = false,
}: {
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
}) {
  const displayed = displayContent(role, text)
  return (
    <div
      className={
        role === 'user'
          ? 'whitespace-pre-wrap border-l-2 border-accent-500/40 pl-3.5 text-[13.5px] leading-[1.7] text-fg-muted'
          : 'whitespace-pre-wrap text-[13.5px] leading-[1.7] text-fg'
      }
    >
      {displayed}
      {streaming ? (
        <span
          className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.15em] bg-accent-400 animate-pulse-dot"
          aria-hidden
        />
      ) : null}
    </div>
  )
}
