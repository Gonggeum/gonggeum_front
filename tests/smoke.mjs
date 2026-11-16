import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { preview } from 'vite'
import { checkLedgerList } from './ledger-list.mjs'
import { checkPageFlows } from './page-flows.mjs'
import { checkMorePages } from './more-pages.mjs'

const server = await preview({ preview: { host: '127.0.0.1', port: 0, strictPort: true } })
const origin = 'http://127.0.0.1:' + server.httpServer.address().port
let browser
try {

  browser = await chromium.launch({
    channel: process.env.GONGGEUMI_BROWSER_CHANNEL ?? 'chrome',
    headless: true,
  })
  const context = await browser.newContext()
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error))
  page.on('dialog', dialog => void dialog.accept())

  const heading = name => page.getByRole('heading', { name }).waitFor()
  const button = name => page.getByRole('button', { name, exact: true }).click()
  const link = name => page.getByRole('link', { name, exact: true }).click()
  const sees = value => page.getByText(value, { exact: true }).waitFor()
  async function expense(merchant, amount) {
    await page.getByLabel('금액').fill(String(amount))
    await page.getByLabel('상호').fill(merchant)
    await page.getByLabel('항목').selectOption('501')
    await button('등록하기')
  }
  await page.goto(origin)
  await heading(/모의 로그인/)
  await button('총무')
  await heading(/팀·장부 선택/)
  await link('행사 운영 장부')
  await heading(/행사 운영 장부/)
  await sees('200,000원')
  await page.goto(origin)
  await sees('200,000원')
  await link('직접 기록')
  const write = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/transactions'))
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (path, init) => {
      const response = await originalFetch(path, init)
      if (init?.method === 'POST' && String(path).endsWith('/transactions') && response.ok) {
        window.fetch = originalFetch
        throw new TypeError('Simulated lost response after commit')
      }
      return response
    }
  })
  await expense('검증용 지출', 15000)
  const original = await write
  await sees('연결을 확인한 뒤 다시 시도해 주세요.')
  await page.reload()
  await heading(/수동 지출/)
  const retry = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/transactions'))
  await expense('검증용 지출', 15000)
  const retried = await retry
  await heading(/거래 상세/)
  await sees('15,000원')
  const headers = await retried.allHeaders()
  assert.equal(headers['idempotency-key'], (await original.allHeaders())['idempotency-key'])
  const replay = await page.evaluate(async ({ path, body, authorization, key }) => {
    const response = await fetch(path, { method: 'POST', body,
      headers: { 'Content-Type': 'application/json', Authorization: authorization, 'Idempotency-Key': key } })
    return { status: response.status, replayed: response.headers.get('Idempotency-Replayed') }
  }, { path: original.url(), body: original.postData(), authorization: headers.authorization, key: headers['idempotency-key'] })
  assert.deepEqual(replay, { status: 201, replayed: 'true' })
  await link('홈')
  await sees('185,000원')
  await link('거래 목록')
  await page.getByLabel('검색').fill('검증용 지출')
  await page.getByLabel('유형').selectOption('EXPENSE')
  await button('조회')
  const filteredTotal = '지출 소계 15,000원 · 수입 소계 0원'
  await sees(filteredTotal)
  await page.reload()
  await sees(filteredTotal)
  assert.equal(await page.getByLabel('검색').inputValue(), '검증용 지출')
  assert.equal(await page.getByLabel('유형').inputValue(), 'EXPENSE')
  await button('초기화')
  await sees('지출 소계 15,000원 · 수입 소계 200,000원')
  assert.equal(new URL(page.url()).search, '')
  await page.getByRole('link', { name: '검증용 지출 · 15,000원' }).click()
  await link('수정')
  await page.evaluate(() => {
    const key = 'gonggeumi-demo-ledger-v1'
    const ledger = JSON.parse(localStorage.getItem(key))
    const row = ledger.rows.find(item => item.expense?.merchant_name === '검증용 지출')
    row.amount = 16000
    row.version++
    localStorage.setItem(key, JSON.stringify(ledger))
  })
  await page.getByLabel('금액').fill('20000')
  await button('수정 저장')
  await sees('다른 변경이 저장되었습니다. 최신 값을 확인해 주세요.')
  await page.getByText(/최신 저장값 16,000원/).waitFor()
  assert.equal(await page.getByLabel('금액').inputValue(), '20000')
  await button('수정 저장')
  await heading(/거래 상세/)
  await sees('20,000원')
  await link('홈')
  await sees('180,000원')
  await page.getByRole('link', { name: '검증용 지출 · 20,000원' }).click()
  await button('삭제')
  await heading(/거래 목록/)
  await link('홈')
  await sees('200,000원')
  await link('설정')
  await link('목표 예산')
  await sees('현재 목표 미설정 · WARN')
  await page.getByLabel('설정 상태').selectOption('SET')
  await page.getByLabel('목표 금액').fill('0')
  await button('저장')
  await sees('현재 목표 0원 · WARN')
  await link('홈')
  await link('직접 기록')
  await expense('WARN 확인 지출', 100)
  await heading(/거래 상세/)
  await link('설정')
  await link('목표 예산')
  await page.getByLabel('초과 정책').selectOption('BLOCK')
  await button('저장')
  await sees('현재 목표 0원 · BLOCK')
  await link('홈')
  await link('직접 기록')
  await expense('BLOCK 차단 지출', 100)
  await sees('목표 예산을 초과하여 저장할 수 없습니다.')
  assert.equal(await page.getByLabel('상호').inputValue(), 'BLOCK 차단 지출')
  await link('설정')
  await button('비밀번호 재설정 완료 모의')
  await heading(/모의 로그인/)
  await button('참여자')
  await heading(/팀·장부 선택/)
  await link('마감된 장부')
  await heading(/마감된 장부/)
  assert.equal(await page.getByRole('link', { name: '직접 기록' }).count(), 0)
  await page.evaluate(() => localStorage.setItem('gonggeumi-demo-revoked', '2'))
  await page.goto(origin)
  await sees('참여 중인 장부가 없습니다.')
  await button('로그아웃')
  await heading(/모의 로그인/)
  await button('팀 없음')
  await sees('등록된 팀이 없습니다. 초대 코드를 확인할 수 있습니다.')
  await button('로그아웃')
  await button('장부 없음')
  await sees('참여 중인 장부가 없습니다.')
  await page.evaluate(() => localStorage.setItem('gonggeumi-demo-refresh-error', '1'))
  await page.goto(origin)
  await page.getByRole('alert').getByText('세션 확인을 잠시 사용할 수 없습니다.').waitFor()
  await page.evaluate(() => localStorage.removeItem('gonggeumi-demo-refresh-error'))
  await button('다시 시도')
  await sees('참여 중인 장부가 없습니다.')
  await page.goto(origin + '/#invite_token=gonggeumi-demo-invite')
  await heading(/초대 확인/)
  assert.equal(new URL(page.url()).hash, '')
  assert.deepEqual(pageErrors, [])
  await checkLedgerList(browser, origin)
  await checkPageFlows(browser, origin)
  await checkMorePages(browser, origin)
  console.log('PASS: author filter, load more, date recovery, filter reload/reset, login, last ledger, CRUD, totals, WARN/BLOCK, reset, role, lock, revoked, empty, retry and invitation')
} finally {
  try { await browser?.close() }
  finally { await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve())) }
}








