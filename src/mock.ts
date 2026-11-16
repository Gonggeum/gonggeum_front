import { http, HttpResponse } from 'msw'
import { setupWorker } from 'msw/browser'
import { today } from './api'
import type { Budget, Expense, Project, Transaction, User } from './api'

const prefix = '/api/v1'
const storeKey = 'gonggeumi-demo-ledger-v1'
const sessionKey = 'gonggeumi-demo-session'
const demoUsers = ['총무', '참여자', '팀 없음', '장부 없음'].map((display_name, index) => ({
  id: String(index + 1), display_name, login_id: 'demo' + (index + 1),
  email: 'demo' + (index + 1) + '@example.test', profile_url: null, totp_enabled: false,
  has_active_team: index !== 2,
}))
const categories = [{ id: '501', name: '식비' }, { id: '502', name: '운영비' }]
const team = { id: '201', name: '공금이 데모팀' }
const baseBudget: Budget = {
  budget_mode: 'UNSET', target_budget: null, over_budget_policy: 'WARN',
  warning_enabled: true, critical_enabled: true, version: 0,
}
type Receipt = { signature: string; data: object; status: number }
type Ledger = { configured?: Record<string, boolean>; rows: (Transaction & { project_id: string; deleted?: boolean; attachments?: DemoAttachment[] })[]; budgets: Record<string, Budget>; receipts: Record<string, Receipt>; nextId: number }
const initial = (): Ledger => ({
  budgets: { '301': baseBudget, '302': baseBudget }, receipts: {}, nextId: 7002,
  rows: [{ id: '7001', project_id: '301', version: 1, type: 'INCOME', amount: 200000,
    business_date: today(), category_id: null, expense: null, memo: '초기 공금',
    registered_by: { user_id: '1', display_name: '총무' } }],
})
const read = (): Ledger => {
  const stored = localStorage.getItem(storeKey)
  return stored ? JSON.parse(stored) : initial()
}
const write = (data: Ledger) => localStorage.setItem(storeKey, JSON.stringify(data))
type Session = { userId: string; sid: string }
let access: { token: string; sid: string } | undefined
const session = (): Session | null => JSON.parse(localStorage.getItem(sessionKey) ?? 'null')
function current(request: Request) {
  const active = session()
  if (active?.sid !== access?.sid || !access || request.headers.get('Authorization') !== 'Bearer ' + access.token) return
  return demoUsers.find(user => user.id === active?.userId)
}
function auth(active: Session) {
  access = { token: crypto.randomUUID(), sid: active.sid }
  return ok({ access_token: access.token, session_id: active.sid, auth_status: 'AUTHENTICATED',
    token_type: 'Bearer', expires_in: 7200, user: demoUsers.find(user => user.id === active.userId),
    next_action: 'TEAM_SELECT', invite_context: null })
}
function ok(data: unknown, status = 200, replayed = false) {
  const request_id = crypto.randomUUID()
  return HttpResponse.json({ data, meta: { request_id, replayed } }, { status, headers: {
    'Cache-Control': 'private, no-store', 'X-Request-ID': request_id,
    ...(replayed ? { 'Idempotency-Replayed': 'true' } : {}),
  } })
}
function fail(status: number, code: string, message: string, details = {}) {
  const request_id = crypto.randomUUID()
  return HttpResponse.json({ error: { code, message, details, retryable: status >= 500 }, request_id },
    { status, headers: { 'X-Request-ID': request_id, 'Cache-Control': 'private, no-store' } })
}
const unauth = () => fail(401, 'UNAUTHENTICATED', '다시 로그인해 주세요.')
const missing = () => fail(404, 'NOT_FOUND', '접근할 수 없는 장부 또는 거래입니다.')
const forbidden = () => fail(403, 'FORBIDDEN', '이 작업을 할 권한이 없습니다.')
const conflict = () => fail(409, 'VERSION_CONFLICT', '다른 변경이 저장되었습니다. 최신 값을 확인해 주세요.')
const invalid = () => fail(400, 'VALIDATION_ERROR', '입력값을 확인해 주세요.')
function project(id: string, user: User): Project | undefined {
  if (!['301', '302'].includes(id) || !['1', '2'].includes(user.id) ||
      localStorage.getItem('gonggeumi-demo-revoked') === user.id) return
  return { id, team_id: team.id, name: id === '301' ? '행사 운영 장부' : '마감된 장부',
    status: id === '301' ? 'ACTIVE' : 'LOCKED', my_role: user.id === '1' ? 'PROJECT_ADMIN' : 'PROJECT_MEMBER' }
}
const page = <T,>(items: T[]) => ({ items, page: { has_next: false, next_cursor: null, limit: 20 } })
function rows(ledger: Ledger, id: string) {
  return ledger.rows.filter(row => row.project_id === id && !row.deleted)
    .sort((a, b) => b.business_date.localeCompare(a.business_date) || Number(b.id) - Number(a.id))
}
function totals(items: Transaction[]) {
  let income = 0n
  let expense = 0n
  for (const row of items) {
    if (row.type === 'INCOME') income += BigInt(row.amount)
    else expense += BigInt(row.amount)
  }
  return { total_income: String(income), total_expense: String(expense), balance: String(income - expense) }
}
const tokens = new Map<string, { fingerprint: string; expires: number }>()
function confirm(token: string | undefined, fingerprint: string, reasons: string[], details: object) {
  if (!reasons.length) return
  const known = token && tokens.get(token)
  if (known && known.fingerprint === fingerprint && known.expires > Date.now()) return
  const confirmation_token = crypto.randomUUID()
  tokens.set(confirmation_token, { fingerprint, expires: Date.now() + 300_000 })
  return fail(409, token ? 'CONFIRMATION_STALE' : 'CONFIRMATION_REQUIRED',
    '저장에 따른 영향을 확인해 주세요.', { ...details, reasons, confirmation_token, expires_in: 300 })
}
const lock = () => fail(409, 'PROJECT_LOCKED', '마감된 장부입니다.')
async function ledgerRequest(request: Request, id: string, resource: string, txId?: string, displayFileId?: string) {
  const user = current(request)
  if (!user) return unauth()
  const p = project(id, user)
  if (!p) return missing()
  const method = request.method
  const url = new URL(request.url)
  const body = method === 'POST' || method === 'PUT' ? await request.json() as Record<string, unknown> : {}
  const ledger = read()
  const all = rows(ledger, id)
  const summary = totals(all)
  const budget = ledger.budgets[id]
  const transaction = ledger.rows.find(row => row.project_id === id && row.id === txId)
  if (method === 'GET') {
    if (resource === 'project') return ok(p)
    if (resource === 'categories') return ok(page(categories))
    if (resource === 'members') return ok(page(demoUsers.slice(0, 2).flatMap(member => {
      const membership = project(id, member)
      if (!membership) return []
      return [{
        id: id + member.id, team_member_id: team.id + member.id,
        user: { user_id: member.id, display_name: member.display_name, status: 'ACTIVE', profile_url: null },
        role: membership.my_role, status: 'ACTIVE', joined_at: '2026-01-01T00:00:00Z', version: 1,
      }]
    })))
    if (resource === 'budget') return ok(budget)
    if (txId) return transaction?.deleted ? fail(410, 'TRANSACTION_DELETED', '삭제된 거래입니다.') : transaction ? ok(transaction) : missing()
    const query = url.searchParams.get('q')?.toLowerCase()
    const type = url.searchParams.get('type')
    const from = url.searchParams.get('date_from')
    const to = url.searchParams.get('date_to')
    const categoryIds = url.searchParams.get('category_ids')?.split(',')
    const authorIds = url.searchParams.get('registered_by_user_ids')?.split(',')
    if (from && to && from > to) return fail(400, 'VALIDATION_ERROR', '시작일은 종료일보다 늦을 수 없습니다.')
    const items = all.filter(row => (!type || row.type === type) &&
      (!authorIds || authorIds.includes(row.registered_by.user_id)) &&
      (!from || row.business_date >= from) && (!to || row.business_date <= to) &&
      (!categoryIds || row.type !== 'EXPENSE' || categoryIds.includes(row.category_id ?? '')) && (!query ||
      [row.expense?.merchant_name, row.memo].some(value => value?.toLowerCase().includes(query))))
    const limit = resource === 'dashboard' ? 5 : 20
    const offset = Number(url.searchParams.get('cursor') ?? 0)
    if (!Number.isSafeInteger(offset) || offset < 0) return invalid()
    const next = offset + limit
    if (url.searchParams.get('sort') === 'TIME_ASC' && from && from === to) items.reverse()
    const list = { items: items.slice(offset, next), summary: totals(items),
      page: { has_next: next < items.length, next_cursor: next < items.length ? String(next) : null, limit } }
    return resource === 'dashboard' ? ok({ project: p, summary, recent_transactions: list }) : ok(list)
  }
  if (p.status === 'LOCKED') return lock()
  const admin = p.my_role === 'PROJECT_ADMIN'
  if (resource === 'budget' && !admin) return forbidden()
  if (txId && !transaction) return missing()
  if (transaction && !admin && (transaction.type !== 'EXPENSE' || transaction.registered_by.user_id !== user.id)) return forbidden()
  const key = request.headers.get('Idempotency-Key')
  if (!key || !/^[0-9a-f-]{36}$/i.test(key)) return invalid()
  const { confirmation_token, ...payload } = body
  const signature = JSON.stringify([method, url.pathname, url.search, payload])
  const receiptKey = user.id + ':' + key
  const existing = ledger.receipts[receiptKey]
  if (existing) return existing.signature === signature ? ok(existing.data, existing.status, true) :
    fail(409, 'IDEMPOTENCY_KEY_REUSED', '이미 다른 요청에 사용한 저장 키입니다.')
  const save = (data: object, status = 200) => {
    ledger.receipts[receiptKey] = { signature, data, status }
    write(ledger)
    return ok(data, status)
  }
  const token = typeof confirmation_token === 'string' ? confirmation_token : undefined
  const expense = BigInt(summary.total_expense)
  const fingerprint = JSON.stringify([user.id, session()?.sid, key, signature, budget.version, summary.total_expense])
  if (resource === 'budget') {
    if (body.version !== budget.version) return conflict()
    const unset = body.budget_mode === 'UNSET'
    const target = body.target_budget
    if (unset ? target != null || body.over_budget_policy !== undefined || body.warning_enabled !== undefined || body.critical_enabled !== undefined : body.budget_mode !== 'SET' || !Number.isInteger(target) ||
        Number(target) < 0 || Number(target) > 1_000_000_000) return invalid()
    const policy = body.over_budget_policy ?? budget.over_budget_policy
    if (policy !== 'WARN' && policy !== 'BLOCK') return invalid()
    const next: Budget = { ...budget, budget_mode: unset ? 'UNSET' : 'SET',
      target_budget: unset ? null : Number(target), over_budget_policy: policy,
      warning_enabled: typeof body.warning_enabled === 'boolean' ? body.warning_enabled : budget.warning_enabled,
      critical_enabled: typeof body.critical_enabled === 'boolean' ? body.critical_enabled : budget.critical_enabled }
    if (JSON.stringify(next) === JSON.stringify(budget)) return save({ budget, summary, changed: false, change_type: null })
    const configuredBefore = budget.target_budget !== null || !!ledger.configured?.[id]
    if (configuredBefore && next.target_budget !== budget.target_budget &&
        !(typeof body.reason === 'string' && body.reason.trim())) return invalid()
    const reasons = []
    if (unset) reasons.push('BUDGET_UNSET')
    else if (expense > BigInt(Number(target))) reasons.push('EXISTING_OVER_BUDGET')
    const confirmation = confirm(token, fingerprint, reasons, { current_expense: String(expense), target_budget: next.target_budget })
    if (confirmation) return confirmation

    if (!unset) ledger.configured = { ...ledger.configured, [id]: true }
    ledger.budgets[id] = { ...next, version: budget.version + 1 }
    return save({ budget: ledger.budgets[id], summary, changed: true,
      change_type: unset ? 'UNSET' : budget.target_budget === null ? (configuredBefore ? 'RESET' : 'INITIAL_SET') : next.target_budget === budget.target_budget ? 'SETTINGS_CHANGED' : 'AMOUNT_CHANGED' })
  }
  if (transaction?.deleted) return fail(410, 'TRANSACTION_DELETED', '삭제된 거래입니다.')
  if (transaction && (method === 'DELETE' ? url.searchParams.get('version') !== String(transaction.version) :
    body.version !== transaction.version)) return conflict()
  if (method === 'DELETE' && transaction) {
    transaction.deleted = true
    transaction.version++
    return save({ id: transaction.id, status: 'DELETED', version: transaction.version, summary: totals(rows(ledger, id)) })
  }
  const input = body as unknown as Expense
  if (transaction && input.type !== transaction.type) return fail(409, 'TRANSACTION_TYPE_IMMUTABLE', '거래 유형은 변경할 수 없습니다.')
  if (input.type !== 'EXPENSE' || !Number.isInteger(input.amount) || input.amount < 1 || input.amount > 1_000_000_000 ||
      !input.expense?.merchant_name?.trim() || !categories.some(category => category.id === input.category_id) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(input.business_date)) return invalid()
  if (input.business_date > today()) return fail(400, 'FUTURE_BUSINESS_DATE', '미래 날짜는 선택할 수 없습니다.')
  const projected = expense + BigInt(input.amount - (transaction?.amount ?? 0))
  const reasons = []
  if (budget.target_budget !== null && projected > expense && projected > BigInt(budget.target_budget)) {
    if (budget.over_budget_policy === 'BLOCK') return fail(409, 'BUDGET_EXCEEDED', '목표 예산을 초과하여 저장할 수 없습니다.')
    reasons.push('OVER_BUDGET')
  }
  if (input.business_date < '2020-01-01' || input.business_date > '2099-12-31') reasons.push('OUTSIDE_PROJECT_PERIOD')
  const confirmation = confirm(token, fingerprint, reasons, { current_expense: String(expense),
    projected_expense: String(projected), target_budget: budget.target_budget })
  if (confirmation) return confirmation
  const attachments = displayFileId ? [{ id: displayFileId, project_file_id: displayFileId, attachment_type: 'RECEIPT', is_primary: true, sort_order: 0 }] :
    transaction?.attachments ?? []
  const saved = { ...transaction, id: transaction?.id ?? String(ledger.nextId++), project_id: id, type: input.type,
    amount: input.amount, business_date: input.business_date, occurred_precision: input.occurred_precision,
    expense: input.expense, category_id: input.category_id, memo: input.memo, items: [], attachments,
    registered_by: transaction?.registered_by ?? { user_id: user.id, display_name: user.display_name },
    version: (transaction?.version ?? 0) + 1 }
  ledger.rows = [...ledger.rows.filter(row => row.id !== saved.id), saved]
  return save({ transaction: saved, summary: totals(rows(ledger, id)) }, transaction ? 200 : 201)
}
type DemoAttachment = { id: string; project_file_id: string; attachment_type: string; is_primary: boolean; sort_order: number }
type DemoOcr = {
  id: string; project_id: string; owner: string; status: 'REVIEW' | 'CANCELED' | 'CONFIRMED'
  source_project_file_id: string; display_project_file_id: string
  structured_result: { schema_version: string; fields: { path: string; value: string | number }[] }
}
type DemoFile = { id: string; project_id: string; owner: string; display_project_file_id: string | null }
type DemoExport = {
  id: string; owner: string; projectId: string; status: 'PENDING' | 'COMPLETED' | 'CANCELED'; readyAt: number; csv: string
}
const files = new Map<string, DemoFile>()
const jobs = new Map<string, DemoOcr>()
const confirmingJobs = new Set<string>()
const exportsById = new Map<string, DemoExport>()
const nextJobId = () => crypto.getRandomValues(new BigUint64Array(1))[0].toString()

function dailyTotal(date: string, transactions: Transaction[], canCreate: boolean) {
  const items = transactions.filter(row => row.business_date === date)
  return { business_date: date, ...totals(items), transaction_count: items.length,
    in_project_period: date >= '2020-01-01' && date <= '2099-12-31', can_create: canCreate && date <= today() }
}

function authorizedProject(request: Request, id: string) {
  const user = current(request)
  if (!user) return { error: unauth() }
  const record = project(id, user)
  if (!record) return { error: missing() }
  return { user, record }
}

function readProjectReport(request: Request, id: string, resource: string) {
  const access = authorizedProject(request, id)
  if (access.error) return access.error
  const all = rows(read(), id)
  if (resource === 'settlement') {
    const category_statistics = categories.flatMap(category => {
      const items = all.filter(row => row.category_id === category.id && row.type === 'EXPENSE')
      return items.length ? [{ category_id: category.id, category_name: category.name, ...totals(items) }] : []
    })
    const daily_totals = [...new Set(all.map(row => row.business_date))].sort().map(date => dailyTotal(date, all, false))
    return ok({ summary: totals(all), category_statistics, daily_totals, scope: 'ALL_ACTIVE_TRANSACTIONS' })
  }
  const params = new URL(request.url).searchParams
  if (resource === 'calendar') {
    const month = params.get('month') ?? ''
    if (!/^20\d\d-(0[1-9]|1[0-2])$/.test(month)) return invalid()
    const [year, number] = month.split('-').map(Number)
    const length = new Date(Date.UTC(year, number, 0)).getUTCDate()
    const items = all.filter(row => row.business_date.startsWith(month + '-'))
    const days = Array.from({ length }, (_, index) => dailyTotal(month + '-' + String(index + 1).padStart(2, '0'), items, access.record.status === 'ACTIVE'))
    return ok({ month, timezone: 'Asia/Seoul', days, summary: totals(items) })
  }
  const from = params.get('date_from')
  const to = params.get('date_to')
  const type = params.get('attachment_type')
  const categoryIds = params.get('category_ids')?.split(',')
  if (from && to && from > to) return fail(400, 'VALIDATION_ERROR', '시작일은 종료일보다 늦을 수 없습니다.')
  return ok(page(all.filter(row => (!from || row.business_date >= from) && (!to || row.business_date <= to) &&
      (!categoryIds || categoryIds.includes(row.category_id ?? '')))
    .flatMap(row => (row.attachments ?? []).filter(attachment => !type || attachment.attachment_type === type)
      .map(attachment => ({ attachment, transaction_id: row.id, business_date: row.business_date, amount: row.amount,
        caption: row.expense?.merchant_name ?? row.memo ?? '증빙', registered_by: row.registered_by })))))
}

async function upload(request: Request, id: string) {
  const access = authorizedProject(request, id)
  if (access.error) return access.error
  if (access.record.status === 'LOCKED') return lock()
  const form = await request.formData()
  const file = form.get('file')
  if (!(file instanceof File) || !file.size || form.get('purpose') !== 'OCR_SOURCE') return invalid()
  if (file.size > 10 * 1024 * 1024) return fail(413, 'FILE_TOO_LARGE', '10MB 이하 파일을 선택해 주세요.')
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  const png = header.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10'
  const jpg = header[0] === 255 && header[1] === 216 && header[2] === 255
  const heic = new TextDecoder().decode(header.slice(4, 12)).match(/^ftyp(heic|heix|mif1)$/)
  if (!png && !jpg && !heic) return fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'JPG, PNG 또는 HEIC 영수증을 선택해 주세요.')
  const sourceId = nextJobId()
  const source = { id: sourceId, project_id: id, owner: access.user.id, display_project_file_id: nextJobId() }
  files.set(sourceId, source)
  return ok({ ...source, purpose: 'OCR_SOURCE', masking_status: 'READY' }, 202)
}

async function receiptPreview() {
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 205
  const context = canvas.getContext('2d')!
  context.fillStyle = '#fff'
  context.fillRect(0, 0, 320, 205)
  context.fillStyle = '#182330'
  context.font = 'bold 23px sans-serif'
  context.fillText('모의 마스킹 영수증', 22, 42)
  context.font = '17px sans-serif'
  context.fillText('데모 영수증 상점', 22, 86)
  context.fillText('결제 금액 12,500원', 22, 123)
  context.fillText('카드 번호', 22, 163)
  context.fillRect(103, 145, 166, 23)
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  return new HttpResponse(blob, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } })
}

async function fileAction(request: Request, id: string, fileId: string, content = false) {
  const access = authorizedProject(request, id)
  if (access.error) return access.error
  const linked = rows(read(), id).some(row => row.attachments?.some(attachment => attachment.project_file_id === fileId))
  const file = files.get(fileId) ?? [...files.values()].find(item => item.display_project_file_id === fileId)
  const display = linked || file?.display_project_file_id === fileId
  if ((!file || file.project_id !== id || file.owner !== access.user.id) && !linked) return missing()
  if (content) return display ? receiptPreview() : missing()
  if (request.method === 'DELETE') {
    if (linked || !file || rows(read(), id).some(row => row.attachments?.some(item => item.project_file_id === file.display_project_file_id))) {
      return fail(409, 'FILE_IN_USE', '거래에 연결된 증빙입니다.')
    }
    files.delete(file.id)
    return new HttpResponse(null, { status: 204 })
  }
  return ok({ ...file, id: fileId, purpose: display ? 'EVIDENCE' : 'OCR_SOURCE', masking_status: 'READY' })
}

async function ocrAction(request: Request, id: string, jobId?: string, action?: string) {
  const access = authorizedProject(request, id)
  if (access.error) return access.error
  if (!jobId) {
    if (access.record.status === 'LOCKED') return lock()
    const body = await request.json() as { source_project_file_id: string }
    const file = files.get(body.source_project_file_id)
    if (!file || file.owner !== access.user.id || file.project_id !== id || !file.display_project_file_id) return missing()
    const job: DemoOcr = {
      id: nextJobId(), project_id: id, owner: access.user.id, status: 'REVIEW',
      source_project_file_id: file.id, display_project_file_id: file.display_project_file_id,
      structured_result: { schema_version: '1.0', fields: [
        { path: '/expense/merchant_name', value: '데모 영수증 상점' },
        { path: '/amount', value: 12500 }, { path: '/business_date', value: today() },
      ] },
    }
    jobs.set(job.id, job)
    return ok(job, 202)
  }
  const job = jobs.get(jobId)
  if (!job || job.project_id !== id || job.owner !== access.user.id) return missing()
  if (!action) return ok(job)
  if (confirmingJobs.has(job.id)) return fail(409, 'REQUEST_IN_PROGRESS', '이미 저장 중입니다.')
  if (action === 'cancel' && job.status !== 'CONFIRMED') {
    job.status = 'CANCELED'
    files.delete(job.source_project_file_id)
    return ok(job)
  }
  if (action !== 'confirm' || job.status === 'CANCELED') return fail(409, 'OCR_NOT_REVIEWABLE', '검토할 수 없는 작업입니다.')
  if (job.status === 'CONFIRMED') {
    const receipt = read().receipts[access.user.id + ':' + request.headers.get('Idempotency-Key')]
    if (!receipt) return fail(409, 'OCR_ALREADY_CONFIRMED', '이미 거래로 확정했습니다.')
  }
  confirmingJobs.add(job.id)
  try {
    const body = await request.clone().json() as { attachments?: DemoAttachment[] }
    if (body.attachments?.length !== 1 || body.attachments[0].project_file_id !== job.display_project_file_id ||
        body.attachments[0].attachment_type !== 'RECEIPT') return invalid()
    const response = await ledgerRequest(request, id, 'transactions', undefined, job.display_project_file_id)
    if (response.ok) job.status = 'CONFIRMED'
    return response
  } finally { confirmingJobs.delete(job.id) }
}

function csvCell(value: string | number) {
  const raw = String(value)
  const safe = /^[\s]*[=+@-]/.test(raw) ? "'" + raw : raw
  return '"' + safe.replaceAll('"', '""') + '"'
}

type ExportIntent = { sid: string; action: string; target_id: string; body: string; expires: number }
const intents = new Map<string, ExportIntent>()
const grants = new Map<string, ExportIntent>()

async function startReauth(request: Request) {
  const user = current(request)
  const sid = session()?.sid
  if (!user || !sid) return unauth()
  const { action, target_type, target_id, request_body } = await request.json() as {
    action: string; target_type: string; target_id: string; request_body: object
  }
  const job = exportsById.get(target_id)
  const canCreate = action === 'SETTLEMENT_CREATE' && target_type === 'PROJECT' && project(target_id, user)?.my_role === 'PROJECT_ADMIN'
  const canDownload = action === 'SETTLEMENT_DOWNLOAD' && target_type === 'EXPORT_JOB' &&
    job?.owner === user.id && project(job.projectId, user)?.my_role === 'PROJECT_ADMIN'
  if (!canCreate && !canDownload) return forbidden()
  const reauth_context = crypto.randomUUID()
  const expires = Date.now() + 300_000
  intents.set(reauth_context, { sid, action, target_id, body: JSON.stringify(request_body), expires })
  return ok({ reauth_context, required_factors: ['PASSWORD'], expires_at: new Date(expires).toISOString() })
}

async function verifyReauth(request: Request) {
  if (!current(request)) return unauth()
  const body = await request.json() as { reauth_context: string; method: string; password: string }
  const intent = intents.get(body.reauth_context)
  if (!intent || intent.sid !== session()?.sid || intent.expires <= Date.now()) {
    return fail(401, 'TOKEN_INVALID', '재인증 요청이 만료되었습니다.')
  }
  if (body.method !== 'PASSWORD' || body.password !== 'demo') return fail(401, 'INVALID_CREDENTIALS', '데모 비밀번호를 확인해 주세요.')
  intents.delete(body.reauth_context)
  const reauth_token = crypto.randomUUID()
  grants.set(reauth_token, { ...intent, expires: Date.now() + 300_000 })
  return ok({ reauth_token, expires_in: 300 })
}

function consumeGrant(request: Request, action: string, target: string, body: object) {
  const token = request.headers.get('X-Reauthentication-Token') ?? ''
  const grant = grants.get(token)
  if (!grant || grant.sid !== session()?.sid || grant.expires <= Date.now() ||
      grant.action !== action || grant.target_id !== target || grant.body !== JSON.stringify(body)) return false
  grants.delete(token)
  return true
}

async function exportAction(request: Request, id: string, jobId?: string, action?: string) {
  const access = authorizedProject(request, id)
  if (access.error) return access.error
  if (access.record.my_role !== 'PROJECT_ADMIN') return forbidden()
  if (!jobId) {
    const body = await request.json() as { format: string; options: { date_from?: string; date_to?: string } }
    const { format, options } = body
    if (!consumeGrant(request, 'SETTLEMENT_CREATE', id, body)) return fail(403, 'REAUTH_REQUIRED', '파일 생성에는 재인증이 필요합니다.')
    if (format !== 'CSV' || !options) return invalid()
    const { date_from, date_to } = options
    if (date_from && date_to && date_from > date_to) return fail(400, 'VALIDATION_ERROR', '시작일은 종료일보다 늦을 수 없습니다.')
    const entries = rows(read(), id).filter(row => (!date_from || row.business_date >= date_from) && (!date_to || row.business_date <= date_to))
    const csv = ['거래일,유형,금액,상호,메모', ...entries.map(row =>
      [row.business_date, row.type, row.amount, row.expense?.merchant_name ?? '', row.memo ?? ''].map(csvCell).join(','))].join('\r\n')
    const job: DemoExport = { id: nextJobId(), owner: access.user.id, projectId: id, status: 'PENDING', readyAt: Date.now() + 500, csv }
    exportsById.set(job.id, job)
    return ok({ id: job.id, status: job.status, job_kind: 'SETTLEMENT', format: 'CSV' }, 202)
  }
  const job = exportsById.get(jobId)
  if (!job || job.projectId !== id || job.owner !== access.user.id) return missing()
  if (job.status === 'PENDING' && Date.now() >= job.readyAt) job.status = 'COMPLETED'
  if (action === 'cancel') {
    if (job.status !== 'PENDING') return fail(409, 'JOB_NOT_READY', '이미 처리된 작업입니다.')
    job.status = 'CANCELED'
  }
  if (action === 'download') {
    if (job.status !== 'COMPLETED') return fail(409, 'JOB_NOT_READY', '파일 생성이 완료되지 않았습니다.')
    if (!consumeGrant(request, 'SETTLEMENT_DOWNLOAD', job.id, {})) return fail(403, 'REAUTH_REQUIRED', '다운로드에는 재인증이 필요합니다.')
    return new HttpResponse('\uFEFF' + job.csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' } })
  }
  return ok({ id: job.id, status: job.status, job_kind: 'SETTLEMENT', format: 'CSV' })
}

const defaultPreferences = {
  in_app_enabled: true, push_enabled: true, team_invite_enabled: true, expense_created_enabled: true,
  budget_alert_enabled: true, role_changed_enabled: true, dnd_enabled: false, dnd_start_time: null as string | null,
  dnd_end_time: null as string | null, timezone: 'Asia/Seoul', version: 0,
}
async function accountSettings(request: Request, resource: string) {
  const user = current(request)
  if (!user) return unauth()
  if (resource === 'sessions') return ok(page([{ id: session()?.sid, is_current: true }]))
  if (resource === 'security-settings') return ok({ totp_enabled: user.totp_enabled, auto_lock_enabled: true, auto_lock_minutes: 15, version: 0 })
  const key = 'gonggeumi-demo-notification-settings:' + user.id
  const settings = JSON.parse(localStorage.getItem(key) ?? JSON.stringify(defaultPreferences)) as typeof defaultPreferences
  if (request.method === 'GET') return ok(settings)
  const input = await request.json() as Partial<typeof defaultPreferences>
  if (input.version !== settings.version) return conflict()
  const { version: _, ...changes } = input
  const next = { ...settings, ...changes, in_app_enabled: true, version: settings.version + 1 }
  const time = /^([01][0-9]|2[0-3]):[0-5][0-9]$/
  if (next.dnd_enabled && (!time.test(next.dnd_start_time ?? '') || !time.test(next.dnd_end_time ?? '') ||
      next.dnd_start_time === next.dnd_end_time)) {
    return fail(400, 'VALIDATION_ERROR', '방해금지 시작과 종료 시간을 다르게 입력해 주세요.')
  }
  localStorage.setItem(key, JSON.stringify(next))
  return ok(next)
}

type DemoNotice = { id: string; title: string; read_at: string | null }
async function notificationAction(request: Request, action = '', notificationId = '') {
  const user = current(request)
  if (!user) return unauth()
  const key = 'gonggeumi-demo-notifications:' + user.id
  const initial: DemoNotice[] = project('301', user) ? [{ id: '9001', title: '행사 운영 장부를 확인해 주세요.', read_at: null }] : []
  const items = JSON.parse(localStorage.getItem(key) ?? JSON.stringify(initial)) as DemoNotice[]
  const withTarget = (notice: DemoNotice) => {
    const accessible = !!project('301', user)
    return { ...notice, target_status: accessible ? 'AVAILABLE' : 'FORBIDDEN',
      target: accessible ? { project_id: '301' } : null }
  }
  const count = () => items.filter(item => !item.read_at).length
  if (request.method === 'GET') {
    if (action === 'unread-count') return ok({ unread_count: count() })
    const unreadOnly = new URL(request.url).searchParams.get('unread_only') === 'true'
    return ok({ ...page(items.filter(item => !unreadOnly || !item.read_at).map(withTarget)),
      unread_count: count(), snapshot_before_id: items[0]?.id ?? null })
  }
  if (action === 'read-all') {
    const { through_id } = await request.json() as { through_id: string }
    if (!/^\d+$/.test(through_id)) return invalid()
    for (const item of items) if (BigInt(item.id) <= BigInt(through_id)) item.read_at ??= new Date().toISOString()
    localStorage.setItem(key, JSON.stringify(items))
    return ok({ unread_count: count() })
  }
  const item = items.find(item => item.id === notificationId)
  if (!item) return missing()
  if (request.method === 'DELETE') {
    localStorage.setItem(key, JSON.stringify(items.filter(item => item.id !== notificationId)))
    return new HttpResponse(null, { status: 204 })
  }
  item.read_at ??= new Date().toISOString()
  localStorage.setItem(key, JSON.stringify(items))
  const notification = withTarget(item)
  return ok({ notification, unread_count: count(), next_action: notification.target ? 'OPEN_TARGET' : 'TEAM_SELECT' })
}

export const worker = setupWorker(
  http.post(prefix + '/auth/reauth/intents', ({ request }) => startReauth(request)),
  http.post(prefix + '/auth/reauth/verify', ({ request }) => verifyReauth(request)),
  ...['calendar', 'settlement', 'gallery'].map(resource =>
    http.get(prefix + '/projects/:id/' + resource, ({ request, params }) => readProjectReport(request, String(params.id), resource))),
  http.post(prefix + '/projects/:id/files', ({ request, params }) => upload(request, String(params.id))),
  http.get(prefix + '/projects/:id/files/:fileId/content', ({ request, params }) => fileAction(request, String(params.id), String(params.fileId), true)),
  http.get(prefix + '/projects/:id/files/:fileId', ({ request, params }) => fileAction(request, String(params.id), String(params.fileId))),
  http.delete(prefix + '/projects/:id/files/:fileId', ({ request, params }) => fileAction(request, String(params.id), String(params.fileId))),
  http.post(prefix + '/projects/:id/ocr-jobs', ({ request, params }) => ocrAction(request, String(params.id))),
  http.get(prefix + '/projects/:id/ocr-jobs/:jobId', ({ request, params }) => ocrAction(request, String(params.id), String(params.jobId))),
  http.post(prefix + '/projects/:id/ocr-jobs/:jobId/:action', ({ request, params }) => ocrAction(request, String(params.id), String(params.jobId), String(params.action))),
  http.post(prefix + '/projects/:id/exports', ({ request, params }) => exportAction(request, String(params.id))),
  http.get(prefix + '/projects/:id/exports/:jobId', ({ request, params }) => exportAction(request, String(params.id), String(params.jobId))),
  http.post(prefix + '/projects/:id/exports/:jobId/:action', ({ request, params }) => exportAction(request, String(params.id), String(params.jobId), String(params.action))),
  ...['security-settings', 'notification-settings', 'sessions'].map(resource =>
    http.get(prefix + '/me/' + resource, ({ request }) => accountSettings(request, resource))),
  http.patch(prefix + '/me/notification-settings', ({ request }) => accountSettings(request, 'notification-settings')),
  http.get(prefix + '/me/notifications', ({ request }) => notificationAction(request)),
  http.get(prefix + '/me/notifications/unread-count', ({ request }) => notificationAction(request, 'unread-count')),
  http.post(prefix + '/me/notifications/read-all', ({ request }) => notificationAction(request, 'read-all')),
  http.post(prefix + '/me/notifications/:id/read', ({ request, params }) => notificationAction(request, 'read', String(params.id))),
  http.delete(prefix + '/me/notifications/:id', ({ request, params }) => notificationAction(request, 'delete', String(params.id))),
  http.post(prefix + '/auth/login', async ({ request }) => {
    const input = await request.json() as { identifier: string; password: string }
    const user = demoUsers.find(user => [user.login_id, user.email].includes(input.identifier))
    if (!user || input.password !== 'demo') return fail(401, 'INVALID_CREDENTIALS', '데모 계정을 확인해 주세요.')
    const active = { userId: user.id, sid: crypto.randomUUID() }
    localStorage.setItem(sessionKey, JSON.stringify(active))
    return auth(active)
  }),
  http.post(prefix + '/auth/refresh', () => {
    if (localStorage.getItem('gonggeumi-demo-refresh-error') === '1') return fail(503, 'DEPENDENCY_UNAVAILABLE', '세션 확인을 잠시 사용할 수 없습니다.')
    const active = session()
    return active ? auth(active) : fail(401, 'TOKEN_INVALID', '로그인이 필요합니다.')
  }),
  http.post(prefix + '/auth/logout', () => {
    localStorage.removeItem(sessionKey)
    access = undefined
    return new HttpResponse(null, { status: 204 })
  }),
  http.post(prefix + '/auth/password-reset/complete', () => {
    localStorage.removeItem(sessionKey)
    access = undefined
    return new HttpResponse(null, { status: 204 })
  }),
  http.get(prefix + '/me', ({ request }) => {
    const user = current(request)
    return user ? ok(user) : unauth()
  }),
  http.get(prefix + '/teams', ({ request }) => {
    const user = current(request)
    return user ? ok(page(user.id === '3' ? [] : [team])) : unauth()
  }),
  http.get(prefix + '/teams/:teamId/projects', ({ request, params }) => {
    const user = current(request)
    if (!user) return unauth()
    if (params.teamId !== team.id || user.id === '3') return missing()
    return ok(page(['301', '302'].flatMap(id => {
      const item = project(id, user)
      return item ? [{ project: item, summary: totals(rows(read(), id)) }] : []
    })))
  }),
  http.post(prefix + '/invitations/resolve', async ({ request }) => {
    const input = await request.json() as { invite_token?: string; invite_context?: string }
    if (input.invite_token !== 'gonggeumi-demo-invite' && input.invite_context !== 'gonggeumi-demo-context') {
      return fail(410, 'INVITATION_EXPIRED', '만료되었거나 잘못된 초대입니다.')
    }
    return ok({ team_name: team.name, invite_context: 'gonggeumi-demo-context' })
  }),
  http.get(prefix + '/projects/:id', ({ request, params }) => ledgerRequest(request, String(params.id), 'project')),
  http.get(prefix + '/projects/:id/members', ({ request, params }) => ledgerRequest(request, String(params.id), 'members')),
  ...['budget', 'dashboard', 'categories', 'transactions'].map(resource =>
    http.all(prefix + '/projects/:id/' + resource, ({ request, params }) => ledgerRequest(request, String(params.id), resource))),
  http.all(prefix + '/projects/:id/transactions/:tx', ({ request, params }) =>
    ledgerRequest(request, String(params.id), 'transactions', String(params.tx))),
)









