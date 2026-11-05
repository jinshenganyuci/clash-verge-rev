import {
  AccountCircleOutlined,
  ContentCopyOutlined,
  RefreshRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Chip,
  LinearProgress,
  Stack,
  Typography,
} from '@mui/material'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'

import { EnhancedCard } from '@/components/home/enhanced-card'
import { useAccountTask, useAccountText, useXboard } from '@/hooks/use-xboard'
import { copyAccountLink, refreshAccount, signOut } from '@/services/xboard'

import { accountError } from './errors'
import { accountBytes, accountDate } from './format'
import { AccountConfirm, AccountPanel, TaskMessage } from './shared'

export function AccountOverview() {
  const { data: account } = useXboard()
  const text = useAccountText()
  const task = useAccountTask()
  const [logout, setLogout] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const sub = account?.subscription
  const expired = sub?.expired_at != null && sub.expired_at <= now / 1000
  const used = (sub?.upload ?? 0) + (sub?.download ?? 0)
  const available = sub?.plan_id != null && !expired
  return (
    <AccountPanel>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent="space-between"
        spacing={2}
      >
        <Box>
          <Typography variant="overline" color="primary">
            {text('我的套餐', 'My plan')}
          </Typography>
          <Typography variant="h5" fontWeight={700}>
            {sub?.plan_name ||
              (sub?.plan_id != null
                ? text('已订阅套餐', 'Subscribed plan')
                : text('暂无套餐', 'No active plan'))}
          </Typography>
          <Typography color="text.secondary" sx={{ mt: 1 }}>
            {account?.email}
          </Typography>
        </Box>
        <Box>
          <Chip
            size="small"
            color={available ? 'success' : 'default'}
            label={
              expired
                ? text('套餐已到期', 'Plan expired')
                : available
                  ? text('有效', 'Active')
                  : text('暂无套餐', 'No plan')
            }
          />
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {sub?.expired_at
              ? `${text('到期时间：', 'Expires: ')}${accountDate(sub.expired_at)}`
              : available
                ? text('长期有效', 'No expiration')
                : ''}
          </Typography>
        </Box>
      </Stack>
      {!!sub?.total && (
        <Box sx={{ mt: 3 }}>
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="body2">
              {text('已用流量', 'Data usage')}
            </Typography>
            <Typography variant="body2">
              {accountBytes(used)} / {accountBytes(sub.total)}
            </Typography>
          </Stack>
          <LinearProgress
            variant="determinate"
            value={Math.min(100, Math.max(0, (used / sub.total) * 100))}
            sx={{ height: 8, borderRadius: 5, mt: 1 }}
          />
        </Box>
      )}
      {account?.last_sync != null && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mt: 2 }}
        >
          {text('配置更新时间：', 'Last synced: ')}
          {accountDate(account.last_sync)}
        </Typography>
      )}
      {account?.error && (
        <Alert severity="warning" sx={{ mt: 2 }}>
          {accountError(account.error, text('zh', 'en') === 'zh')}
        </Alert>
      )}
      {available && !account?.profile_uid && (
        <Alert severity="info" sx={{ mt: 2 }}>
          {text(
            '暂无可用订阅，请稍后更新。',
            'No usable subscription yet. Try refreshing later.',
          )}
        </Alert>
      )}
      <TaskMessage message={task.message} />
      <Stack direction="row" flexWrap="wrap" gap={1} sx={{ mt: 3 }}>
        <Button
          startIcon={<RefreshRounded />}
          variant="contained"
          disabled={task.busy}
          onClick={() => {
            void task.run(
              () => refreshAccount(true),
              text('套餐与订阅已更新', 'Membership and subscription updated'),
            )
          }}
        >
          {text('立即更新订阅', 'Refresh subscription')}
        </Button>
        <Button
          startIcon={<ContentCopyOutlined />}
          disabled={task.busy || !available}
          onClick={() => {
            void task.run(
              () => copyAccountLink(),
              text('订阅地址已复制', 'Subscription link copied'),
            )
          }}
        >
          {text('复制订阅地址', 'Copy subscription link')}
        </Button>
        <Button
          color="inherit"
          disabled={task.busy}
          onClick={() => setLogout(true)}
          sx={{ ml: { sm: 'auto' } }}
        >
          {text('退出账号', 'Sign out')}
        </Button>
      </Stack>
      {logout && (
        <AccountConfirm
          title={text('退出账号', 'Sign out')}
          busy={task.busy}
          onClose={() => setLogout(false)}
          onConfirm={() => {
            void task.run(signOut)
          }}
        >
          {text(
            '退出账号并移除本机的账号订阅？其他手动订阅会保留。',
            'Sign out and remove this account’s subscription from this device? Your manual subscriptions will be kept.',
          )}
        </AccountConfirm>
      )}
    </AccountPanel>
  )
}

export function HomeAccountCard() {
  const { data: account } = useXboard()
  const text = useAccountText()
  const navigate = useNavigate()
  const sub = account?.subscription
  return (
    <EnhancedCard
      title={text('账户', 'Account')}
      icon={<AccountCircleOutlined />}
      action={
        <Button size="small" onClick={() => navigate('/account')}>
          {account?.signed_in
            ? text('查看账户', 'View account')
            : text('登录 / 注册', 'Sign in / Register')}
        </Button>
      }
    >
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent="space-between"
        spacing={1}
      >
        <Box>
          <Typography fontWeight={600}>
            {account?.signed_in
              ? sub?.plan_name || text('暂无套餐', 'No active plan')
              : text('登录后自动同步订阅', 'Sign in to sync your subscription')}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {account?.signed_in
              ? account.email
              : text(
                  '套餐、节点和账号服务',
                  'Membership, nodes and account services',
                )}
          </Typography>
        </Box>
        {sub?.plan_id != null && (
          <Box>
            {sub.total > 0 && (
              <Typography variant="body2">
                {accountBytes(sub.upload + sub.download)} /{' '}
                {accountBytes(sub.total)}
              </Typography>
            )}
            <Typography variant="caption" color="text.secondary">
              {sub.expired_at != null
                ? accountDate(sub.expired_at)
                : text('长期有效', 'No expiration')}
            </Typography>
          </Box>
        )}
      </Stack>
    </EnhancedCard>
  )
}
