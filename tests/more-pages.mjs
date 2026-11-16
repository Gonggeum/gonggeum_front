import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { seedLedgerList } from './fixtures/ledger-list.mjs'

export async function checkMorePages(browser, origin) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error))
  page.setDefaultTimeout(8000)
  const button = name => page.getByRole('button', { name, exact: true }).click()
  const link = name => page.getByRole('link', { name, exact: true }).click()
  const text = value => page.getByText(value, { exact: true }).waitFor()
  async function screen(title) {
    await page.getByRole('heading', { name: title, exact: true }).waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, title + ' 가로 넘침')
  }
  const base = '/projects/301'
  try {
    await seedLedgerList(context, origin)
    await page.goto(origin + base + '/calendar?month=2026-10')
    await button('총무')
    await screen('달력')
    await button('2026-10-02 거래 13건')
    await text('수입 50,000원 · 지출 18,000원')
    await link('선택일 직접 기록')
    assert.equal(await page.getByLabel('날짜').inputValue(), '2026-10-02')
    await link('취소')
    await page.getByRole('heading', { name: '2026-10-02 거래' }).waitFor()
    await link('검증 지출 24 · 2,000원')
    await link('목록으로')
    await page.getByRole('heading', { name: '2026-10-02 거래' }).waitFor()
    await link('결산')
    await screen('결산·출력')
    await text('잔액 114,000원')
    await page.getByLabel('생성 재인증 비밀번호').fill('wrong')
    await button('CSV 생성')
    await text('데모 비밀번호를 확인해 주세요.')
    await page.getByLabel('생성 재인증 비밀번호').fill('demo')
    await button('CSV 생성')
    await text('출력 상태 COMPLETED')
    await page.getByLabel('다운로드 재인증 비밀번호').fill('demo')
    const downloaded = page.waitForEvent('download')
    await button('CSV 다운로드')
    const file = await downloaded
    const csv = await readFile(await file.path(), 'utf8')
    assert.match(csv, /^\uFEFF거래일,유형,금액,상호,메모/)
    assert.equal(csv.split('\r\n').length, 27)

    await link('홈')
    await link('영수증 등록')
    await screen('영수증 OCR')
    await page.getByLabel('영수증 파일').setInputFiles({
      name: 'receipt.png', mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9x0AAAAASUVORK5CYII=', 'base64'),
    })
    await button('분석 시작')
    await page.getByRole('img', { name: '모의 영수증 마스킹 증빙' }).waitFor()
    await page.getByLabel('상호').fill('OCR 검증 영수증')
    await page.getByLabel('금액').fill('13000')
    await page.getByLabel('항목').selectOption('501')
    await button('기록 확정')
    await text('13,000원')
    await link('갤러리')
    await screen('증빙 갤러리')
    await button('증빙 보기 · OCR 검증 영수증')
    const image = page.getByRole('img', { name: 'OCR 검증 영수증 마스킹 증빙' })
    await image.waitFor()
    assert.equal(await image.evaluate(element => element.decode().then(() => element.naturalWidth)), 320)
    await link('연결 거래 보기')
    await text('13,000원')

    await link('알림, 미확인 1건')
    await screen('알림')
    await text('미확인 1건')
    await button('모두 읽음')
    await text('미확인 0건')
    await page.getByRole('link', { name: '알림', exact: true }).waitFor()
    await button('미확인')
    await text('표시할 알림이 없습니다.')
    await link('알림 설정')
    await screen('계정 보안·알림 설정')
    await text('활성 세션 1개')
    await page.getByLabel('브라우저 푸시').uncheck()
    await button('알림 설정 저장')
    await text('알림 설정을 저장했습니다.')
    await page.reload()
    await text('앱 내 알림은 항상 켜져 있습니다.')
    assert.equal(await page.getByLabel('브라우저 푸시').isChecked(), false)
    assert.deepEqual(errors, [])
    console.log('PASS: 달력, 결산 CSV 재인증, OCR 확정, 마스킹 갤러리, 알림 읽음, 계정 설정')
  } finally {
    await context.close()
  }
}

