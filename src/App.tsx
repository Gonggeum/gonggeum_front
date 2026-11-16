import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Link, Navigate, Outlet, Route, Routes, useLocation, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { AccountPage, CalendarPage, GalleryPage, NotificationsPage, OcrPage, SettlementPage } from './MorePages'
import { ApiError, api, setAccess, today, won } from './api'
import type { Budget, Category, Expense, Page, Project, Summary, Team, Transaction, User } from './api'

type Context = { project: Project; user: User; base: string }
type TransactionList = Page<Transaction> & { summary: Summary; page: { next_cursor: string | null } }
type Invite = { team_name: string; invite_context: string }
const lastKey = (user: User) => 'gonggeumi-last-ledger:' + user.id
const text = (error: unknown) => error instanceof ApiError ? error.message : '연결을 확인한 뒤 다시 시도해 주세요.'
const accessLost = (error: unknown) => error instanceof ApiError && [403, 404, 410].includes(error.status)
const heading = (id: string, title: string) => <h1><small>{id}</small> {title}</h1>

function QueryState({ error, retry }: { error: unknown; retry: () => void }) {
  return error ? <p role="alert">{text(error)} <button onClick={retry}>다시 시도</button></p> :
    <p role="status">불러오는 중…</p>
}
function useGet<T>(path: string, enabled = true) {
  return useQuery({ queryKey: [path], queryFn: () => api<T>(path), enabled })
}
function ButtonForm({ children, submit }: { children: ReactNode; submit: (form: FormData) => void }) {
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    submit(new FormData(event.currentTarget))
  }
  return <form onSubmit={onSubmit}>{children}</form>
}
const field = (form: FormData, name: string) => String(form.get(name) ?? '')
let pendingInvite = new URLSearchParams(location.hash.slice(1)).get('invite_token')
if (pendingInvite) history.replaceState(history.state, '', location.pathname + location.search)

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [invite, setInvite] = useState<Invite | null>(null)
  const [notice, setNotice] = useState('')
  const cache = useQueryClient()
  const navigate = useNavigate()
  const started = useRef(false)

  async function verifyAccount() {
    const account = await api<User>('/me')
    if (pendingInvite) {
      try {
        setInvite(await api<Invite>('/invitations/resolve', 'POST', { invite_token: pendingInvite }))
      } catch (error) {
        if (!(error instanceof ApiError) || error.status >= 500) throw error
        setNotice(text(error))
      }
      pendingInvite = null
    }
    setUser(account)
  }

  async function restore() {
    setError(null)
    setReady(false)
    try {
      const session = await api<{ access_token: string }>('/auth/refresh', 'POST')
      setAccess(session.access_token)
      await verifyAccount()
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setAccess('')
      else setError(error)
    } finally {
      setReady(true)
    }
  }

  useEffect(() => {
    if (started.current) return
    started.current = true
    void restore()
    // Restore once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function login(identifier: string) {
    cache.clear()
    const session = await api<{ access_token: string }>('/auth/login', 'POST', { identifier, password: 'demo' })
    setAccess(session.access_token)
    await verifyAccount()
  }

  async function leave(reset = false) {
    setNotice('')
    try {
      await api(reset ? '/auth/password-reset/complete' : '/auth/logout', 'POST', reset ? { reset_grant: 'gonggeumi-demo-reset', password: 'DemoPass!123', password_confirmation: 'DemoPass!123' } : undefined)
      cache.clear()
      setAccess('')
      setUser(null)
      setInvite(null)
      navigate('/', { replace: true })
      if (reset) setNotice('모의 비밀번호 재설정이 완료되었습니다. 다시 로그인해 주세요.')
    } catch (error) {
      setNotice(text(error))
    }
  }

  return <main>
    <header><strong>공금이</strong><span>모의 환경</span>{user &&
      <div>{user.display_name} <NotificationLink /> <Link to="/account">계정</Link> <button onClick={() => void leave()}>로그아웃</button></div>}</header>
    {notice && <p role="status">{notice}</p>}
    {!ready || error ? <QueryState error={error} retry={() => void restore()} /> : !user ? <Login login={login} /> :
      invite ? <section>{heading('06', '초대 확인')}<p>{invite.team_name}의 데모 초대입니다.</p>
        <button onClick={() => { setInvite(null); navigate('/select', { replace: true }) }}>장부 선택으로</button>
      </section> :
      <Routes>
        <Route index element={<Start user={user} />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/select" element={<Select user={user} />} />
        <Route path="/projects/:projectId" element={<ProjectGate user={user} />}>
          <Route index element={<Home />} />
          <Route path="transactions" element={<Ledger />} />
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="settlement" element={<SettlementPage />} />
          <Route path="ocr" element={<OcrEntry />} />
          <Route path="gallery" element={<GalleryPage />} />
          <Route path="transactions/new" element={<NewExpense />} />
          <Route path="transactions/:transactionId" element={<Detail />} />
          <Route path="transactions/:transactionId/edit" element={<Detail editing />} />
          <Route path="settings" element={<Settings reset={() => void leave(true)} />} />
          <Route path="settings/budget" element={<BudgetPage />} />
        </Route>
        <Route path="*" element={<Navigate replace to="/" />} />
      </Routes>}
  </main>
}

function NotificationLink() {
  const unread = useGet<{ unread_count: number }>('/me/notifications/unread-count')
  const count = unread.data?.unread_count ?? 0
  return <Link to="/notifications" aria-label={count ? '알림, 미확인 ' + count + '건' : '알림'}>
    알림{count > 0 && <span aria-hidden="true"> ({count})</span>}
  </Link>
}

function Login({ login }: { login: (identifier: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(identifier: string) {
    setBusy(true)
    setError('')
    try { await login(identifier) } catch (error) { setError(text(error)) }
    finally { setBusy(false) }
  }
  return <section>{heading('06', '모의 로그인')}<p>시험할 계정을 선택하세요.</p>
    {error && <p role="alert">{error}</p>}
    {['총무', '참여자', '팀 없음', '장부 없음'].map((name, index) =>
      <button key={name} disabled={busy} onClick={() => void submit('demo' + (index + 1))}>{name}</button>)}
  </section>
}

function Start({ user }: { user: User }) {
  const stored = localStorage.getItem(lastKey(user))
  const last = stored ? JSON.parse(stored) as { id: string; team_id: string } : null
  const query = useGet<Project>('/projects/' + last?.id, !!last)
  if (!last || accessLost(query.error) || (query.data && query.data.team_id !== last.team_id)) {
    if (last) localStorage.removeItem(lastKey(user))
    return <Navigate replace to="/select" />
  }
  return query.data ? <Navigate replace to={'/projects/' + query.data.id} /> :
    <QueryState error={query.error} retry={() => void query.refetch()} />
}

function Select({ user }: { user: User }) {
  const { state } = useLocation()
  const [selected, setSelected] = useState('')
  const [invite, setInvite] = useState<Invite | null>(null)
  const [error, setError] = useState('')
  const teams = useGet<Page<Team>>('/teams')
  const team = selected || teams.data?.items[0]?.id
  const projects = useGet<Page<{ project: Project; summary: Summary }>>('/teams/' + team + '/projects', !!team)
  async function lookup(token: string) {
    setError('')
    setInvite(null)
    try { setInvite(await api<Invite>('/invitations/resolve', 'POST', { invite_token: token.trim() })) }
    catch (error) { setError(text(error)) }
  }
  return <section>{heading('00', '팀·장부 선택')}<p>{user.display_name} 계정</p>
    {state?.projectUnavailable && <p role="status">요청한 장부에 접근할 수 없습니다.</p>}
    {!teams.data ? <QueryState error={teams.error} retry={() => void teams.refetch()} /> : !team ?
      <p>등록된 팀이 없습니다. 초대 코드를 확인할 수 있습니다.</p> :
      <>
        <label>팀 <select value={team} onChange={event => setSelected(event.target.value)}>
          {teams.data.items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        {!projects.data ? <QueryState error={projects.error} retry={() => void projects.refetch()} /> :
          projects.data.items.length === 0 ? <p>참여 중인 장부가 없습니다.</p> :
            <ul>{projects.data.items.map(({ project, summary }) => <li key={project.id}>
              <Link to={'/projects/' + project.id}>{project.name}</Link> · {won(summary.balance)}
              {project.status === 'LOCKED' && ' · 마감'}
            </li>)}</ul>}
      </>}
    <ButtonForm submit={form => void lookup(field(form, 'code'))}>
      <label>초대 코드 <input name="code" required /></label><button>확인</button>
    </ButtonForm>
    {invite && <p role="status">{invite.team_name}의 데모 초대입니다.</p>}
    {error && <p role="alert">{error}</p>}
  </section>
}

function ProjectGate({ user }: { user: User }) {
  const { projectId } = useParams()
  const base = '/projects/' + projectId
  const query = useGet<Project>(base)
  const project = query.data
  useEffect(() => {
    if (project && !query.error) localStorage.setItem(lastKey(user), JSON.stringify({ id: project.id, team_id: project.team_id }))
  }, [project, query.error, user])
  if (accessLost(query.error)) {
    const stored = localStorage.getItem(lastKey(user))
    if (stored && JSON.parse(stored).id === projectId) localStorage.removeItem(lastKey(user))
    return <Navigate replace to="/select" state={{ projectUnavailable: true }} />
  }
  if (!project || query.error) return <QueryState error={query.error} retry={() => void query.refetch()} />
  return <>
    <nav aria-label="장부 메뉴"><Link to="/select">장부 전환</Link><Link to={base}>홈</Link>
      <Link to={base + '/transactions'}>거래 목록</Link><Link to={base + '/calendar'}>달력</Link>
      <Link to={base + '/settlement'}>결산</Link><Link to={base + '/gallery'}>갤러리</Link>
      <Link to={base + '/settings'}>설정</Link></nav>
    {project.status === 'LOCKED' && <p role="status">마감된 장부입니다. 거래와 예산을 조회할 수 있습니다.</p>}
    <Outlet context={{ base, project, user } satisfies Context} />
  </>
}

function TransactionRows({ list, base }: { list: TransactionList; base: string }) {
  const location = useLocation()
  const listPath = location.pathname === base + '/transactions' ? location.pathname + location.search : undefined
  if (!list.items.length) return <p>거래가 없습니다.</p>
  return <ul>{list.items.map(row => <li key={row.id}><Link to={base + '/transactions/' + row.id} state={{ listPath }}>
    {row.expense?.merchant_name ?? row.memo ?? '수입'} · {won(row.amount)}
  </Link> <span>{row.business_date}</span></li>)}</ul>
}
function NewLink({ base, project }: Context) {
  const location = useLocation()
  const back = location.pathname + location.search
  const listPath = location.pathname === base + '/transactions' ? back : undefined
  return project.status === 'ACTIVE' && <Link to={base + '/transactions/new'}
    state={{ back, listPath }}>직접 기록</Link>
}
function Home() {
  const context = useOutletContext<Context>()
  const { base, project } = context
  const query = useGet<{ summary: Summary; recent_transactions: TransactionList }>(base + '/dashboard')
  return <section>{heading('01', project.name)}
    {query.data && !query.error ? <>
      <p>장부 잔액 <strong>{won(query.data.summary.balance)}</strong></p>
      <NewLink {...context} />
      {project.status === 'ACTIVE' && <p><Link to={base + '/ocr'}>영수증 등록</Link></p>}
      <h2>최근 거래</h2><TransactionRows list={query.data.recent_transactions} base={base} />
    </> : <QueryState error={query.error} retry={() => void query.refetch()} />}
  </section>
}
function Ledger() {
  const context = useOutletContext<Context>()
  const { base } = context
  const [params, setParams] = useSearchParams()
  const [periodError, setPeriodError] = useState(false)
  const cache = useQueryClient()
  const appliedFilters = new URLSearchParams(params)
  appliedFilters.delete('cursor')
  const categories = useGet<Page<Category>>(base + '/categories')
  const members = useGet<Page<{ id: string; user: Transaction['registered_by'] }>>(base + '/members?limit=100')
  const query = useInfiniteQuery({
    queryKey: ['ledger-list', base, appliedFilters.toString()],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams(appliedFilters)
      if (pageParam) search.set('cursor', pageParam)
      return api<TransactionList>(base + '/transactions' + (search.size ? '?' + search : ''))
    },
    getNextPageParam: last => last.page.next_cursor ?? undefined,
  })
  function applyFilters(next: URLSearchParams) {
    setPeriodError(false)
    void cache.resetQueries({ queryKey: ['ledger-list', base, next.toString()], exact: true })
    setParams(next)
  }
  const firstPage = query.data?.pages[0]
  const list = firstPage && {
    ...firstPage,
    items: Array.from(new Map((query.data?.pages ?? []).flatMap(page => page.items.map(row => [row.id, row] as const))).values()),
  }
  const invalidCursor = query.error instanceof ApiError &&
    ['CURSOR_INVALID', 'CURSOR_EXPIRED'].includes(query.error.fault.code)
  return <section>{heading('02', '거래 목록')}
    <NewLink {...context} />
    <ButtonForm key={appliedFilters.toString()} submit={form => {
      const params = new URLSearchParams()
      for (const name of ['q', 'type', 'category_ids', 'registered_by_user_ids', 'date_from', 'date_to']) {
        const value = field(form, name) || (!form.has(name) ? appliedFilters.get(name) : '')
        if (value) params.set(name, value)
      }
      const from = params.get('date_from')
      const to = params.get('date_to')
      if (from && to && from > to) {
        setPeriodError(true)
        return
      }
      applyFilters(params)
    }}>
      <label>검색 <input name="q" maxLength={100} defaultValue={params.get("q") ?? ""} /></label>
      <label>유형 <select name="type" defaultValue={params.get("type") ?? ""}><option value="">전체</option><option value="EXPENSE">지출</option><option value="INCOME">수입</option></select></label>
      <label>항목 <select name="category_ids" key={categories.isSuccess ? "ready" : "loading"} defaultValue={params.get("category_ids") ?? ""}><option value="">전체</option>
        {categories.data?.items.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
      </select></label>
      <label>등록자 <select name="registered_by_user_ids" key={members.isSuccess ? 'ready' : 'loading'}
        defaultValue={params.get('registered_by_user_ids') ?? ''} disabled={!members.data}>
        <option value="">전체</option>
        {members.data?.items.map(({ id, user }) => <option key={id} value={user.user_id}>{user.display_name}</option>)}
      </select></label>
      {members.error && <QueryState error={members.error} retry={() => void members.refetch()} />}
      <label>시작일 <input name="date_from" type="date" aria-invalid={periodError} aria-describedby={periodError ? "ledger-period-error" : undefined} defaultValue={params.get("date_from") ?? ""} /></label>
      <label>종료일 <input name="date_to" type="date" aria-invalid={periodError} aria-describedby={periodError ? "ledger-period-error" : undefined} defaultValue={params.get("date_to") ?? ""} /></label>
      {periodError && <p id="ledger-period-error" role="alert">시작일은 종료일보다 늦을 수 없습니다.</p>}
      <button>조회</button><button type="reset" onClick={() => applyFilters(new URLSearchParams())}>초기화</button>
    </ButtonForm>
    {list ? <>
      <p>지출 소계 {won(list.summary.total_expense)} · 수입 소계 {won(list.summary.total_income)}</p>
      <TransactionRows list={list} base={base} />
      {query.error && <QueryState error={query.error} retry={() => {
        if (invalidCursor) applyFilters(appliedFilters)
        else if (query.isFetchNextPageError) void query.fetchNextPage()
        else void query.refetch()
      }} />}
      {query.hasNextPage && !invalidCursor &&
        <button disabled={query.isFetching} onClick={() => void query.fetchNextPage()}>더 보기</button>}
    </> : <QueryState error={query.error} retry={() => void query.refetch()} />}
  </section>
}

function useWrite() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const { user } = useOutletContext<Context>()
  const submitting = useRef(false)
  const cache = useQueryClient()
  async function submit<T>(method: string, path: string, payload?: object): Promise<T | undefined> {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError(null)
    let body = payload
    try {
      const input = new TextEncoder().encode(JSON.stringify([method, path, payload]))
      const digest = await crypto.subtle.digest('SHA-256', input)
      const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
      const slot = 'gonggeumi-demo-write:' + user.id + ':' + fingerprint
      const key = sessionStorage.getItem(slot) ?? crypto.randomUUID()
      sessionStorage.setItem(slot, key)
      while (true) {
        try {
          const data = await api<T>(path, method, body, key)
          sessionStorage.removeItem(slot)
          await cache.invalidateQueries()
          return data
        } catch (error) {
          const token = error instanceof ApiError && error.fault.details?.confirmation_token
          if (!token) throw error
          const details = error instanceof ApiError ? error.fault.details : undefined
          const impact = details as { reasons?: string[]; projected_expense?: string; target_budget?: number | null } | undefined
          const labels: Record<string, string> = { OVER_BUDGET: '목표 예산 초과', BUDGET_UNSET: '목표 예산 해제',
            OUTSIDE_PROJECT_PERIOD: '장부 기간 밖 거래', EXISTING_OVER_BUDGET: '현재 지출이 새 목표 예산을 초과' }
          const reasons = impact?.reasons?.map(reason => labels[reason] ?? reason).join(', ')
          if (!window.confirm([text(error), reasons, impact?.projected_expense !== undefined &&
            '저장 후 지출 ' + won(impact.projected_expense)].filter(Boolean).join('\n'))) return
          body = { ...payload, confirmation_token: token }
        }
      }
    } catch (error) {
      setError(error)
      if (error instanceof ApiError && (error.status === 409 || accessLost(error))) await cache.invalidateQueries()
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  return { submit, busy, error }
}
function WriteError({ error }: { error: unknown }) {
  return error ? <p role="alert">{text(error)}</p> : null
}
function OcrEntry() {
  const writer = useWrite()
  return <>
    <WriteError error={writer.error} />
    <OcrPage confirm={(path, payload) => writer.submit('POST', path, payload)} />
  </>
}
function NewExpense() {
  const { base, project } = useOutletContext<Context>()
  if (project.status !== 'ACTIVE') return <Navigate replace to={base} />
  return <ExpenseForm />
}
function ExpenseForm({ transaction }: { transaction?: Transaction }) {
  const { base } = useOutletContext<Context>()
  const navigate = useNavigate()
  const location = useLocation()
  const writer = useWrite()
  const categories = useGet<Page<Category>>(base + '/categories')
  const back = transaction ? base + '/transactions/' + transaction.id : location.state?.back ?? base
  async function save(form: FormData) {
    const payload: Expense = {
      type: 'EXPENSE', amount: Number(field(form, 'amount')), business_date: field(form, 'date'),
      occurred_precision: 'DATE', category_id: field(form, 'category'),
      expense: { merchant_name: field(form, 'merchant').trim() }, memo: field(form, 'memo').trim() || null,
    }
    const result = await writer.submit<{ transaction: Transaction }>(transaction ? 'PUT' : 'POST',
      base + '/transactions' + (transaction ? '/' + transaction.id : ''),
      transaction ? { ...payload, version: transaction.version } : payload)
    if (result) navigate(base + '/transactions/' + result.transaction.id, { replace: true, state: location.state })
  }
  return <section>{heading(transaction ? '05' : '10', transaction ? '지출 수정' : '수동 지출')}
    <WriteError error={writer.error} />
    {writer.error instanceof ApiError && writer.error.fault.code === 'VERSION_CONFLICT' &&
      <p role="status">최신 저장값 {won(transaction?.amount ?? 0)} · {transaction?.expense?.merchant_name}. 아래 입력을 검토한 뒤 다시 저장하세요.</p>}
    {categories.data ? <ButtonForm submit={form => void save(form)}>
      <fieldset disabled={writer.busy}>
        <label>금액 <input name="amount" type="number" min="1" max="1000000000" required defaultValue={transaction?.amount} /></label>
        <label>날짜 <input name="date" type="date" max={today()} required defaultValue={transaction?.business_date ?? location.state?.date ?? today()} /></label>
        <label>상호 <input name="merchant" required maxLength={100} defaultValue={transaction?.expense?.merchant_name} /></label>
        <label>항목 <select name="category" required defaultValue={transaction?.category_id ?? ''}>
          <option value="">선택</option>{categories.data.items.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select></label>
        <label>메모 <textarea name="memo" maxLength={500} defaultValue={transaction?.memo ?? ''} /></label>
        <button>{transaction ? '수정 저장' : '등록하기'}</button>
      </fieldset>
    </ButtonForm> : <QueryState error={categories.error} retry={() => void categories.refetch()} />}
    <Link to={back} state={transaction ? location.state : undefined}>취소</Link>
  </section>
}
function Detail({ editing = false }: { editing?: boolean }) {
  const { base, user, project } = useOutletContext<Context>()
  const { transactionId } = useParams()
  const { state } = useLocation()
  const listPath = state?.returnTo ?? state?.listPath ?? base + '/transactions'
  const path = base + '/transactions/' + transactionId
  const query = useGet<Transaction>(path)
  const writer = useWrite()
  const navigate = useNavigate()
  if (query.error || !query.data) return <section><QueryState error={query.error} retry={() => void query.refetch()} />
    <Link to={listPath}>목록으로</Link></section>
  const row = query.data
  const canWrite = project.status === 'ACTIVE' && (project.my_role === 'PROJECT_ADMIN' ||
    (row.type === 'EXPENSE' && row.registered_by.user_id === user.id))
  if (editing) return canWrite && row.type === 'EXPENSE' ? <ExpenseForm key={row.id} transaction={row} /> : <Navigate replace to={path} state={state} />
  async function remove() {
    if (!window.confirm('이 거래를 삭제하시겠습니까?')) return
    const result = await writer.submit('DELETE', path + '?version=' + row.version)
    if (result) navigate(listPath, { replace: true })
  }
  return <section>{heading('05', '거래 상세')}
    <dl><dt>금액</dt><dd>{won(row.amount)}</dd><dt>날짜</dt><dd>{row.business_date}</dd>
      <dt>상호</dt><dd>{row.expense?.merchant_name ?? '—'}</dd>
      <dt>등록자</dt><dd>{row.registered_by.display_name}</dd><dt>메모</dt><dd>{row.memo ?? '—'}</dd></dl>
    <WriteError error={writer.error} />
    {canWrite && <div>{row.type === 'EXPENSE' && <Link to={path + '/edit'} state={state}>수정</Link>}
      <button disabled={writer.busy} onClick={() => void remove()}>삭제</button></div>}
    <Link to={listPath}>목록으로</Link>
  </section>
}
function Settings({ reset }: { reset: () => void }) {
  const { base } = useOutletContext<Context>()
  return <section>{heading('04', '설정')}<Link to={base + '/settings/budget'}>목표 예산</Link>
    <button onClick={() => { if (window.confirm('모의 비밀번호 재설정 완료를 실행할까요?')) reset() }}>비밀번호 재설정 완료 모의</button>
  </section>
}
function BudgetPage() {
  const { base, project } = useOutletContext<Context>()
  const path = base + '/budget'
  const query = useGet<Budget>(path)
  const writer = useWrite()
  const [mode, setMode] = useState<'SET' | 'UNSET' | null>(null)
  const [reason, setReason] = useState('')
  if (!query.data || query.error) return <QueryState error={query.error} retry={() => void query.refetch()} />
  const budget = query.data
  const editingMode = mode ?? budget.budget_mode
  const editable = project.status === 'ACTIVE' && project.my_role === 'PROJECT_ADMIN'
  async function save(form: FormData) {
    const payload = {
      budget_mode: editingMode, version: budget.version,
      ...(editingMode === 'SET' ? { target_budget: Number(field(form, 'target')),
        over_budget_policy: field(form, 'policy'), warning_enabled: form.has('warning'), critical_enabled: form.has('critical') } : {}),
      ...(field(form, 'reason').trim() ? { reason: field(form, 'reason').trim() } : {}),
    }
    if (await writer.submit('PUT', path, payload)) {
      setMode(null)
      setReason('')
    }
  }
  return <section>{heading('07', '목표 예산')}
    <p>현재 목표 {budget.target_budget === null ? '미설정' : won(budget.target_budget)} · {budget.over_budget_policy}</p>
    <WriteError error={writer.error} />
    {editable && <ButtonForm submit={form => void save(form)}><fieldset disabled={writer.busy}>
      <label>설정 상태 <select value={editingMode} onChange={event => setMode(event.target.value as Budget['budget_mode'])}>
        <option value="UNSET">미설정</option><option value="SET">설정</option></select></label>
      {editingMode === 'SET' && <>
        <label>목표 금액 <input type="number" name="target" min="0" max="1000000000" required defaultValue={budget.target_budget ?? ''} /></label>
        <label>초과 정책 <select name="policy" defaultValue={budget.over_budget_policy}><option>WARN</option><option>BLOCK</option></select></label>
        <label><input type="checkbox" name="warning" defaultChecked={budget.warning_enabled} />80% 알림</label>
        <label><input type="checkbox" name="critical" defaultChecked={budget.critical_enabled} />100% 알림</label>
      </>}
      <label>변경 사유 <input name="reason" maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label><button>저장</button>
    </fieldset></ButtonForm>}
    <Link to={base + '/settings'}>설정으로</Link>
  </section>
}










