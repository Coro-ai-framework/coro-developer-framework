/**
 * Mirror a parent {@link AbortSignal} into a dedicated {@link AbortController}
 * for SDK `query()` options. The Claude Agent SDK accepts an
 * `abortController` on `Options` and tears down the subprocess when it
 * aborts — the runner's phase `stop()` trips the parent signal.
 */
export function linkAbortController(parent?: AbortSignal): AbortController | undefined {
  if (!parent) return undefined
  const linked = new AbortController()
  if (parent.aborted) {
    linked.abort(parent.reason)
    return linked
  }
  parent.addEventListener('abort', () => linked.abort(parent.reason), { once: true })
  return linked
}
