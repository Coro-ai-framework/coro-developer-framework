export interface UsageRow {
  accountId: string
  day: string
  apiCalls: number
  storageMb: number
}

const USAGE: UsageRow[] = [
  { accountId: 'acme', day: '2024-02-01', apiCalls: 12_400, storageMb: 830 },
  { accountId: 'acme', day: '2024-02-02', apiCalls: 11_950, storageMb: 835 },
  { accountId: 'globex', day: '2024-02-01', apiCalls: 3_100, storageMb: 120 },
]

/** Daily usage for an account in one month (`YYYY-MM`). */
export function usageReport(accountId: string, month: string): UsageRow[] {
  return USAGE.filter(row => row.accountId === accountId && row.day.startsWith(month))
}
