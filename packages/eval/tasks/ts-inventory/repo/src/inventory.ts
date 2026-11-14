import { InventoryError } from './errors'

function assertQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new InventoryError(`quantity must be a positive whole number, got ${quantity}`)
  }
}

/** Stock levels for a warehouse, kept in memory. */
export class Inventory {
  private readonly stockBySku = new Map<string, number>()

  /** Add `quantity` units of `sku`, listing the SKU if it is new. */
  add(sku: string, quantity: number): void {
    assertQuantity(quantity)
    this.stockBySku.set(sku, this.stock(sku) + quantity)
  }

  /** Take `quantity` units of `sku` out of stock. The SKU stays listed, at 0 if need be. */
  remove(sku: string, quantity: number): void {
    assertQuantity(quantity)
    const current = this.stock(sku)
    if (quantity > current) {
      throw new InventoryError(`cannot remove ${quantity} of ${sku}: only ${current} in stock`)
    }
    this.stockBySku.set(sku, current - quantity)
  }

  /** Units on the shelf; 0 for a SKU that was never added. */
  stock(sku: string): number {
    return this.stockBySku.get(sku) ?? 0
  }

  /** Every SKU that has ever been added, sorted. */
  skus(): string[] {
    return [...this.stockBySku.keys()].sort()
  }
}
