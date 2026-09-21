import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import AdminPricing from './components/AdminPricing.jsx'
import DealerQuotePage from './components/DealerQuotePage.jsx'

const path = window.location.pathname
const isAdmin = path.startsWith('/admin')
const isDealerQuote = path.startsWith('/dealer-quote/')

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {isAdmin ? <AdminPricing /> : isDealerQuote ? <DealerQuotePage /> : <App />}
  </StrictMode>,
)
