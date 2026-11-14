export interface Invoice {
  id: string
  accountId: string
  amountCents: number
  currency: 'EUR' | 'USD'
  status: 'open' | 'paid' | 'void'
  issuedAt: string
  billingAddress: string
}

const INVOICES: Invoice[] = [
  { id: 'inv-1001', accountId: 'acme', amountCents: 120_000, currency: 'EUR', status: 'paid', issuedAt: '2024-01-03T00:00:00Z', billingAddress: '1 Analytical Way, London' },
  { id: 'inv-1002', accountId: 'acme', amountCents: 120_000, currency: 'EUR', status: 'open', issuedAt: '2024-02-03T00:00:00Z', billingAddress: '1 Analytical Way, London' },
  { id: 'inv-2001', accountId: 'globex', amountCents: 54_900, currency: 'USD', status: 'paid', issuedAt: '2024-01-09T00:00:00Z', billingAddress: '9 Enigma Road, Bletchley' },
]

export function listInvoices(accountId: string): Invoice[] {
  return INVOICES.filter(invoice => invoice.accountId === accountId)
}
