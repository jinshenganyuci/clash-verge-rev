import {
  Box,
  Button,
  CssBaseline,
  FormControlLabel,
  Switch,
  ThemeProvider,
  createTheme,
} from '@mui/material'
import i18n from 'i18next'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initReactI18next } from 'react-i18next'
import { SWRConfig } from 'swr'

import { AccountGate } from '@/components/xboard/account-gate'
import { swrConfig } from '@/services/query-client'

await i18n.use(initReactI18next).init({
  lng: 'zh',
  fallbackLng: 'zh',
  resources: { zh: { translation: {} } },
  interpolation: { escapeValue: false },
})

const dark = new URLSearchParams(location.search).get('theme') === 'dark'
const theme = createTheme({ palette: { mode: dark ? 'dark' : 'light' } })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SWRConfig value={{ ...swrConfig, dedupingInterval: 0 }}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Box sx={{ display: 'flex', minHeight: '100vh', p: 4 }}>
          <AccountGate>
            <Box data-testid="normal-interface">
              <Button data-testid="background-node">手动切换节点</Button>
              <FormControlLabel
                data-testid="background-proxy"
                control={<Switch />}
                label="系统代理开关"
              />
            </Box>
          </AccountGate>
        </Box>
      </ThemeProvider>
    </SWRConfig>
  </StrictMode>,
)
