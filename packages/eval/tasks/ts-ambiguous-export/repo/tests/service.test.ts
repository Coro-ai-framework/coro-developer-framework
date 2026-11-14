import { describe, expect, it } from 'vitest'
import { listInvoices, listUsers, usageReport } from '../src/index'

describe('account data', () => {
  it('lists only the users of one account', () => {
    expect(listUsers('acme').map(user => user.id)).toEqual(['u1', 'u2'])
  })

  it('lists only the invoices of one account', () => {
    expect(listInvoices('globex').map(invoice => invoice.id)).toEqual(['inv-2001'])
  })

  it('filters usage by month', () => {
    expect(usageReport('acme', '2024-02')).toHaveLength(2)
    expect(usageReport('acme', '2024-03')).toHaveLength(0)
  })
})
