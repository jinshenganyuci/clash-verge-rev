import { Box } from '@mui/material'
import { useEffect, type ReactNode } from 'react'

import { useXboard } from '@/hooks/use-xboard'
import { refreshAccount } from '@/services/xboard'

import { AccountAuth } from './account-auth'
import { AccountLoading } from './shared'

export function AccountGate({ children }: { children: ReactNode }) {
  const account = useXboard()
  const signedIn = account.data?.signed_in === true
  useEffect(() => {
    if (!signedIn) return
    const refresh = () => {
      void refreshAccount(false).catch(() => {
        /* The cached account remains usable offline. */
      })
    }
    refresh()
    const timer = window.setInterval(refresh, 5 * 60 * 1000)
    return () => window.clearInterval(timer)
  }, [signedIn])
  if (account.data?.onboarding_complete) return <>{children}</>
  return (
    <Box
      sx={{
        flex: 1,
        minWidth: 0,
        height: '100%',
        overflowY: 'auto',
        px: { xs: 2, sm: 4 },
        pt: 5,
        pb: 3,
      }}
    >
      <AccountLoading
        loading={account.isLoading}
        error={account.error}
        retry={account.refetch}
      >
        <AccountAuth welcome />
      </AccountLoading>
    </Box>
  )
}
