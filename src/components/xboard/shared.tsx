import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Paper,
  Stack,
  Typography,
} from '@mui/material'
import type { ReactNode } from 'react'

import { useAccountText } from '@/hooks/use-xboard'

export function AccountPanel({ children }: { children: ReactNode }) {
  return (
    <Paper
      variant="outlined"
      sx={{ p: { xs: 2, sm: 3 }, borderRadius: 3, overflowWrap: 'anywhere' }}
    >
      {children}
    </Paper>
  )
}

export function AccountLoading({
  error,
  loading,
  empty,
  retry,
  children,
}: {
  error: unknown
  loading: boolean
  empty?: boolean
  retry: () => unknown
  children: ReactNode
}) {
  const text = useAccountText()
  if (loading)
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
        <CircularProgress size={28} aria-label={text('正在加载', 'Loading')} />
      </Box>
    )
  if (error)
    return (
      <Alert
        severity="error"
        action={
          <Button
            color="inherit"
            onClick={() => {
              void retry()
            }}
          >
            {text('重试', 'Retry')}
          </Button>
        }
      >
        {text(
          '暂时无法读取，请检查网络并重试。',
          'Unable to load. Check your connection and retry.',
        )}
      </Alert>
    )
  if (empty)
    return (
      <AccountPanel>
        <Typography color="text.secondary">
          {text('暂无记录', 'No records yet')}
        </Typography>
      </AccountPanel>
    )
  return <>{children}</>
}

export function TaskMessage({
  message,
}: {
  message: { severity: 'error' | 'success'; text: string } | null
}) {
  return message ? (
    <Alert severity={message.severity} sx={{ my: 2 }}>
      {message.text}
    </Alert>
  ) : null
}

export function AccountConfirm({
  title,
  children,
  onConfirm,
  onClose,
  busy,
}: {
  title: string
  children: ReactNode
  onConfirm: () => void
  onClose: () => void
  busy: boolean
}) {
  const text = useAccountText()
  return (
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <DialogContentText>{children}</DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {text('取消', 'Cancel')}
        </Button>
        <Button color="warning" onClick={onConfirm} disabled={busy}>
          {busy ? text('处理中…', 'Working…') : text('确认', 'Confirm')}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export function SectionHeading({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <Stack
      direction="row"
      sx={{
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 2,
        mb: 2,
      }}
    >
      <Box>
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
        {description && (
          <Typography variant="body2" color="text.secondary">
            {description}
          </Typography>
        )}
      </Box>
      {action}
    </Stack>
  )
}
