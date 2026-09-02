import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/** Scroll only the container — never use scrollIntoView on inner nodes, or the window scrolls too. */
function scrollContainerToBottom(el: HTMLElement, behavior: ScrollBehavior = 'auto'): void {
  el.scrollTo({ top: el.scrollHeight, behavior })
}

function isScrolledToBottom(el: HTMLElement, thresholdPx = 64): boolean {
  const { scrollTop, scrollHeight, clientHeight } = el
  return scrollHeight - scrollTop - clientHeight <= thresholdPx
}

export function useStickToBottom<T extends HTMLElement>(deps: readonly unknown[]): {
  ref: RefObject<T | null>
  /** True while pinned to the bottom. */
  stuck: boolean
  /** Handler to attach to the scrollable element's onScroll. */
  onScroll: () => void
  /** Re-pin and smooth-scroll down. Wire to the Follow button. */
  scrollToBottom: () => void
} {
  const ref = useRef<T | null>(null)
  const [stuck, setStuck] = useState(true)
  const stuckRef = useRef(true)
  /** Skip one scroll-handler sync right after we programmatically scroll (some browsers coalesce events). */
  const programmaticScrollRef = useRef(false)

  useEffect(() => {
    stuckRef.current = stuck
  }, [stuck])

  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false
      return
    }
    const atBottom = isScrolledToBottom(el)
    stuckRef.current = atBottom
    setStuck(atBottom)
  }, [])

  const scrollToBottom = useCallback(() => {
    stuckRef.current = true
    setStuck(true)
    if (ref.current) {
      programmaticScrollRef.current = true
      scrollContainerToBottom(ref.current, 'smooth')
    }
  }, [])

  useEffect(() => {
    if (!stuck) return
    const id = requestAnimationFrame(() => {
      if (!stuckRef.current || !ref.current) return
      programmaticScrollRef.current = true
      scrollContainerToBottom(ref.current, 'auto')
    })
    return () => {
      cancelAnimationFrame(id)
    }
    // deps is the caller's content identity (items, filter, …).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stuck, ...deps])

  useEffect(() => {
    const el = ref.current
    if (!el || !stuck) return
    const ro = new ResizeObserver(() => {
      if (!ref.current || !stuckRef.current) return
      programmaticScrollRef.current = true
      scrollContainerToBottom(ref.current, 'auto')
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
    }
  }, [stuck])

  return { ref, stuck, onScroll, scrollToBottom }
}
