import { ContentCopyOutlined, OpenInNewRounded } from '@mui/icons-material'
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, FormControlLabel, Stack, Switch, TextField, Typography } from '@mui/material'
import { useState } from 'react'

import { useAccountQuery, useAccountTask, useAccountText } from '@/hooks/use-xboard'
import { accountWrite, copyAccountLink, openAccountWebsite } from '@/services/xboard'

import { accountMoney, flag } from './format'
import { AccountConfirm, AccountLoading, AccountPanel, SectionHeading, TaskMessage } from './shared'

export interface AccountConfig {
  currency_symbol?: string
  is_telegram?: number | boolean
  telegram_discuss_link?: string
  withdraw_close?: number | boolean
  withdraw_methods?: string[]
  commission_distribution_enable?: number | boolean
  commission_distribution_l1?: number
  commission_distribution_l2?: number
  commission_distribution_l3?: number
}
interface UserInfo { email: string; balance: number; remind_expire: boolean | number; remind_traffic: boolean | number; telegram_id?: number | null }

export function AccountSettings() {
  const info = useAccountQuery<UserInfo>('user_info')
  const config = useAccountQuery<AccountConfig>('user_config')
  const text = useAccountText()
  return <><SectionHeading title={text('账号设置', 'Account settings')} action={<Button disabled={info.isFetching || config.isFetching} onClick={() => { void info.refetch(); void config.refetch() }}>{text('刷新', 'Refresh')}</Button>} /><AccountLoading loading={info.isLoading || config.isLoading} error={info.error || config.error} retry={() => Promise.all([info.refetch(), config.refetch()])}>
    {info.data && config.data && <AccountSettingsForm info={info.data.data} config={config.data.data} refresh={async () => { await info.refetch() }} />}
  </AccountLoading></>
}

function AccountSettingsForm({ info, config, refresh }: { info: UserInfo; config: AccountConfig; refresh: () => Promise<void> }) {
  const text = useAccountText()
  const task = useAccountTask()
  const [expiry, setExpiry] = useState(flag(info.remind_expire))
  const [traffic, setTraffic] = useState(flag(info.remind_traffic))
  const [dialog, setDialog] = useState<'password' | 'reset' | null>(null)
  const [telegram, setTelegram] = useState(false)
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const botQuery = useAccountQuery<{ username: string }>('telegram_bot', {}, telegram)
  const bot = botQuery.data?.data.username
  const validBot = bot && /^[A-Za-z0-9_]{4,32}$/.test(bot)
  let group: string | null = null
  try {
    const url = new URL(config.telegram_discuss_link ?? '')
    if (url.protocol === 'https:' && ['t.me', 'telegram.me'].includes(url.hostname) && !url.username && !url.password && (!url.port || url.port === '443') && url.pathname !== '/') group = url.href
  } catch { /* The configured group is optional. */ }

  const clearPassword = () => { setOldPassword(''); setNewPassword(''); setConfirmation(''); setPasswordError('') }
  const savePassword = async () => {
    if (!oldPassword || Array.from(newPassword).length < 8 || newPassword !== confirmation) {
      setPasswordError(text('请填写旧密码；新密码至少 8 个字符，且两次输入一致。', 'Enter your current password and matching new passwords of at least 8 characters.'))
      return
    }
    const success = await task.run(async () => {
      try { await accountWrite('change_password', { old_password: oldPassword, new_password: newPassword }) }
      finally { clearPassword() }
    }, text('密码已修改，其他会话需重新登录。', 'Password changed. Other sessions need to sign in again.'))
    if (success) setDialog(null)
  }

  return <Stack spacing={2}>
    <TaskMessage message={task.message} />
    <AccountPanel><Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={2}><Box><Typography fontWeight={600}>{info.email}</Typography><Typography color="text.secondary" variant="body2">{text('账户余额（仅消费）', 'Balance (purchases only)')}</Typography><Typography variant="h5" sx={{ mt: 1 }}>{accountMoney(info.balance, config.currency_symbol)}</Typography></Box><Button disabled={task.busy} onClick={() => { clearPassword(); setDialog('password') }}>{text('修改密码', 'Change password')}</Button></Stack></AccountPanel>
    <AccountPanel><Typography variant="h6" sx={{ mb: 1 }}>{text('通知设置', 'Email notifications')}</Typography><Stack><FormControlLabel label={text('到期邮件提醒', 'Expiration reminders')} control={<Switch checked={expiry} disabled={task.busy} onChange={(_, checked) => setExpiry(checked)} />} /><FormControlLabel label={text('流量邮件提醒', 'Usage reminders')} control={<Switch checked={traffic} disabled={task.busy} onChange={(_, checked) => setTraffic(checked)} />} /></Stack><Button variant="outlined" disabled={task.busy} sx={{ mt: 1 }} onClick={() => { void task.run(async () => { await accountWrite('user_update', { remind_expire: expiry ? '1' : '0', remind_traffic: traffic ? '1' : '0' }); await refresh() }, text('通知设置已保存', 'Notification settings saved')) }}>{text('保存通知设置', 'Save notifications')}</Button></AccountPanel>
    {(flag(config.is_telegram) || group) && <AccountPanel><Typography variant="h6" sx={{ mb: 1 }}>Telegram</Typography><Stack direction="row" flexWrap="wrap" gap={1}>{flag(config.is_telegram) && (Number(info.telegram_id) > 0 ? <Typography color="text.secondary">{text('Telegram 已绑定', 'Telegram connected')}</Typography> : <Button onClick={() => setTelegram(!telegram)}>{text('绑定 Telegram', 'Connect Telegram')}</Button>)}{group && <Button endIcon={<OpenInNewRounded />} onClick={() => { void task.run(() => openAccountWebsite(group!, true)) }}>{text('加入 Telegram 讨论组', 'Open Telegram group')}</Button>}</Stack>{telegram && <Box sx={{ mt: 2 }}><AccountLoading loading={botQuery.isLoading} error={botQuery.error} retry={botQuery.refetch}>{validBot && <Stack spacing={2}><Typography variant="body2">{text(`复制绑定指令，然后私聊发送给 @${bot}。指令中包含你的个人订阅地址。`, `Copy the binding command and send it privately to @${bot}. It contains your private subscription link.`)}</Typography><Stack direction="row" gap={1} flexWrap="wrap"><Button startIcon={<ContentCopyOutlined />} disabled={task.busy} onClick={() => { void task.run(() => copyAccountLink(true), text('绑定指令已复制', 'Binding command copied')) }}>{text('复制绑定指令', 'Copy binding command')}</Button><Button endIcon={<OpenInNewRounded />} disabled={task.busy} onClick={() => { void task.run(() => openAccountWebsite(`https://t.me/${bot}`, true)) }}>{text('打开机器人', 'Open bot')}</Button></Stack></Stack>}</AccountLoading></Box>}</AccountPanel>}
    <AccountPanel><Typography variant="h6">{text('订阅信息', 'Subscription credentials')}</Typography><Typography variant="body2" color="text.secondary" sx={{ my: 1 }}>{text('重置后旧订阅地址和节点凭据立即失效，其他设备需要重新导入。', 'Resetting invalidates the old link and node credentials. Other devices will need to import the new subscription.')}</Typography><Divider sx={{ my: 2 }} /><Button color="warning" disabled={task.busy} onClick={() => setDialog('reset')}>{text('重置订阅信息', 'Reset subscription')}</Button></AccountPanel>
    {dialog === 'reset' && <AccountConfirm title={text('重置订阅信息', 'Reset subscription')} busy={task.busy} onClose={() => setDialog(null)} onConfirm={() => { void task.run(async () => { await accountWrite('reset_security'); setDialog(null) }, text('订阅已重置并同步到本机', 'Subscription reset and synchronized')) }}>{text('确定重置订阅地址和节点凭据？旧地址将立即失效，其他设备需要重新导入订阅。', 'Reset the subscription URL and node credentials? The old URL will stop working and other devices must import the new subscription.')}</AccountConfirm>}
    {dialog === 'password' && <Dialog open maxWidth="xs" fullWidth onClose={task.busy ? undefined : () => { clearPassword(); setDialog(null) }}><Box component="form" onSubmit={(event) => { event.preventDefault(); void savePassword() }}><DialogTitle>{text('修改密码', 'Change password')}</DialogTitle><DialogContent><Stack spacing={2} sx={{ pt: 1 }}><TaskMessage message={task.message} />{passwordError && <Alert severity="warning">{passwordError}</Alert>}<TextField label={text('旧密码', 'Current password')} type="password" autoComplete="current-password" value={oldPassword} required disabled={task.busy} onChange={(event) => setOldPassword(event.target.value)} /><TextField label={text('新密码', 'New password')} type="password" autoComplete="new-password" value={newPassword} required disabled={task.busy} onChange={(event) => setNewPassword(event.target.value)} /><TextField label={text('确认新密码', 'Confirm password')} type="password" autoComplete="new-password" value={confirmation} required disabled={task.busy} onChange={(event) => setConfirmation(event.target.value)} /></Stack></DialogContent><DialogActions><Button disabled={task.busy} onClick={() => { clearPassword(); setDialog(null) }}>{text('取消', 'Cancel')}</Button><Button type="submit" disabled={task.busy}>{text('保存', 'Save')}</Button></DialogActions></Box></Dialog>}
  </Stack>
}
