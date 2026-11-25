import { useCallback, useEffect, useState } from 'react'

import { fetchCacheData, useQuery } from '@/services/query-client'
import {
  checkUpdateSafe,
  IKUN_UPDATE_KEY,
  LAST_CHECK_KEY,
  readLastCheckTime,
  UPDATE_CHECK_INTERVAL,
} from '@/services/update'

import { useVerge } from './use-verge'

export { readLastCheckTime, updateLastCheckTime } from '@/services/update'

const fetchAutomaticUpdate = () => checkUpdateSafe('automatic')

export const useUpdate = (enabled: boolean = true) => {
  const { verge } = useVerge()
  const [checkingManually, setCheckingManually] = useState(false)
  const automaticEnabled =
    enabled && verge !== undefined && verge.auto_check_ikun_update !== false

  useEffect(() => {
    if (!automaticEnabled) return
    const check = () => {
      void fetchCacheData(IKUN_UPDATE_KEY, fetchAutomaticUpdate).catch(() => {
        // Automatic failures stay silent; the next scheduled or manual check can retry.
      })
    }
    check()
    const timer = window.setInterval(check, UPDATE_CHECK_INTERVAL)
    return () => window.clearInterval(timer)
  }, [automaticEnabled])

  // Passive viewers observe the same result without starting another check.
  const { data: updateInfo, isFetching } = useQuery({
    queryKey: IKUN_UPDATE_KEY,
    queryFn: fetchAutomaticUpdate,
    retry: false,
    revalidateOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  const checkUpdate = useCallback(async () => {
    setCheckingManually(true)
    try {
      const data = await fetchCacheData(IKUN_UPDATE_KEY, () =>
        checkUpdateSafe('manual'),
      )
      return { data }
    } finally {
      setCheckingManually(false)
    }
  }, [])

  const { data: lastCheckUpdate } = useQuery({
    queryKey: [LAST_CHECK_KEY],
    queryFn: readLastCheckTime,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  return {
    updateInfo,
    checkUpdate,
    automaticEnabled,
    loading: checkingManually || isFetching,
    lastCheckUpdate: lastCheckUpdate ?? null,
  }
}
