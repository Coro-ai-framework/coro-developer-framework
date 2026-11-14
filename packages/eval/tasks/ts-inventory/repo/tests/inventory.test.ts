import { describe, expect, it } from 'vitest'
import { Inventory, InventoryError } from '../src/index'

describe('Inventory', () => {
  it('starts empty', () => {
    const inventory = new Inventory()
    expect(inventory.skus()).toEqual([])
    expect(inventory.stock('A')).toBe(0)
  })

  it('adds stock and lists the SKUs sorted', () => {
    const inventory = new Inventory()
    inventory.add('B', 2)
    inventory.add('A', 5)
    inventory.add('B', 3)
    expect(inventory.stock('A')).toBe(5)
    expect(inventory.stock('B')).toBe(5)
    expect(inventory.skus()).toEqual(['A', 'B'])
  })

  it('removes stock but keeps the SKU listed at zero', () => {
    const inventory = new Inventory()
    inventory.add('A', 3)
    inventory.remove('A', 3)
    expect(inventory.stock('A')).toBe(0)
    expect(inventory.skus()).toEqual(['A'])
  })

  it('refuses to remove more than is in stock', () => {
    const inventory = new Inventory()
    inventory.add('A', 2)
    expect(() => inventory.remove('A', 3)).toThrow(InventoryError)
    expect(inventory.stock('A')).toBe(2)
  })

  it('refuses quantities that are not positive whole numbers', () => {
    const inventory = new Inventory()
    expect(() => inventory.add('A', 0)).toThrow(InventoryError)
    expect(() => inventory.add('A', -1)).toThrow(InventoryError)
    expect(() => inventory.add('A', 1.5)).toThrow(InventoryError)
    expect(() => inventory.remove('A', 0)).toThrow(InventoryError)
  })
})
