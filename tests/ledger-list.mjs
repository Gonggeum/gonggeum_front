import assert from 'node:assert/strict'
import { seedLedgerList } from './fixtures/ledger-list.mjs'

export async function checkLedgerList(browser, origin) {
  const context = await browser.newContext()
  try {
    await seedLedgerList(context, origin)
    const page = await context.newPage()
    page.setDefaultTimeout(5000)
    await page.goto(origin + '/projects/301/transactions')
    await page.getByRole('button', { name: '총무', exact: true }).click()
    const author = page.getByLabel('등록자')
    const type = page.getByLabel('유형')
    const submit = () => page.getByRole('button', { name: '조회', exact: true }).click()
    const rows = page.getByRole('list').getByRole('link')
    async function expectList(count, expense, income) {
      await page.getByText('지출 소계 ' + expense + '원 · 수입 소계 ' + income + '원', { exact: true }).waitFor()
      assert.equal(await rows.count(), count)
    }

    await author.getByRole('option', { name: '총무', exact: true }).waitFor({ state: 'attached' })
    await author.selectOption({ label: '참여자' })
    const authorRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname.endsWith('/projects/301/transactions') && url.searchParams.has('registered_by_user_ids')
    })
    await submit()
    assert.equal(new URL((await authorRequest).url()).searchParams.get('registered_by_user_ids'), '2')
    await expectList(13, '24,000', '50,000')
    assert.equal(new URL(page.url()).searchParams.get('registered_by_user_ids'), '2')
    await type.selectOption('EXPENSE')
    await submit()
    await expectList(12, '24,000', '0')
    await page.reload()
    await expectList(12, '24,000', '0')
    await author.getByRole('option', { name: '참여자', exact: true }).waitFor({ state: 'attached' })
    assert.equal(await author.inputValue(), '2')
    await page.getByRole('button', { name: '초기화', exact: true }).click()
    await expectList(20, '36,000', '150,000')
    const more = page.getByRole('button', { name: /^(더 보기|다음 페이지)$/ })
    const first = await rows.first().getAttribute('href')
    await more.click()
    await rows.nth(25).waitFor()
    await expectList(26, '36,000', '150,000')
    const links = await rows.evaluateAll(elements => elements.map(element => element.getAttribute('href')))
    assert.equal(links[0], first)
    assert.equal(new Set(links).size, 26)
    assert.deepEqual(links.slice(20).map(href => href.split('/').at(-1)), ['7106', '7105', '7104', '7103', '7102', '7101'])
    await more.waitFor({ state: 'hidden' })
    await author.selectOption('2')
    await submit()
    await expectList(13, '24,000', '50,000')
    await page.getByRole('button', { name: '초기화', exact: true }).click()
    await expectList(20, '36,000', '150,000')

    const from = page.getByLabel('시작일')
    const to = page.getByLabel('종료일')
    const previousUrl = page.url()
    await from.fill('2026-10-02')
    await to.fill('2026-10-01')
    await submit()
    const periodError = page.getByRole('alert').filter({ hasText: '시작일은 종료일보다 늦을 수 없습니다.' })
    await periodError.waitFor()
    assert.equal(page.url(), previousUrl)
    assert.equal(await from.inputValue(), '2026-10-02')
    assert.equal(await to.inputValue(), '2026-10-01')
    await expectList(20, '36,000', '150,000')
    await to.fill('2026-10-02')
    await submit()
    await periodError.waitFor({ state: 'hidden' })
    await expectList(13, '18,000', '50,000')
  } finally {
    await context.close()
  }
}



