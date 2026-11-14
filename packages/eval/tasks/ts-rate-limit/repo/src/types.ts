export interface Request {
  method: string
  path: string
  /** Header names arrive in whatever case the caller used. */
  headers?: Record<string, string | undefined>
}

export interface Response {
  status: number
  /** Header names are always lower-case. */
  headers: Record<string, string>
  body: unknown
}
