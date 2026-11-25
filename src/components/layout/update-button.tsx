import { Button } from '@mui/material'
import { useEffect, useRef } from 'react'

import { DialogRef } from '@/components/base'
import { useUpdate } from '@/hooks/use-update'
import { useAccountText } from '@/hooks/use-xboard'
import { markUpdatePrompted } from '@/services/update'

import { UpdateViewer } from '../setting/mods/update-viewer'

interface Props {
  className?: string
}

export const UpdateButton = (props: Props) => {
  const { className } = props
  const viewerRef = useRef<DialogRef>(null)
  const text = useAccountText()

  const { updateInfo } = useUpdate(false)

  if (!updateInfo) return null

  return (
    <>
      <UpdateViewer ref={viewerRef} />

      <Button
        color="error"
        variant="contained"
        size="small"
        className={className}
        onClick={() => viewerRef.current?.open()}
      >
        {text('有新版本', 'Update available')}
      </Button>
    </>
  )
}

export function UpdatePrompt({
  allowPrompt = true,
}: {
  allowPrompt?: boolean
}) {
  const viewerRef = useRef<DialogRef>(null)
  const { updateInfo, automaticEnabled } = useUpdate()

  useEffect(() => {
    if (
      allowPrompt &&
      automaticEnabled &&
      updateInfo &&
      markUpdatePrompted(updateInfo.version)
    ) {
      viewerRef.current?.open()
    }
  }, [allowPrompt, automaticEnabled, updateInfo])

  return <UpdateViewer ref={viewerRef} />
}
