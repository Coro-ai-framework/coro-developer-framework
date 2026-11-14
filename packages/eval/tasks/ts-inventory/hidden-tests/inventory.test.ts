import { describe, expect, it } from 'vitest'
import { CsvError, InsufficientStockError, Inventory, InventoryError } from '../src/index'
import type { LowStockEvent } from '../src/index'

function stocked(levels: Record<string, number>): Inventory {
  const inventory = new Inventory()
  for (const [sku, quantity] of Object.entries(levels)) inventory.add(sku, quantity)
  return inventory
}

function catchError(fn: () => void): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

describe('reservations', () => {
  it('holds stock without changing it', () => {
    const inventory = stocked({ A: 10, B: 4 })
    inventory.reserve('o1', [
      { sku: 'A', quantity: 3 },
      { sku: 'B', quantity: 4 },
    ])
    expect(inventory.stock('A')).toBe(10)
    expect(inventory.available('A')).toBe(7)
    expect(inventory.available('B')).toBe(0)
    expect(inventory.available('unknown')).toBe(0)
  })

  it('adds up lines for the same SKU', () => {
    const inventory = stocked({ A: 10 })
    inventory.reserve('o1', [
      { sku: 'A', quantity: 3 },
      { sku: 'A', quantity: 4 },
    ])
    expect(inventory.available('A')).toBe(3)
  })

  it('lets several orders hold stock at once', () => {
    const inventory = stocked({ A: 10 })
    inventory.reserve('o1', [{ sku: 'A', quantity: 4 }])
    inventory.reserve('o2', [{ sku: 'A', quantity: 5 }])
    expect(inventory.available('A')).toBe(1)
  })

  it('is all-or-nothing and names every short SKU in order of first appearance', () => {
    const inventory = stocked({ A: 5, B: 1, C: 9 })
    const error = catchError(() =>
      inventory.reserve('o1', [
        { sku: 'C', quantity: 2 },
        { sku: 'B', quantity: 3 },
        { sku: 'A', quantity: 2 },
        { sku: 'Z', quantity: 1 },
        { sku: 'B', quantity: 1 },
      ]),
    )
    expect(error).toBeInstanceOf(InsufficientStockError)
    expect(error).toBeInstanceOf(InventoryError)
    expect((error as InsufficientStockError).shortages).toEqual([
      { sku: 'B', requested: 4, available: 1 },
      { sku: 'Z', requested: 1, available: 0 },
    ])
    expect(inventory.available('A')).toBe(5)
    expect(inventory.available('B')).toBe(1)
    expect(inventory.available('C')).toBe(9)
  })

  it('counts what other orders already hold when judging a shortage', () => {
    const inventory = stocked({ A: 5 })
    inventory.reserve('o1', [{ sku: 'A', quantity: 4 }])
    const error = catchError(() => inventory.reserve('o2', [{ sku: 'A', quantity: 2 }]))
    expect((error as InsufficientStockError).shortages).toEqual([{ sku: 'A', requested: 2, available: 1 }])
  })

  it('rejects bad input with a plain InventoryError', () => {
    const inventory = stocked({ A: 5 })
    inventory.reserve('o1', [{ sku: 'A', quantity: 1 }])

    const noLines = catchError(() => inventory.reserve('o2', []))
    const zero = catchError(() => inventory.reserve('o2', [{ sku: 'A', quantity: 0 }]))
    const fraction = catchError(() => inventory.reserve('o2', [{ sku: 'A', quantity: 1.5 }]))
    const duplicate = catchError(() => inventory.reserve('o1', [{ sku: 'A', quantity: 1 }]))
    for (const error of [noLines, zero, fraction, duplicate]) {
      expect(error).toBeInstanceOf(InventoryError)
      expect(error).not.toBeInstanceOf(InsufficientStockError)
    }
    expect(inventory.available('A')).toBe(4)
  })

  it('checks the input before looking at stock', () => {
    const inventory = stocked({ A: 1 })
    inventory.reserve('o1', [{ sku: 'A', quantity: 1 }])
    const error = catchError(() => inventory.reserve('o1', [{ sku: 'A', quantity: 99 }]))
    expect(error).not.toBeInstanceOf(InsufficientStockError)
    const bad = catchError(() =>
      inventory.reserve('o2', [
        { sku: 'A', quantity: 99 },
        { sku: 'B', quantity: -1 },
      ]),
    )
    expect(bad).not.toBeInstanceOf(InsufficientStockError)
  })

  it('release gives the units back and leaves stock alone', () => {
    const inventory = stocked({ A: 10 })
    inventory.reserve('o1', [{ sku: 'A', quantity: 6 }])
    inventory.release('o1')
    expect(inventory.stock('A')).toBe(10)
    expect(inventory.available('A')).toBe(10)
  })

  it('commit removes the units from stock for good', () => {
    const inventory = stocked({ A: 10, B: 2 })
    inventory.reserve('o1', [
      { sku: 'A', quantity: 6 },
      { sku: 'B', quantity: 2 },
    ])
    inventory.commit('o1')
    expect(inventory.stock('A')).toBe(4)
    expect(inventory.available('A')).toBe(4)
    expect(inventory.stock('B')).toBe(0)
    expect(inventory.skus()).toEqual(['A', 'B'])
  })

  it('ends the reservation on release or commit, so neither works twice', () => {
    const inventory = stocked({ A: 10 })
    inventory.reserve('o1', [{ sku: 'A', quantity: 1 }])
    inventory.release('o1')
    expect(() => inventory.release('o1')).toThrow(InventoryError)
    expect(() => inventory.commit('o1')).toThrow(InventoryError)

    inventory.reserve('o2', [{ sku: 'A', quantity: 1 }])
    inventory.commit('o2')
    expect(() => inventory.commit('o2')).toThrow(InventoryError)
    expect(() => inventory.release('o2')).toThrow(InventoryError)
    expect(inventory.stock('A')).toBe(9)
  })

  it('lets an order id be reused once its reservation has ended', () => {
    const inventory = stocked({ A: 10 })
    inventory.reserve('o1', [{ sku: 'A', quantity: 2 }])
    inventory.release('o1')
    inventory.reserve('o1', [{ sku: 'A', quantity: 3 }])
    expect(inventory.available('A')).toBe(7)
  })

  it('throws for an order that never reserved anything', () => {
    const inventory = stocked({ A: 1 })
    expect(() => inventory.release('nope')).toThrow(InventoryError)
    expect(() => inventory.commit('nope')).toThrow(InventoryError)
  })

  it('stops remove from taking reserved units', () => {
    const inventory = stocked({ A: 10 })
    inventory.reserve('o1', [{ sku: 'A', quantity: 8 }])
    expect(() => inventory.remove('A', 3)).toThrow(InventoryError)
    expect(inventory.stock('A')).toBe(10)
    inventory.remove('A', 2)
    expect(inventory.stock('A')).toBe(8)
    expect(inventory.available('A')).toBe(0)
  })
})

describe('reorder alerts', () => {
  function watch(inventory: Inventory): LowStockEvent[] {
    const events: LowStockEvent[] = []
    inventory.onLowStock(event => events.push(event))
    return events
  }

  it('alerts when a removal takes availability to the reorder point', () => {
    const inventory = stocked({ A: 10 })
    inventory.setReorderPoint('A', 4)
    const events = watch(inventory)
    inventory.remove('A', 5)
    expect(events).toEqual([])
    inventory.remove('A', 1)
    expect(events).toEqual([{ sku: 'A', available: 4, reorderPoint: 4 }])
  })

  it('alerts when a drop jumps past the reorder point', () => {
    const inventory = stocked({ A: 10 })
    inventory.setReorderPoint('A', 4)
    const events = watch(inventory)
    inventory.remove('A', 8)
    expect(events).toEqual([{ sku: 'A', available: 2, reorderPoint: 4 }])
  })

  it('alerts when a reservation takes availability to the reorder point', () => {
    const inventory = stocked({ A: 10 })
    inventory.setReorderPoint('A', 3)
    const events = watch(inventory)
    inventory.reserve('o1', [{ sku: 'A', quantity: 7 }])
    expect(events).toEqual([{ sku: 'A', available: 3, reorderPoint: 3 }])
  })

  it('alerts on the crossing only', () => {
    const inventory = stocked({ A: 10 })
    inventory.setReorderPoint('A', 5)
    const events = watch(inventory)
    inventory.remove('A', 5)
    inventory.remove('A', 1)
    inventory.remove('A', 1)
    expect(events).toHaveLength(1)
  })

  it('alerts again after availability has risen above the point and dropped once more', () => {
    const inventory = stocked({ A: 10 })
    inventory.setReorderPoint('A', 5)
    const events = watch(inventory)
    inventory.remove('A', 6)
    expect(events).toHaveLength(1)
    inventory.add('A', 1) // available 5: at the point, not above it
    inventory.remove('A', 1)
    expect(events).toHaveLength(1)
    inventory.add('A', 10) // available 14
    inventory.remove('A', 9) // available 5
    expect(events).toHaveLength(2)
    expect(events[1]).toEqual({ sku: 'A', available: 5, reorderPoint: 5 })
  })

  it('treats a release as a rise that re-arms the alert', () => {
    const inventory = stocked({ A: 10 })
    inventory.setReorderPoint('A', 5)
    const events = watch(inventory)
    inventory.reserve('o1', [{ sku: 'A', quantity: 6 }])
    expect(events).toHaveLength(1)
    inventory.release('o1')
    inventory.reserve('o2', [{ sku: 'A', quantity: 6 }])
    expect(events).toHaveLength(2)
  })

  it('does not alert on a commit, which leaves availability unchanged', () => {
    const inventory = stocked({ A: 10 })
    inventory.setReorderPoint('A', 5)
    inventory.reserve('o1', [{ sku: 'A', quantity: 4 }]) // available 6, still above
    const events = watch(inventory)
    inventory.commit('o1')
    expect(inventory.available('A')).toBe(6)
    expect(events).toEqual([])
  })

  it('never alerts for a SKU without a reorder point', () => {
    const inventory = stocked({ A: 10, B: 10 })
    inventory.setReorderPoint('B', 1)
    const events = watch(inventory)
    inventory.remove('A', 10)
    expect(events).toEqual([])
  })

  it('does not alert when the point is set, and compares later changes with the new point', () => {
    const inventory = stocked({ A: 10 })
    const events = watch(inventory)
    inventory.remove('A', 8) // available 2, no point yet
    inventory.setReorderPoint('A', 5) // 2 is already below it
    expect(events).toEqual([])
    inventory.remove('A', 1) // 2 -> 1, not a crossing
    expect(events).toEqual([])
    inventory.add('A', 9) // available 10
    inventory.setReorderPoint('A', 8)
    inventory.remove('A', 2) // 10 -> 8, crossing the new point
    expect(events).toEqual([{ sku: 'A', available: 8, reorderPoint: 8 }])
  })

  it('supports a reorder point of zero', () => {
    const inventory = stocked({ A: 2 })
    inventory.setReorderPoint('A', 0)
    const events = watch(inventory)
    inventory.remove('A', 1)
    expect(events).toEqual([])
    inventory.remove('A', 1)
    expect(events).toEqual([{ sku: 'A', available: 0, reorderPoint: 0 }])
  })

  it('reports a multi-SKU reservation in line order, with final availability', () => {
    const inventory = stocked({ A: 5, B: 5, C: 5 })
    for (const sku of ['A', 'B', 'C']) inventory.setReorderPoint(sku, 2)
    const seen: Array<{ event: LowStockEvent; availableNow: Record<string, number> }> = []
    inventory.onLowStock(event => {
      seen.push({
        event,
        availableNow: { A: inventory.available('A'), B: inventory.available('B'), C: inventory.available('C') },
      })
    })
    inventory.reserve('o1', [
      { sku: 'C', quantity: 4 },
      { sku: 'A', quantity: 4 },
      { sku: 'B', quantity: 1 },
      { sku: 'C', quantity: 1 },
    ])
    expect(seen.map(s => s.event.sku)).toEqual(['C', 'A'])
    expect(seen[0]!.event).toEqual({ sku: 'C', available: 0, reorderPoint: 2 })
    expect(seen[0]!.availableNow).toEqual({ A: 1, B: 4, C: 0 })
  })

  it('calls every handler, in registration order', () => {
    const inventory = stocked({ A: 5 })
    inventory.setReorderPoint('A', 2)
    const calls: string[] = []
    inventory.onLowStock(() => calls.push('first'))
    inventory.onLowStock(() => calls.push('second'))
    inventory.remove('A', 3)
    expect(calls).toEqual(['first', 'second'])
  })

  it('stops calling a handler once it has unsubscribed', () => {
    const inventory = stocked({ A: 10 })
    inventory.setReorderPoint('A', 5)
    const calls: string[] = []
    const stop = inventory.onLowStock(() => calls.push('gone'))
    inventory.onLowStock(() => calls.push('kept'))
    stop()
    inventory.remove('A', 6)
    expect(calls).toEqual(['kept'])
  })

  it('survives a handler that throws', () => {
    const inventory = stocked({ A: 10 })
    inventory.setReorderPoint('A', 5)
    const calls: string[] = []
    inventory.onLowStock(() => {
      throw new Error('boom')
    })
    inventory.onLowStock(() => calls.push('after'))
    expect(() => inventory.remove('A', 6)).not.toThrow()
    expect(calls).toEqual(['after'])
    expect(inventory.stock('A')).toBe(4)
  })

  it('validates the reorder point and the SKU', () => {
    const inventory = stocked({ A: 1 })
    expect(() => inventory.setReorderPoint('A', -1)).toThrow(InventoryError)
    expect(() => inventory.setReorderPoint('A', 1.5)).toThrow(InventoryError)
    expect(() => inventory.setReorderPoint('A', Number.NaN)).toThrow(InventoryError)
    expect(() => inventory.setReorderPoint('never-added', 2)).toThrow(InventoryError)
  })
})

describe('CSV export', () => {
  it('writes a header and one row per SKU, in sku order, ending with a newline', () => {
    const inventory = stocked({ B: 2, A: 5 })
    inventory.setReorderPoint('A', 3)
    expect(inventory.exportCsv()).toBe('sku,quantity,reorderPoint\nA,5,3\nB,2,\n')
  })

  it('writes just the header for an empty inventory', () => {
    expect(new Inventory().exportCsv()).toBe('sku,quantity,reorderPoint\n')
  })

  it('exports stock including reserved units, and zero-stock SKUs', () => {
    const inventory = stocked({ A: 5, B: 1 })
    inventory.reserve('o1', [{ sku: 'A', quantity: 4 }])
    inventory.remove('B', 1)
    expect(inventory.exportCsv()).toBe('sku,quantity,reorderPoint\nA,5,\nB,0,\n')
  })

  it('quotes fields that contain a comma or a quote', () => {
    const inventory = stocked({ 'bolt, m6': 3, 'the "big" one': 1, plain: 2 })
    expect(inventory.exportCsv()).toBe(
      'sku,quantity,reorderPoint\n"bolt, m6",3,\nplain,2,\n"the ""big"" one",1,\n',
    )
  })

  it('refuses a SKU with a line break', () => {
    const inventory = stocked({ 'two\nlines': 1 })
    expect(() => inventory.exportCsv()).toThrow(InventoryError)
  })
})

describe('CSV import', () => {
  it('builds an inventory from a CSV', () => {
    const inventory = Inventory.fromCsv('sku,quantity,reorderPoint\nA,5,3\nB,0,\n')
    expect(inventory.skus()).toEqual(['A', 'B'])
    expect(inventory.stock('A')).toBe(5)
    expect(inventory.stock('B')).toBe(0)
    expect(inventory.available('A')).toBe(5)
  })

  it('applies the reorder points it reads', () => {
    const inventory = Inventory.fromCsv('sku,quantity,reorderPoint\nA,10,6\n')
    const events: LowStockEvent[] = []
    inventory.onLowStock(event => events.push(event))
    inventory.remove('A', 4)
    expect(events).toEqual([{ sku: 'A', available: 6, reorderPoint: 6 }])
  })

  it('accepts Windows line endings and a missing final newline', () => {
    expect(Inventory.fromCsv('sku,quantity,reorderPoint\r\nA,1,\r\nB,2,\r\n').skus()).toEqual(['A', 'B'])
    expect(Inventory.fromCsv('sku,quantity,reorderPoint\nA,1,').stock('A')).toBe(1)
  })

  it('accepts a header on its own', () => {
    expect(Inventory.fromCsv('sku,quantity,reorderPoint\n').skus()).toEqual([])
    expect(Inventory.fromCsv('sku,quantity,reorderPoint').skus()).toEqual([])
  })

  it('reads quoted fields', () => {
    const inventory = Inventory.fromCsv('sku,quantity,reorderPoint\n"bolt, m6",3,\n"the ""big"" one",1,2\n')
    expect(inventory.skus()).toEqual(['bolt, m6', 'the "big" one'])
    expect(inventory.stock('bolt, m6')).toBe(3)
  })

  it('round-trips', () => {
    const original = stocked({ B: 2, A: 5, 'x,y': 7, 'q"q': 1 })
    original.setReorderPoint('A', 3)
    original.setReorderPoint('x,y', 0)
    const text = original.exportCsv()
    expect(Inventory.fromCsv(text).exportCsv()).toBe(text)
  })

  it('has no reservations after an import', () => {
    const inventory = Inventory.fromCsv('sku,quantity,reorderPoint\nA,5,\n')
    expect(() => inventory.release('anything')).toThrow(InventoryError)
    inventory.reserve('o1', [{ sku: 'A', quantity: 5 }])
    expect(inventory.available('A')).toBe(0)
  })

  function csvError(text: string): CsvError {
    const error = catchError(() => Inventory.fromCsv(text))
    expect(error).toBeInstanceOf(CsvError)
    expect(error).toBeInstanceOf(InventoryError)
    return error as CsvError
  }

  it('reports a wrong header on line 1', () => {
    expect(csvError('').line).toBe(1)
    expect(csvError('sku,qty,reorderPoint\nA,1,\n').line).toBe(1)
    expect(csvError('sku,quantity\nA,1\n').line).toBe(1)
    expect(csvError('A,1,\n').line).toBe(1)
  })

  it('reports a row with the wrong number of fields', () => {
    expect(csvError('sku,quantity,reorderPoint\nA,1,\nB,2\n').line).toBe(3)
    expect(csvError('sku,quantity,reorderPoint\nA,1,,\n').line).toBe(2)
  })

  it('reports an empty line in the middle', () => {
    expect(csvError('sku,quantity,reorderPoint\nA,1,\n\nB,2,\n').line).toBe(3)
  })

  it('reports an empty SKU', () => {
    expect(csvError('sku,quantity,reorderPoint\nA,1,\n,2,\n').line).toBe(3)
  })

  it('reports a quantity that is not plain digits', () => {
    for (const bad of ['', '-1', '1.5', 'abc', '+2', ' 3', '1e3']) {
      expect(csvError(`sku,quantity,reorderPoint\nA,${bad},\n`).line).toBe(2)
    }
  })

  it('reports a reorder point that is not plain digits', () => {
    for (const bad of ['-1', '2.5', 'x']) {
      expect(csvError(`sku,quantity,reorderPoint\nA,1,\nB,1,${bad}\n`).line).toBe(3)
    }
  })

  it('reports a repeated SKU on the line of the repeat', () => {
    expect(csvError('sku,quantity,reorderPoint\nA,1,\nB,1,\nA,2,\n').line).toBe(4)
  })

  it('reports misplaced or unclosed quotes', () => {
    expect(csvError('sku,quantity,reorderPoint\nA"B,1,\n').line).toBe(2)
    expect(csvError('sku,quantity,reorderPoint\nA,1,\n"unclosed,2,\n').line).toBe(3)
    expect(csvError('sku,quantity,reorderPoint\n"A"x,1,\n').line).toBe(2)
  })
})
