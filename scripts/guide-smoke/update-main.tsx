import {
  Box,
  Button,
  CssBaseline,
  Stack,
  ThemeProvider,
  Typography,
  createTheme,
} from '@mui/material'
import i18n from 'i18next'
import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initReactI18next } from 'react-i18next'
import { SWRConfig } from 'swr'

import type { DialogRef } from '@/components/base'
import { UpdateButton, UpdatePrompt } from '@/components/layout/update-button'
import { UpdateViewer } from '@/components/setting/mods/update-viewer'
import { useUpdate } from '@/hooks/use-update'
import { swrConfig } from '@/services/query-client'

import { installUpdateMocks, updateFixtureState } from './update-fixture'

installUpdateMocks()
await i18n.use(initReactI18next).init({
  lng: 'zh',
  fallbackLng: 'zh',
  resources: { zh: { translation: {} } },
  interpolation: { escapeValue: false },
})

function UpdateFixture() {
  const [allowPrompt, setAllowPrompt] = useState(false)
  const [mount, setMount] = useState(0)
  const [manualResult, setManualResult] = useState('idle')
  const viewer = useRef<DialogRef>(null)
  const { checkUpdate, loading } = useUpdate(false)

  useEffect(() => {
    Object.assign(window, {
      __updateFixture: {
        state: () => ({
          ...updateFixtureState(),
          allowPrompt,
          mount,
          manualResult,
        }),
      },
    })
  }, [allowPrompt, mount, manualResult])

  const checkManually = async () => {
    setManualResult('checking')
    try {
      const { data } = await checkUpdate()
      setManualResult(data ? 'available' : 'current')
      if (data) viewer.current?.open()
    } catch {
      setManualResult('error')
    }
  }

  return (
    <Box data-testid="update-fixture" sx={{ p: 4 }}>
      <Typography variant="h4" sx={{ mb: 3 }}>
        IKUN
      </Typography>
      <Stack direction="row" spacing={2}>
        <Button
          data-testid="allow-update-prompt"
          onClick={() => setAllowPrompt((value) => !value)}
        >
          切换引导状态
        </Button>
        <Button
          data-testid="remount-update-prompt"
          onClick={() => setMount((value) => value + 1)}
        >
          重新显示更新入口
        </Button>
        <Button
          data-testid="manual-update-check"
          disabled={loading}
          onClick={() => void checkManually()}
        >
          检查更新
        </Button>
        <UpdateButton />
      </Stack>
      <Typography data-testid="manual-update-result" sx={{ mt: 2 }}>
        {manualResult}
      </Typography>
      <UpdatePrompt key={mount} allowPrompt={allowPrompt} />
      <UpdateViewer ref={viewer} />
    </Box>
  )
}

const dark = new URLSearchParams(location.search).get('theme') === 'dark'
const theme = createTheme({ palette: { mode: dark ? 'dark' : 'light' } })
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SWRConfig value={swrConfig}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <UpdateFixture />
      </ThemeProvider>
    </SWRConfig>
  </StrictMode>,
)
