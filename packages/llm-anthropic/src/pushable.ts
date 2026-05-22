import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/**
 * Wraps the Claude Agent SDK's `streamInput`-style stdin so callers can
 * keep pushing user-role messages after the kickoff prompt without
 * juggling pull/resolve plumbing.
 *
 * The runner uses this to inject a developer message mid-phase
 * (paired with `q.interrupt()` so the agent yields its current turn
 * and reads the new message immediately). The runner calls `close()`
 * once the phase's for-await loop has exited, which lets the SDK's
 * `streamInput` consumer complete and finally call `transport.endInput()`
 * cleanly.
 */
export interface PushableInput {
  iterable: AsyncIterable<SDKUserMessage>
  push(msg: SDKUserMessage): void
  close(): void
  /**
   * `true` when no buffered messages are waiting to be read by the SDK.
   * The executor keeps the pushable open for the whole phase and only
   * calls {@link PushableInput.close} in `finally` when the phase ends.
   */
  isEmpty(): boolean
  /** Whether {@link close} has been called (or the iterable ended). */
  isClosed(): boolean
}

/**
 * Build a {@link PushableInput} backed by an internal queue. Multiple
 * pushes before a single read are buffered FIFO. Pushing after `close()`
 * is a no-op. The iterable returns once the queue has drained AND
 * `close()` has been called — this matches the AsyncIterator contract
 * the SDK's `streamInput` for-await consumer expects.
 */
export function createPushableInput(): PushableInput {
  const buffer: SDKUserMessage[] = []
  // When a consumer is awaiting `next()` and the buffer is empty, we
  // park a resolver here. The next push() (or close()) calls it.
  let waiting: (() => void) | null = null
  let closed = false

  const wakeup = () => {
    const w = waiting
    waiting = null
    if (w) w()
  }

  const iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
      return {
        async next(): Promise<IteratorResult<SDKUserMessage>> {
          // Drain whatever's buffered first.
          while (true) {
            if (buffer.length > 0) {
              return { value: buffer.shift()!, done: false }
            }
            if (closed) {
              return { value: undefined, done: true }
            }
            await new Promise<void>((resolve) => { waiting = resolve })
          }
        },
        async return(): Promise<IteratorResult<SDKUserMessage>> {
          closed = true
          wakeup()
          return { value: undefined, done: true }
        },
      }
    },
  }

  return {
    iterable,
    push(msg: SDKUserMessage): void {
      // Re-open after an mistaken mid-phase close so steering messages
      // are not silently dropped (the SDK stdin must stay open for the
      // whole phase — see executor `result` handler).
      if (closed) closed = false
      buffer.push(msg)
      wakeup()
    },
    close(): void {
      if (closed) return
      closed = true
      wakeup()
    },
    isEmpty(): boolean {
      return buffer.length === 0
    },
    isClosed(): boolean {
      return closed
    },
  }
}
