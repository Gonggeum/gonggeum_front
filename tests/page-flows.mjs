import assert from 'node:assert/strict'
import { seedLedgerList } from './fixtures/ledger-list.mjs'

const base = '/projects/301'
const login = page => page.getByRole('button', { name: '총무', exact: true }).click()
const click = (page, name) => page.getByRole('link', { name, exact: true }).click()
const waitForText = (page, text) => page.getByText(text, { exact: true }).waitFor()

async function checkLastProject(page, origin) {
  await page.goto(origin)
  await login(page)
  await click(page, '행사 운영 장부')
  await waitForText(page, '200,000원')
  await page.goto(origin + '/projects/999/transactions/new')
  await page.getByRole('status').filter({ hasText: '요청한 장부에 접근할 수 없습니다.' }).waitFor()
  await page.goto(origin)
  await waitForText(page, '200,000원')
  assert.equal(new URL(page.url()).pathname, base)
  await page.goto(origin + '/projects/302/transactions/new')
  await page.getByRole('heading', { name: /마감된 장부/ }).waitFor()
  assert.equal(new URL(page.url()).pathname, '/projects/302')
  assert.equal(await page.getByRole('link', { name: '직접 기록' }).count(), 0)
  await click(page, '설정')
  await click(page, '목표 예산')
  await waitForText(page, '현재 목표 미설정 · WARN')
  assert.equal(await page.getByRole('button', { name: '저장', exact: true }).count(), 0)
}

async function checkTransactionReturn(page, origin) {
  const filtered = base + '/transactions?registered_by_user_ids=2&type=EXPENSE'
  await page.goto(origin + filtered)
  await login(page)
  await waitForText(page, '지출 소계 24,000원 · 수입 소계 0원')
  await click(page, '직접 기록')
  await page.getByRole('heading', { name: /수동 지출/ }).waitFor()
  await click(page, '취소')
  await waitForText(page, '지출 소계 24,000원 · 수입 소계 0원')
  await click(page, '검증 지출 24 · 2,000원')
  await click(page, '수정')
  await page.getByLabel('금액').fill('2500')
  await page.getByRole('button', { name: '수정 저장' }).click()
  await waitForText(page, '2,500원')
  await click(page, '목록으로')
  await waitForText(page, '지출 소계 24,500원 · 수입 소계 0원')
  assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, filtered)
}

async function checkBudgetForm(page, origin) {
  await page.goto(origin + base + '/settings')
  await login(page)
  await page.getByRole('heading', { name: /설정/ }).waitFor()
  await click(page, '목표 예산')
  await page.getByLabel('설정 상태').selectOption('SET')
  await page.getByLabel('목표 금액').fill('300000')
  await page.getByLabel('변경 사유').fill('초기 예산 책정')
  await page.getByRole('button', { name: '저장', exact: true }).click()
  await waitForText(page, '현재 목표 300,000원 · WARN')
  const reason = page.getByLabel('변경 사유')
  await reason.locator('xpath=self::input[@value=""]').waitFor()
  assert.equal(await reason.inputValue(), '')
  await click(page, '설정으로')
  await page.getByRole('button', { name: '비밀번호 재설정 완료 모의' }).waitFor()
}

export async function checkPageFlows(browser, origin) {
  const cases = [
    { name: '06·00·01 마지막 장부', run: checkLastProject },
    { name: '02·05·10 거래 화면 복귀', run: checkTransactionReturn, seed: true },
    { name: '04·07 예산 저장 후 초기화', run: checkBudgetForm },
  ]
  const results = await Promise.allSettled(cases.map(async ({ name, run, seed }) => {
    const context = await browser.newContext()
    try {
      if (seed) await seedLedgerList(context, origin)
      const page = await context.newPage()
      page.setDefaultTimeout(5000)
      page.on('dialog', dialog => void dialog.accept())
      await run(page, origin)
      console.log('PASS: ' + name)
    } catch (error) {
      throw new Error(name, { cause: error })
    } finally {
      await context.close()
    }
  }))
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length) throw new AggregateError(errors, '페이지별 브라우저 검증 실패')
}

