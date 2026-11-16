export type User = { id: string; display_name: string }
export type Team = { id: string; name: string }
export type Project = {
  id: string; team_id: string; name: string; status: 'ACTIVE' | 'LOCKED'
  my_role: 'PROJECT_ADMIN' | 'PROJECT_MEMBER'
}
export type Page<T> = { items: T[] }
export type Summary = { balance: string; total_expense: string; total_income: string }
export type Expense = {
  type: 'EXPENSE'; amount: number; business_date: string; occurred_precision: 'DATE'
  category_id: string; expense: { merchant_name: string }; memo: string | null
}
export type Transaction = {
  id: string; version: number; amount: number; business_date: string; type: 'EXPENSE' | 'INCOME'
  category_id: string | null; expense: Expense['expense'] | null; memo: string | null
  registered_by: { user_id: string; display_name: string }
}
export type Budget = {
  budget_mode: 'SET' | 'UNSET'; target_budget: number | null; over_budget_policy: 'WARN' | 'BLOCK'
  warning_enabled: boolean; critical_enabled: boolean; version: number
}
export type Category = { id: string; name: string }
type Fault = { code: string; message: string; details?: { confirmation_token?: string } }

export class ApiError extends Error {
  readonly status: number
  readonly fault: Fault
  constructor(status: number, fault: Fault) {
    super(fault.message)
    this.status = status
    this.fault = fault
  }
}

let access = ''
export function setAccess(token: string) { access = token }

async function request(path: string, method: string, body?: object, key?: string, reauth?: string) {
  const headers = new Headers()
  if (access) headers.set('Authorization', 'Bearer ' + access)
  if (body && !(body instanceof FormData)) headers.set('Content-Type', 'application/json')
  if (key) headers.set('Idempotency-Key', key)
  if (reauth) headers.set('X-Reauthentication-Token', reauth)
  return fetch('/api/v1' + path, {
    method, headers, credentials: 'same-origin', body: body instanceof FormData ? body : body && JSON.stringify(body),
  })
}

export async function apiBlob(path: string, method = 'GET', reauth?: string): Promise<Blob> {
  const response = await request(path, method, undefined, undefined, reauth)
  if (!response.ok) throw new ApiError(response.status, (await response.json()).error)
  return response.blob()
}

export async function api<T>(path: string, method = 'GET', body?: object, key?: string, reauth?: string): Promise<T> {
  const response = await request(path, method, body, key, reauth)
  if (response.status === 204) return undefined as T
  const result = await response.json()
  if (!response.ok) throw new ApiError(response.status, result.error)
  return result.data
}

export const won = (value: number | string) => new Intl.NumberFormat('ko-KR').format(BigInt(value)) + '원'
export const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())




