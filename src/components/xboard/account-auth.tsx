import { AccountCircleOutlined, ArrowForwardRounded, LockOutlined } from '@mui/icons-material'
import { Alert, Box, Button, Checkbox, FormControlLabel, Stack, Tab, Tabs, TextField, Typography } from '@mui/material'
import { useEffect, useState } from 'react'

import { useAccountQuery, useAccountTask, useAccountText } from '@/hooks/use-xboard'
import { accountWrite, completeOnboarding, openAccountWebsite, registerAccount, signIn } from '@/services/xboard'

import { flag } from './format'
import { AccountLoading, AccountPanel, TaskMessage } from './shared'

interface RegistrationPolicy {
  is_email_verify: boolean | number
  is_invite_force: boolean | number
  is_captcha?: boolean | number
  is_recaptcha?: boolean | number
  email_whitelist_suffix?: string[]
  tos_url?: string
}

export function AccountAuth({ welcome = false }: { welcome?: boolean }) {
  const text = useAccountText()
  const task = useAccountTask()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [code, setCode] = useState('')
  const [invite, setInvite] = useState('')
  const [accepted, setAccepted] = useState(false)
  const [validation, setValidation] = useState('')
  const [remaining, setRemaining] = useState(0)
  const policyQuery = useAccountQuery<RegistrationPolicy>('registration_policy', {}, mode === 'register')
  const policy = policyQuery.data?.data
  const captcha = flag(policy?.is_captcha ?? policy?.is_recaptcha)
  const emailRequired = flag(policy?.is_email_verify)
  const inviteRequired = flag(policy?.is_invite_force)
  const terms = policy?.tos_url

  useEffect(() => {
    if (remaining <= 0) return
    const timer = window.setTimeout(() => setRemaining((value) => Math.max(0, value - 1)), 1000)
    return () => window.clearTimeout(timer)
  }, [remaining])

  const checkEmail = () => {
    const value = email.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return text('请输入有效的邮箱地址。', 'Enter a valid email address.')
    const domains = policy?.email_whitelist_suffix ?? []
    if (mode === 'register' && domains.length && !domains.some((domain) => domain.toLowerCase() === value.split('@')[1].toLowerCase())) {
      return `${text('支持的邮箱后缀：', 'Allowed email domains: ')}${domains.join(', ')}`
    }
    return ''
  }

  const submit = async () => {
    setValidation('')
    if (mode === 'register' && captcha) {
      await task.run(() => openAccountWebsite('https://ikun.iil.im/#/register'))
      return
    }
    const invalid = checkEmail() || (!password ? text('请填写密码。', 'Enter your password.') : '')
    if (invalid) { setValidation(invalid); return }
    if (mode === 'register') {
      if (!policy) return
      if (Array.from(password).length < 8) { setValidation(text('密码至少需要 8 个字符。', 'Use at least 8 characters.')); return }
      if (password !== confirm) { setValidation(text('两次输入的密码不一致。', 'Passwords do not match.')); return }
      if (emailRequired && !/^\d{6}$/.test(code.trim())) { setValidation(text('请输入 6 位邮箱验证码。', 'Enter the six-digit email code.')); return }
      if (inviteRequired && !invite.trim()) { setValidation(text('请填写邀请码。', 'Enter an invitation code.')); return }
      if (terms && !accepted) { setValidation(text('请阅读并同意服务条款。', 'Read and accept the terms.')); return }
    }
    await task.run(async () => {
      try {
        const result = mode === 'login' ? await signIn(email, password) : await registerAccount({
          email: email.trim(), password, email_code: emailRequired ? code.trim() : '', invite_code: invite.trim(),
        })
        if (result.signed_in && welcome) await completeOnboarding()
        if (!result.signed_in) throw new Error(text('账号已创建，请返回登录。', 'Your account was created. Please sign in.'))
      } finally { setPassword(''); setConfirm(''); setCode('') }
    })
  }

  const sendCode = async () => {
    const invalid = checkEmail()
    setValidation(invalid)
    if (invalid || remaining > 0) return
    setRemaining(60)
    await task.run(() => accountWrite('send_email_code', { email: email.trim() }), text('验证码已发送，请查收邮件。', 'Verification code sent. Check your email.'))
  }

  return <Box sx={{ width: '100%', maxWidth: 460, mx: 'auto', py: welcome ? 3 : 1 }}>
    <Stack spacing={1} alignItems="center" sx={{ mb: 3 }}>
      <AccountCircleOutlined sx={{ fontSize: 54, color: 'primary.main' }} />
      <Typography variant="h4" fontWeight={700}>{welcome ? text('欢迎使用 IKUN Clash', 'Welcome to IKUN Clash') : text('登录账户', 'Sign in')}</Typography>
      <Typography color="text.secondary" textAlign="center">{text('登录会员账号，自动同步套餐与订阅。', 'Sign in to sync your membership and subscription.')}</Typography>
    </Stack>
    <AccountPanel>
      <Tabs value={mode} onChange={(_, value: 'login' | 'register') => { setMode(value); setValidation(''); setPassword(''); setConfirm('') }} variant="fullWidth" sx={{ mb: 3 }}>
        <Tab value="login" label={text('登录', 'Sign in')} disabled={task.busy} /><Tab value="register" label={text('注册账号', 'Register')} disabled={task.busy} />
      </Tabs>
      <TaskMessage message={task.message} />
      {validation && <Alert severity="warning" sx={{ mb: 2 }}>{validation}</Alert>}
      <AccountLoading loading={mode === 'register' && policyQuery.isLoading} error={mode === 'register' && policyQuery.error} retry={policyQuery.refetch}>
        <Box component="form" onSubmit={(event) => { event.preventDefault(); void submit() }}>
          <Stack spacing={2}>
            {mode === 'register' && captcha ? <Alert severity="info">{text('站点要求在浏览器完成人机验证。注册完成后，返回应用登录。', 'Complete registration and the security challenge in your browser, then return to sign in.')}</Alert> : <>
              <TextField label={text('邮箱', 'Email')} value={email} type="email" autoComplete="username" required disabled={task.busy} onChange={(event) => setEmail(event.target.value)} />
              <TextField label={text('密码', 'Password')} value={password} type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required disabled={task.busy} onChange={(event) => setPassword(event.target.value)} />
              {mode === 'register' && <>
                <TextField label={text('确认密码', 'Confirm password')} value={confirm} type="password" autoComplete="new-password" required disabled={task.busy} onChange={(event) => setConfirm(event.target.value)} />
                {emailRequired && <Stack direction="row" spacing={1} alignItems="center">
                  <TextField label={text('邮箱验证码', 'Email code')} value={code} required disabled={task.busy} autoComplete="one-time-code" slotProps={{ htmlInput: { inputMode: 'numeric', maxLength: 6 } }} onChange={(event) => setCode(event.target.value)} sx={{ flex: 1 }} />
                  <Button disabled={task.busy || remaining > 0} onClick={() => { void sendCode() }} sx={{ flexShrink: 0 }}>{remaining > 0 ? `${remaining}s` : text('发送验证码', 'Send code')}</Button>
                </Stack>}
                <TextField label={inviteRequired ? text('邀请码', 'Invitation code') : text('邀请码（选填）', 'Invitation code (optional)')} value={invite} required={inviteRequired} disabled={task.busy} onChange={(event) => setInvite(event.target.value)} />
                {terms && <Box><Button size="small" onClick={() => { void task.run(() => openAccountWebsite(terms)) }}>{text('查看服务条款', 'Read terms')}</Button><FormControlLabel control={<Checkbox checked={accepted} disabled={task.busy} onChange={(_, checked) => setAccepted(checked)} />} label={text('我已阅读并同意服务条款', 'I accept the terms of service')} /></Box>}
              </>}
            </>}
            <Button type="submit" variant="contained" size="large" endIcon={<ArrowForwardRounded />} disabled={task.busy || (mode === 'register' && !policy)}>
              {task.busy ? text('处理中…', 'Working…') : mode === 'login' ? text('登录并同步订阅', 'Sign in and sync') : captcha ? text('前往网站注册', 'Register on website') : text('注册账号', 'Create account')}
            </Button>
          </Stack>
        </Box>
      </AccountLoading>
    </AccountPanel>
    <Stack direction="row" justifyContent="center" spacing={0.5} sx={{ mt: 2, color: 'text.secondary' }}><LockOutlined sx={{ fontSize: 16 }} /><Typography variant="caption">ikun.iil.im</Typography></Stack>
    {welcome && <Button fullWidth sx={{ mt: 1 }} disabled={task.busy} onClick={() => { void task.run(completeOnboarding) }}>{text('暂时跳过，进入客户端', 'Skip for now and open the client')}</Button>}
  </Box>
}
