export interface User {
  id: string
  accountId: string
  name: string
  email: string
  role: 'admin' | 'member'
  createdAt: string
}

const USERS: User[] = [
  { id: 'u1', accountId: 'acme', name: 'Ada Lovelace', email: 'ada@acme.example', role: 'admin', createdAt: '2023-02-01T09:00:00Z' },
  { id: 'u2', accountId: 'acme', name: 'Grace Hopper', email: 'grace@acme.example', role: 'member', createdAt: '2023-03-14T12:30:00Z' },
  { id: 'u3', accountId: 'globex', name: 'Alan Turing', email: 'alan@globex.example', role: 'admin', createdAt: '2023-05-20T08:15:00Z' },
]

export function listUsers(accountId: string): User[] {
  return USERS.filter(user => user.accountId === accountId)
}
