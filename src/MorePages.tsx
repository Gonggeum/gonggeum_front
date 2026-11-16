import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useLocation, useNavigate, useOutletContext, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, apiBlob, ApiError, today, won } from './api'
import type { Category, Page, Project, Summary, Transaction, User } from './api'

type Day = Summary & { business_date: string; transaction_count: number; can_create: boolean }
type OcrJob = { id: string; status: string; display_project_file_id: string; structured_result: { fields: { path: string; value: string | number }[] } }
type Job = { id: string; status: string }
type Notice = { id: string; title: string; read_at: string | null; target: { project_id: string } | null }
const errorText = (error: unknown) => error instanceof ApiError ? error.message : '연결을 확인한 뒤 다시 시도해 주세요.'
function useRead<T>(path: string, enabled = true) {
  return useQuery({ queryKey: [path], queryFn: () => api<T>(path), enabled })
}
function useAction<T, V>(action: (value: V) => Promise<T>) {
  return useMutation({ mutationFn: action })
}
function Status({ error, busy }: { error?: unknown; busy?: boolean }) {
  if (error) return <p role="alert">{errorText(error)}</p>
  return busy ? <p role="status">처리 중…</p> : null
}
function Totals({ summary }: { summary: Summary }) {
  return <p>수입 {won(summary.total_income)} · 지출 {won(summary.total_expense)}</p>
}
function form(event: FormEvent<HTMLFormElement>) {
  event.preventDefault()
  return new FormData(event.currentTarget)
}
function monthShift(month: string, delta: number) {
  const [year, number] = month.split('-').map(Number)
  return new Date(Date.UTC(year, number - 1 + delta, 1)).toISOString().slice(0, 7)
}
function useProject() { return useOutletContext<{ base: string; project: Project }>() }

export function CalendarPage() {
  const { base } = useProject()
  const [params, setParams] = useSearchParams()
  const currentMonth = today().slice(0, 7)
  const requested = params.get('month') ?? ''
  const month = /^20\d\d-(0[1-9]|1[0-2])$/.test(requested) ? requested : currentMonth
  const date = params.get('day')
  const calendar = useRead<{ days: Day[]; summary: Summary }>(base + '/calendar?month=' + month)
  const selected = calendar.data?.days.find(day => day.business_date === date)
  const transactions = useRead<Page<Transaction>>(base + '/transactions?sort=TIME_ASC&date_from=' + date + '&date_to=' + date, !!selected)
  const back = base + '/calendar?' + params
  return <section>
    <h1>달력</h1>
    <div className="screen-actions">
      <button onClick={() => setParams({ month: monthShift(month, -1) })}>이전 월</button>
      <strong aria-live="polite">{month}</strong>
      <button onClick={() => setParams({ month: monthShift(month, 1) })}>다음 월</button>
      <button onClick={() => setParams({ month: currentMonth, day: today() })}>오늘</button>
    </div>
    <Status error={calendar.error} busy={calendar.isPending} />
    {calendar.data && <>
      <Totals summary={calendar.data.summary} />
      <div className="calendar-grid" aria-label="날짜">
        {['일', '월', '화', '수', '목', '금', '토'].map(day => <span key={day}>{day}</span>)}
        {Array.from({ length: new Date(month + '-01T00:00:00Z').getUTCDay() }, (_, index) => <span key={index} />)}
        {calendar.data.days.map(day => <button key={day.business_date} aria-pressed={date === day.business_date}
          aria-label={day.business_date + (day.transaction_count ? ' 거래 ' + day.transaction_count + '건' : '')}
          onClick={() => setParams({ month, day: day.business_date })}>
          {Number(day.business_date.slice(-2))}{day.transaction_count > 0 && <small>{day.transaction_count}건</small>}
        </button>)}
      </div>
    </>}
    {selected && <>
      <h2>{date} 거래</h2><Totals summary={selected} />
      <Status error={transactions.error} busy={transactions.isPending} />
      {transactions.data?.items.length === 0 && <p>선택한 날짜에 거래가 없습니다.</p>}
      <ul>{transactions.data?.items.map(row => <li key={row.id}><Link to={base + '/transactions/' + row.id}
        state={{ returnTo: back }}>{row.expense?.merchant_name ?? row.memo ?? '수입'} · {won(row.amount)}</Link></li>)}</ul>
      {selected.can_create && <div className="screen-actions">
        <Link to={base + '/transactions/new'} state={{ back, date }}>선택일 직접 기록</Link>
        <Link to={base + '/ocr'} state={{ back, date }}>선택일 영수증 등록</Link>
      </div>}
    </>}
  </section>
}

async function exportGrant(action: string, target_type: string, target_id: string, request_body: object, password: string) {
  const intent = await api<{ reauth_context: string }>('/auth/reauth/intents', 'POST', { action, target_type, target_id, request_body })
  const grant = await api<{ reauth_token: string }>('/auth/reauth/verify', 'POST', {
    reauth_context: intent.reauth_context, method: 'PASSWORD', password,
  })
  return grant.reauth_token
}

async function download(path: string, filename: string, token: string) {
  const blob = await apiBlob(path, 'POST', token)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function SettlementPage() {
  const { base, project } = useProject()
  const settlement = useRead<{ summary: Summary; category_statistics: { category_id: string; category_name: string; total_expense: string }[]; daily_totals: Day[] }>(base + '/settlement')
  const [jobId, setJobId] = useState('')
  const jobPath = base + '/exports/' + jobId
  const job = useQuery({
    queryKey: [jobPath], queryFn: () => api<Job>(jobPath), enabled: !!jobId,
    refetchInterval: query => ['PENDING', 'PROCESSING'].includes(query.state.data?.status ?? '') ? 700 : false,
  })
  const create = useAction(async ({ options, password }: { options: object; password: string }) => {
    const body = { format: 'CSV', options }
    const token = await exportGrant('SETTLEMENT_CREATE', 'PROJECT', project.id, body, password)
    return api<Job>(base + '/exports', 'POST', body, crypto.randomUUID(), token)
  })
  const file = useAction(async (password: string) => {
    const token = await exportGrant('SETTLEMENT_DOWNLOAD', 'EXPORT_JOB', jobId, {}, password)
    await download(jobPath + '/download', '거래장부.csv', token)
  })
  const cancel = useAction(() => api<Job>(base + '/exports/' + jobId + '/cancel', 'POST', undefined, crypto.randomUUID()))
  const pending = ['PENDING', 'PROCESSING'].includes(job.data?.status ?? '')
  return <section>
    <h1>결산·출력</h1><button onClick={() => void settlement.refetch()}>결산 다시 조회</button>
    <Status error={settlement.error} busy={settlement.isPending} />
    {settlement.data && <>
      <Totals summary={settlement.data.summary} />
      <p>잔액 {won(settlement.data.summary.balance)}</p>
      <h2>항목별 지출</h2>
      {settlement.data.category_statistics.length === 0 && <p>집계할 지출이 없습니다.</p>}
      <ul>{settlement.data.category_statistics.map(item => <li key={item.category_id}>{item.category_name} {won(item.total_expense)}</li>)}</ul>
      <h2>일별 합계</h2><ul>{settlement.data.daily_totals.map(day => <li key={day.business_date}>{day.business_date}<Totals summary={day} /></li>)}</ul>
    </>}
    {project.my_role === 'PROJECT_ADMIN' && <form onSubmit={event => {
      const values = form(event)
      const date_from = String(values.get('from'))
      const date_to = String(values.get('to'))

      create.mutate({ options: { ...(date_from && { date_from }), ...(date_to && { date_to }), include_income: true },
        password: String(values.get('password')) },
        { onSuccess: data => setJobId(data.id) })
    }}>
      <fieldset disabled={create.isPending || pending}>
        <legend>CSV 내보내기</legend>
        <label>시작일 <input name="from" type="date" /></label>
        <label>종료일 <input name="to" type="date" /></label>
        <label>생성 재인증 비밀번호 <input name="password" type="password" autoComplete="current-password" required /></label>
        <button>CSV 생성</button>
      </fieldset>
    </form>}
    <Status error={create.error ?? job.error ?? file.error ?? cancel.error} busy={create.isPending || (!!jobId && job.isPending)} />
    {job.data && <div className="screen-actions">
      <p role="status">출력 상태 {job.data.status}</p>
      {pending && <>
        <button onClick={() => void job.refetch()}>생성 상태 확인</button>
        <button onClick={() => cancel.mutate(undefined, { onSuccess: () => void job.refetch() })}>생성 취소</button>
      </>}
      {job.data.status === 'COMPLETED' && <form onSubmit={event => file.mutate(String(form(event).get('password')))}>
        <label>다운로드 재인증 비밀번호 <input name="password" type="password" autoComplete="current-password" required /></label>
        <button disabled={file.isPending}>CSV 다운로드</button>
      </form>}
    </div>}
  </section>
}

export function OcrPage({ confirm }: { confirm: (path: string, payload: object) => Promise<{ transaction: Transaction } | undefined> }) {
  const { base, project } = useProject()
  const navigate = useNavigate()
  const cache = useQueryClient()
  const { state } = useLocation()
  const [jobId, setJobId] = useState('')
  const [fileError, setFileError] = useState('')
  const [saving, setSaving] = useState(false)
  const path = base + '/ocr-jobs/' + jobId
  const job = useQuery({
    queryKey: [path], queryFn: () => api<OcrJob>(path), enabled: !!jobId,
    refetchInterval: query => ['PENDING', 'PROCESSING'].includes(query.state.data?.status ?? '') ? 700 : false,
  })
  const displayId = job.data?.status === 'REVIEW' ? job.data.display_project_file_id : null
  const display = useQuery({
    queryKey: [base, 'ocr-preview', displayId],
    queryFn: async () => ({ blob: await apiBlob(base + '/files/' + displayId + '/content'), caption: '모의 영수증' }),
    enabled: !!displayId,
  })
  const categories = useRead<Page<Category>>(base + '/categories', project.status === 'ACTIVE')
  const start = useAction(async (file: File) => {
    const data = new FormData()
    data.set('file', file)
    data.set('purpose', 'OCR_SOURCE')
    const upload = await api<{ id: string }>(base + '/files', 'POST', data, crypto.randomUUID())
    try {
      await api(base + '/files/' + upload.id)
      return await api<OcrJob>(base + '/ocr-jobs', 'POST', { source_project_file_id: upload.id }, crypto.randomUUID())
    } catch (error) {
      await api(base + '/files/' + upload.id, 'DELETE').catch(() => undefined)
      throw error
    }
  })
  const cancel = useAction(() => api(base + '/ocr-jobs/' + jobId + '/cancel', 'POST', undefined, crypto.randomUUID()))
  const value = (path: string) => job.data?.structured_result.fields.find(field => field.path === path)?.value
  return <section>
    <h1>영수증 OCR</h1>
    {project.status === 'LOCKED' ? <p>마감된 장부에서는 영수증을 등록할 수 없습니다.</p> : !jobId &&
      <form onSubmit={event => {
        const file = form(event).get('receipt')
        if (!(file instanceof File) || !file.size || file.size > 10 * 1024 * 1024) {
          setFileError('10MB 이하 영수증 파일을 선택해 주세요.')
          return
        }
        setFileError('')
        start.mutate(file, { onSuccess: result => setJobId(result.id) })
      }}>
        <label>영수증 파일 <input name="receipt" type="file" accept="image/jpeg,image/png,image/heic,.heic" required /></label>
        <button disabled={start.isPending}>분석 시작</button>
      </form>}
    {fileError && <p role="alert">{fileError}</p>}
    <Status error={start.error ?? job.error ?? categories.error ?? cancel.error ?? display.error} busy={start.isPending || (!!jobId && job.isPending)} />
    {display.data && project.status === 'ACTIVE' && <EvidenceImage image={display.data} />}
    {job.data && project.status === 'ACTIVE' && <>
      {job.data.status !== 'REVIEW' && <p role="status">분석 상태 {job.data.status}</p>}
      {job.data.status === 'REVIEW' && <form key={jobId} onSubmit={async event => {
        const values = form(event)
        setSaving(true)
        try {
          const result = await confirm(base + '/ocr-jobs/' + jobId + '/confirm', {
            type: 'EXPENSE', amount: Number(values.get('amount')), business_date: values.get('date'),
            occurred_precision: 'DATE', category_id: values.get('category'),
            expense: { merchant_name: String(values.get('merchant')).trim() },
            attachments: [{ project_file_id: job.data?.display_project_file_id, attachment_type: 'RECEIPT', is_primary: true, sort_order: 0 }],
          })
          if (result) navigate(base + '/transactions/' + result.transaction.id, { replace: true, state: { returnTo: state?.back } })
        } finally { setSaving(false) }
      }}>
        <fieldset disabled={saving || cancel.isPending || !categories.data}>
          <legend>인식 결과 확인</legend>
          <label>상호 <input name="merchant" defaultValue={value('/expense/merchant_name')} required /></label>
          <label>금액 <input name="amount" type="number" min="1" max="1000000000" defaultValue={value('/amount')} required /></label>
          {state?.date && state.date !== value('/business_date') && <p>달력에서 선택한 날짜는 {state.date}입니다. 인식된 거래일을 확인해 주세요.</p>}
          <label>거래일 <input name="date" type="date" max={today()} defaultValue={value('/business_date')} required /></label>
          <label>항목 <select name="category" required><option value="">선택</option>
            {categories.data?.items.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select></label>
          <button>기록 확정</button>
        </fieldset>
      </form>}
      {['REVIEW', 'PROCESSING', 'PENDING', 'FAILED'].includes(job.data.status) && <button disabled={saving || cancel.isPending}
        onClick={() => cancel.mutate(undefined, { onSuccess: () => { cache.removeQueries({ queryKey: [base + '/ocr-jobs/' + jobId] }); setJobId('') } })}>분석 취소</button>}
    </>}
    {state?.back && !jobId && <Link to={state.back}>달력으로</Link>}
  </section>
}

type GalleryItem = { attachment: { id: string; project_file_id: string; attachment_type: string }; transaction_id: string; business_date: string; caption: string }
export function GalleryPage() {
  const { base } = useProject()
  const [params, setParams] = useSearchParams()
  const gallery = useRead<Page<GalleryItem>>(base + '/gallery?' + params)
  const categories = useRead<Page<Category>>(base + '/categories')
  const [image, setImage] = useState<{ blob: Blob; caption: string } | null>(null)
  const preview = useAction(async (item: GalleryItem) => ({
    blob: await apiBlob(base + '/files/' + item.attachment.project_file_id + '/content'), caption: item.caption,
  }))
  return <section>
    <h1>증빙 갤러리</h1>
    <form key={params.toString()} onSubmit={event => {
      const data = form(event)
      const next = new URLSearchParams()
      for (const [key, value] of data) if (typeof value === 'string' && value) next.set(key, value)
      setImage(null)
      setParams(next)
    }}>
      <label>종류 <select name="attachment_type" defaultValue={params.get('attachment_type') ?? ''}>
        <option value="">전체</option><option value="RECEIPT">영수증</option>
        <option value="EVIDENCE">증빙</option><option value="BANK_CAPTURE">은행 화면</option><option value="OTHER">기타</option>
      </select></label>
      <label>항목 <select name="category_ids" key={categories.isSuccess ? 'ready' : 'loading'} defaultValue={params.get('category_ids') ?? ''}>
        <option value="">전체</option>
        {categories.data?.items.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
      </select></label>
      <label>시작일 <input name="date_from" type="date" defaultValue={params.get('date_from') ?? ''} /></label>
      <label>종료일 <input name="date_to" type="date" defaultValue={params.get('date_to') ?? ''} /></label>
      <button>조회</button><button type="reset" onClick={() => { setImage(null); setParams({}) }}>초기화</button>
    </form>
    <Status error={gallery.error ?? categories.error ?? preview.error} busy={gallery.isPending || preview.isPending} />
    {gallery.data?.items.length === 0 && <p>조건에 맞는 증빙이 없습니다.</p>}
    <ul>{gallery.data?.items.map(item => <li key={item.attachment.id}>
      <button onClick={() => preview.mutate(item, { onSuccess: setImage })}>증빙 보기 · {item.caption}</button>
      <Link to={base + '/transactions/' + item.transaction_id} state={{ returnTo: base + '/gallery?' + params }}>연결 거래 보기</Link>
    </li>)}</ul>
    {image && <EvidenceImage image={image} close={() => setImage(null)} />}
  </section>
}

function EvidenceImage({ image, close }: { image: { blob: Blob; caption: string }; close?: () => void }) {
  const preview = useRef<HTMLImageElement>(null)
  useEffect(() => {
    const element = preview.current
    if (!element) return
    const url = URL.createObjectURL(image.blob)
    element.src = url
    return () => URL.revokeObjectURL(url)
  }, [image.blob])
  return <figure className="evidence-preview">
    <img ref={preview} alt={image.caption + ' 마스킹 증빙'} />
    <figcaption>{image.caption}</figcaption>{close && <button onClick={close}>증빙 닫기</button>}
  </figure>
}

export function NotificationsPage() {
  const [unread, setUnread] = useState(false)
  const cache = useQueryClient()
  const navigate = useNavigate()
  const list = useRead<Page<Notice> & { unread_count: number; snapshot_before_id: string | null }>('/me/notifications?unread_only=' + unread)
  const action = useAction(async ({ path, method, body }: { path: string; method: string; body?: object }) => {
    const result = await api<{ notification?: Notice; next_action?: string }>(path, method, body, crypto.randomUUID())
    await cache.invalidateQueries({ predicate: query => String(query.queryKey[0]).startsWith('/me/notifications') })
    return result
  })
  return <section>
    <h1>알림</h1>
    <div className="screen-actions">
      <button aria-pressed={!unread} onClick={() => setUnread(false)}>전체</button>
      <button aria-pressed={unread} onClick={() => setUnread(true)}>미확인</button>
      <Link to="/account">알림 설정</Link>
    </div>
    <Status error={list.error ?? action.error} busy={list.isPending || action.isPending} />
    {list.data && <>
      <p role="status">미확인 {list.data.unread_count}건</p>
      <button disabled={!list.data.unread_count || action.isPending} onClick={() => action.mutate({
        path: '/me/notifications/read-all', method: 'POST', body: { through_id: list.data.snapshot_before_id },
      })}>모두 읽음</button>
      {list.data.items.length === 0 && <p>표시할 알림이 없습니다.</p>}
      <ul>{list.data.items.map(item => <li key={item.id}>
        <button disabled={action.isPending} onClick={() => action.mutate({ path: '/me/notifications/' + item.id + '/read', method: 'POST' }, {
          onSuccess: result => {
            const target = result?.notification?.target
            if (result?.next_action === 'OPEN_TARGET' && target) navigate('/projects/' + target.project_id)
            else navigate('/select')
          },
        })}>{item.title} · {item.read_at ? '읽음' : '미확인'}</button>
        <button disabled={action.isPending} aria-label={item.title + ' 삭제'}
          onClick={() => action.mutate({ path: '/me/notifications/' + item.id, method: 'DELETE' })}>삭제</button>
      </li>)}</ul>
    </>}
  </section>
}

type Security = { auto_lock_enabled: boolean; auto_lock_minutes: number | null; totp_enabled: boolean; version: number }
type Preferences = {
  push_enabled: boolean; team_invite_enabled: boolean; expense_created_enabled: boolean; budget_alert_enabled: boolean
  role_changed_enabled: boolean; dnd_enabled: boolean; dnd_start_time: string | null; dnd_end_time: string | null
  timezone: string; version: number
}
const switches = {
  push_enabled: '브라우저 푸시', team_invite_enabled: '팀 초대', expense_created_enabled: '지출 등록',
  budget_alert_enabled: '예산 경고', role_changed_enabled: '권한 변경', dnd_enabled: '방해금지',
} as const
export function AccountPage() {
  const cache = useQueryClient()
  const user = useRead<User & { email: string }>('/me')
  const security = useRead<Security>('/me/security-settings')
  const preferences = useRead<Preferences>('/me/notification-settings')
  const sessions = useRead<Page<{ id: string; is_current: boolean }>>('/me/sessions')
  const save = useAction(async ({ path, data }: { path: string; data: object }) => {
    const result = await api(path, 'PATCH', data)
    await cache.invalidateQueries({ queryKey: [path] })
    return result
  })
  return <section>
    <h1>계정 보안·알림 설정</h1>
    <Status error={user.error ?? security.error ?? preferences.error ?? sessions.error ?? save.error}
      busy={user.isPending || security.isPending || preferences.isPending || sessions.isPending || save.isPending} />
    {user.data && <p>{user.data.display_name} · {user.data.email}</p>}
    {security.data && <div><h2>보안</h2><p>2단계 인증 {security.data.totp_enabled ? '사용 중' : '꺼짐'}</p>
      <p>자동 잠금 {security.data.auto_lock_enabled ? security.data.auto_lock_minutes + '분' : '꺼짐'}</p>
      {sessions.data && <p>활성 세션 {sessions.data.items.length}개</p>}
    </div>}
    {preferences.data && <form key={preferences.data.version} onSubmit={event => {
      const values = form(event)
      const toggles = Object.fromEntries(Object.keys(switches).map(key => [key, values.has(key)]))
      save.mutate({ path: '/me/notification-settings', data: { ...toggles,
        dnd_start_time: values.get('start') || null, dnd_end_time: values.get('end') || null,
        timezone: preferences.data.timezone, version: preferences.data.version } })
    }}>
      <fieldset disabled={save.isPending}>
        <legend>알림 설정</legend><p>앱 내 알림은 항상 켜져 있습니다.</p>
        {(Object.keys(switches) as (keyof typeof switches)[]).map(key => <label key={key}>
          <input type="checkbox" name={key} defaultChecked={preferences.data[key]} />{switches[key]}
        </label>)}
        <label>방해금지 시작 <input name="start" type="time" defaultValue={preferences.data.dnd_start_time ?? ''} /></label>
        <label>방해금지 종료 <input name="end" type="time" defaultValue={preferences.data.dnd_end_time ?? ''} /></label>
        <button>알림 설정 저장</button>
      </fieldset>
    </form>}
    {save.isSuccess && <p role="status">알림 설정을 저장했습니다.</p>}
  </section>
}




