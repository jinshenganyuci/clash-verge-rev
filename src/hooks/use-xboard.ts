import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { accountError } from '@/components/xboard/errors'
import { useQuery } from '@/services/query-client'
import { accountKey, accountRequest, readAccount, type AccountOperation, type AccountParams } from '@/services/xboard'

export const useXboard = () => useQuery({
  queryKey: accountKey, queryFn: readAccount, retry: false,
  refetchOnWindowFocus: true,
})

export function useAccountQuery<T>(operation: AccountOperation, params: AccountParams = {}, enabled = true) {
  const { data: account } = useXboard()
  return useQuery({
    queryKey: ['xboard', account?.email, operation, params],
    queryFn: () => accountRequest<T>(operation, params),
    enabled: enabled && (operation === 'registration_policy' || account?.signed_in === true),
    retry: false,
  })
}

export function useAccountText() {
  const { i18n } = useTranslation()
  return useCallback((zh: string, en: string) => i18n.language.startsWith('zh') ? zh : en, [i18n.language])
}

export function useAccountTask() {
  const text = useAccountText()
  const active = useRef(false)
  const mounted = useRef(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ severity: 'error' | 'success'; text: string } | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const run = async (action: () => Promise<unknown>, success?: string) => {
    if (active.current) return false
    active.current = true
    setBusy(true)
    setMessage(null)
    try {
      await action()
      if (mounted.current && success) setMessage({ severity: 'success', text: success })
      return true
    } catch (error) {
      const detail = accountError(error, text('zh', 'en') === 'zh')
      if (mounted.current) setMessage({ severity: 'error', text: detail || text('请求未完成，请检查网络后重试。', 'The request failed. Check your connection and try again.') })
      return false
    } finally {
      active.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return { busy, message, run }
}
