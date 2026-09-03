// Plan mode's structured payloads (`<run>`, `<readiness>`, `<findings>`) are
// addressed to the dashboard, not the developer: the run and findings become
// cards and readiness drives the composer. Strip all three from the visible
// bubble.
const PAYLOAD_TAG_REGEX = /<(run|readiness|findings)>[\s\S]*?<\/\1>/gi
/** A payload block still arriving token by token — hide it as it lands. */
const PARTIAL_PAYLOAD_REGEX = /<(run|readiness|findings)>[\s\S]*$/i
const OPENING_TAGS = ['<run>', '<readiness>', '<findings>']
const RUN_READY_MESSAGES = [
  "Run's ready — give it a look below and start it when you're happy.",
  'Drafted the run for you. Check it below and tweak anything before starting.',
  'The run is below. Edit anything that feels off, then start it.',
]

function hashString(input: string): number {
  let h = 0
  for (let i = 0; i < input.length; i++) {
    h = (h << 5) - h + input.charCodeAt(i)
    h |= 0
  }
  return h
}

/**
 * Drops a trailing opening tag that is still being typed out, including the
 * half-written `<readi` case, so nothing flashes mid-stream.
 */
function trimPartialPayload(text: string): string {
  const withoutBlock = text.replace(PARTIAL_PAYLOAD_REGEX, '')
  if (withoutBlock !== text) return withoutBlock
  const openIndex = text.lastIndexOf('<')
  if (openIndex < 0) return text
  const tail = text.slice(openIndex).toLowerCase()
  return OPENING_TAGS.some(tag => tag.startsWith(tail)) ? text.slice(0, openIndex) : text
}

export function displayContent(role: 'user' | 'assistant', content: string): string {
  if (role !== 'assistant') return content
  PAYLOAD_TAG_REGEX.lastIndex = 0
  const stripped = trimPartialPayload(content.replace(PAYLOAD_TAG_REGEX, '')).trim()
  if (stripped) return stripped
  // Nothing but payload. A run block earns a line pointing at the card; a
  // findings card is the write-up itself, so a findings-only turn stays
  // silent; a readiness-only turn has genuinely nothing to say.
  if (!/<run>/i.test(content)) return ''
  const idx = Math.abs(hashString(content)) % RUN_READY_MESSAGES.length
  return RUN_READY_MESSAGES[idx]
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
