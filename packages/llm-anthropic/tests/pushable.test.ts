import { describe, expect, it } from 'vitest'
import { createPushableInput } from '../src/pushable'

describe('createPushableInput', () => {
  it('stays open after drain until explicit close', async () => {
    const pushable = createPushableInput()
    pushable.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      parent_tool_use_id: null,
    })

    const iter = pushable.iterable[Symbol.asyncIterator]()
    const first = await iter.next()
    expect(first.done).toBe(false)
    expect(pushable.isEmpty()).toBe(true)
    expect(pushable.isClosed()).toBe(false)

    const pending = iter.next()
    pushable.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'steer' }] },
      parent_tool_use_id: null,
    })
    const second = await pending
    expect(second.done).toBe(false)
    expect(pushable.isClosed()).toBe(false)

    pushable.close()
    expect(pushable.isClosed()).toBe(true)
    const done = await iter.next()
    expect(done.done).toBe(true)
  })

  it('reopens when pushed after close so steering is not dropped', async () => {
    const pushable = createPushableInput()
    pushable.close()
    expect(pushable.isClosed()).toBe(true)

    pushable.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'late steer' }] },
      parent_tool_use_id: null,
    })
    expect(pushable.isClosed()).toBe(false)
    expect(pushable.isEmpty()).toBe(false)
  })
})
