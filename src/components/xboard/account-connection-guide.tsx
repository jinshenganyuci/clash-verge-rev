import { CheckCircleOutlineRounded, ShieldOutlined } from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  LinearProgress,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Typography,
} from '@mui/material'
import { useEffect, useRef, useState } from 'react'

import {
  useAccountTask,
  useAccountText,
  useConnectionGuide,
} from '@/hooks/use-xboard'
import {
  cancelConnectionGuide,
  completeConnectionGuide,
  connectAccount,
  prepareConnectionGuide,
  type ConnectionMode,
} from '@/services/xboard'

import { accountError } from './errors'
import { TaskMessage } from './shared'

export function AccountConnectionGuide() {
  const text = useAccountText()
  const guide = useConnectionGuide()
  const work = useAccountTask()
  const connection = useAccountTask()
  const cancellation = useAccountTask()
  const completion = useAccountTask()
  const preparedRef = useRef(false)
  const completedAttemptRef = useRef<number | null>(null)
  const [mode, setMode] = useState<ConnectionMode>('tun')
  const state = guide.data
  const phase = state?.phase ?? 'idle'
  const { run } = work
  const finish = completion.run

  useEffect(() => {
    if (state?.phase !== 'idle' || preparedRef.current) return
    preparedRef.current = true
    void run(prepareConnectionGuide)
  }, [state?.phase, run])

  useEffect(() => {
    if (
      state?.phase !== 'succeeded' ||
      completedAttemptRef.current === state.attempt_id
    )
      return
    const attemptId = state.attempt_id
    const timer = window.setTimeout(() => {
      completedAttemptRef.current = attemptId
      void finish(() => completeConnectionGuide(attemptId))
    }, 1000)
    return () => window.clearTimeout(timer)
  }, [state?.phase, state?.attempt_id, finish])

  const ready = phase === 'ready'
  const connectionFailed =
    phase === 'failed' && state?.error_stage === 'connect'
  const successful = phase === 'succeeded'
  const connecting = phase === 'connecting' || connection.busy
  const failed = phase === 'failed'
  const showModes = ready || connectionFailed
  const waiting = !ready && !failed && !successful && !guide.error
  const progress =
    state && state.total > 0
      ? Math.min(100, Math.round((state.tested / state.total) * 100))
      : undefined
  const title = successful
    ? text('连接成功', 'Connected')
    : connecting
      ? text('正在连接', 'Connecting')
      : showModes
        ? text('线路已准备好', 'Your connection is ready')
        : failed || guide.error
          ? text('暂时无法完成准备', 'Setup could not be completed')
          : phase === 'testing'
            ? text('正在检测可用线路', 'Checking available connections')
            : text('正在同步订阅', 'Syncing your subscription')

  return (
    <Dialog
      open
      disableEscapeKeyDown
      maxWidth="sm"
      fullWidth
      aria-labelledby="account-connection-title"
      slotProps={{ paper: { sx: { borderRadius: 3 } } }}
    >
      <DialogTitle id="account-connection-title">
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          {successful ? (
            <CheckCircleOutlineRounded color="success" />
          ) : (
            <ShieldOutlined color="primary" />
          )}
          <span>{text('开始使用 IKUN', 'Get started with IKUN')}</span>
        </Stack>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Box aria-live="polite">
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              {title}
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 0.5 }}>
              {successful
                ? text(
                    '线路已连接，正在进入 IKUN。',
                    'You are connected. Opening IKUN…',
                  )
                : connecting
                  ? text(
                      '正在应用你选择的连接方式，请稍候。',
                      'Applying your connection settings. Please wait.',
                    )
                  : showModes
                    ? text(
                        '已自动选择可用线路。请选择连接方式。',
                        'An available connection has been selected. Choose how to connect.',
                      )
                    : text(
                        '同步订阅后，自动检测并选择可用线路。',
                        'We will sync your subscription, check the connections and select an available route.',
                      )}
            </Typography>
          </Box>
          {waiting && (
            <LinearProgress
              aria-label={title}
              variant={
                phase === 'testing' && progress !== undefined
                  ? 'determinate'
                  : 'indeterminate'
              }
              value={progress}
            />
          )}
          {phase === 'testing' && state && state.total > 0 && (
            <Typography variant="body2" color="text.secondary">
              {text('已检测', 'Checked')} {state.tested} / {state.total}
            </Typography>
          )}
          {state?.node_name && (showModes || connecting || successful) && (
            <Paper
              variant="outlined"
              sx={{ p: 2, borderRadius: 2, overflowWrap: 'anywhere' }}
            >
              <Typography variant="body2" color="text.secondary">
                {text('当前线路', 'Selected connection')}
              </Typography>
              <Typography sx={{ fontWeight: 600 }}>
                {state.node_name}
              </Typography>
              {state.latency_ms != null && (
                <Typography variant="body2" color="text.secondary">
                  {text('延迟', 'Latency')} {state.latency_ms} ms
                </Typography>
              )}
            </Paper>
          )}
          {state?.error && (
            <Alert severity="error">
              {accountError(state.error, text('zh', 'en') === 'zh')}
            </Alert>
          )}
          {guide.error && (
            <Alert severity="error">
              {text(
                '暂时无法读取准备进度，请重试。',
                'Unable to read setup progress. Please retry.',
              )}
            </Alert>
          )}
          <TaskMessage message={work.message} />
          <TaskMessage message={connection.message} />
          <TaskMessage message={cancellation.message} />
          <TaskMessage message={completion.message} />
          {showModes && (
            <RadioGroup
              value={mode}
              aria-label={text('连接方式', 'Connection mode')}
              onChange={(_, value) =>
                setMode(value === 'system' ? 'system' : 'tun')
              }
            >
              <Paper variant="outlined" sx={{ p: 1.5, mb: 1, borderRadius: 2 }}>
                <FormControlLabel
                  value="tun"
                  disabled={work.busy || connection.busy || cancellation.busy}
                  control={<Radio />}
                  label={
                    <Box>
                      <Typography sx={{ fontWeight: 600 }}>
                        {text('虚拟网卡模式（推荐）', 'TUN mode (recommended)')}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {text(
                          '接管更多应用的网络连接，可能需要管理员授权。',
                          'Connects more applications. Administrator permission may be required.',
                        )}
                      </Typography>
                    </Box>
                  }
                />
              </Paper>
              <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
                <FormControlLabel
                  value="system"
                  disabled={work.busy || connection.busy || cancellation.busy}
                  control={<Radio />}
                  label={
                    <Box>
                      <Typography sx={{ fontWeight: 600 }}>
                        {text('系统代理', 'System proxy')}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {text(
                          '适用于浏览器等遵循系统代理设置的应用。',
                          'Connects browsers and other applications that use system proxy settings.',
                        )}
                      </Typography>
                    </Box>
                  }
                />
              </Paper>
            </RadioGroup>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 3, gap: 1 }}>
        {!successful && (
          <Button
            disabled={connecting || cancellation.busy}
            onClick={() => {
              void cancellation.run(cancelConnectionGuide)
            }}
          >
            {cancellation.busy
              ? text('正在取消…', 'Cancelling…')
              : text('暂不连接', 'Not now')}
          </Button>
        )}
        {successful && completion.message?.severity === 'error' && state && (
          <Button
            variant="contained"
            disabled={completion.busy}
            onClick={() => {
              void finish(() => completeConnectionGuide(state.attempt_id))
            }}
          >
            {text('进入 IKUN', 'Open IKUN')}
          </Button>
        )}
        {guide.error ? (
          <Button
            variant="contained"
            onClick={() => {
              void guide.refetch()
            }}
          >
            {text('重试', 'Retry')}
          </Button>
        ) : showModes && state ? (
          <Button
            variant="contained"
            disabled={work.busy || connection.busy || cancellation.busy}
            onClick={() => {
              void connection.run(() => connectAccount(state.attempt_id, mode))
            }}
          >
            {connectionFailed
              ? text('重试连接', 'Retry connection')
              : text('开始使用', 'Start using IKUN')}
          </Button>
        ) : (
          (failed || work.message?.severity === 'error') && (
            <Button
              variant="contained"
              disabled={work.busy || cancellation.busy}
              onClick={() => {
                void run(prepareConnectionGuide)
              }}
            >
              {text('重新检测', 'Check again')}
            </Button>
          )
        )}
      </DialogActions>
    </Dialog>
  )
}
