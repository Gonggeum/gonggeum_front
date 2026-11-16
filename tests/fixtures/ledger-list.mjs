const storageKey = 'gonggeumi-demo-ledger-v1'
const projectId = '301'
const earlier = '2026-10-01'
const later = '2026-10-02'
const treasurer = { user_id: '1', display_name: '총무' }
const member = { user_id: '2', display_name: '참여자' }

const expenses = Array.from({ length: 24 }, (_, index) => {
  const author = index % 2 === 0 ? treasurer : member
  return {
    id: String(7101 + index),
    project_id: projectId,
    version: 1,
    type: 'EXPENSE',
    business_date: index < 12 ? earlier : later,
    category_id: '501',
    expense: { merchant_name: '검증 지출 ' + (index + 1) },
    memo: null,
    amount: author === treasurer ? 1000 : 2000,
    registered_by: author,
  }
})

const incomes = [
  { id: '7125', business_date: earlier, amount: 100000, registered_by: treasurer },
  { id: '7126', business_date: later, amount: 50000, registered_by: member },
].map(row => ({
  ...row, project_id: projectId, version: 1, type: 'INCOME',
  category_id: null, expense: null, memo: '검증 수입 ' + row.id,
}))

const budget = {
  budget_mode: 'UNSET', target_budget: null, over_budget_policy: 'WARN',
  warning_enabled: true, critical_enabled: true, version: 0,
}

export const ledger = {
  rows: [...expenses, ...incomes],
  budgets: { '301': budget, '302': budget },
  receipts: {},
  nextId: 7127,
}

export async function seedLedgerList(context, origin) {
  await context.addInitScript(({ origin, key, data }) => {
    if (location.origin === origin && localStorage.getItem(key) === null) {
      localStorage.setItem(key, JSON.stringify(data))
    }
  }, { origin, key: storageKey, data: ledger })
}
