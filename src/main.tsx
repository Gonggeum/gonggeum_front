import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import './index.css'

const root = createRoot(document.getElementById('root')!)
const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
async function start() {
  const { worker } = await import('./mock')
  await worker.start()
  root.render(<QueryClientProvider client={cache}><BrowserRouter><App /></BrowserRouter></QueryClientProvider>)
}
void start().catch(() => root.render(<p role="alert">모의 API를 시작할 수 없습니다. localhost에서 실행해 주세요.</p>))

