import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { setAuthTokenGetter } from '@workspace/api-client-react'

setAuthTokenGetter(() => {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage.getItem('admin_token')
  }
  return null
})

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('React mount point #root was not found')
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)