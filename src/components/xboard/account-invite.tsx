import { ContentCopyOutlined } from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { useState } from 'react'

import {
  useAccountQuery,
  useAccountTask,
  useAccountText,
} from '@/hooks/use-xboard'
import { accountWrite, copyInviteLink } from '@/services/xboard'

import type { AccountConfig } from './account-settings'
import { accountDate, accountMoney, centsFromInput, flag } from './format'
import {
  AccountConfirm,
  AccountLoading,
  AccountPanel,
  SectionHeading,
  TaskMessage,
} from './shared'

interface InviteData {
  stat: number[]
  codes: { code: string; created_at: number }[]
}
interface Commission {
  id?: number
  created_at: number
  get_amount: number
  trade_no: string
  order_amount: number
}

export function AccountInvite() {
  const text = useAccountText()
  const task = useAccountTask()
  const query = useAccountQuery<InviteData>('invites')
  const configQuery = useAccountQuery<AccountConfig>('user_config')
  const [page, setPage] = useState(0)
  const records = useAccountQuery<Commission[]>(
    'invite_details',
    { current: page, page_size: 10 },
    page > 0,
  )
  const [dialog, setDialog] = useState<'transfer' | 'withdraw' | null>(null)
  const [amount, setAmount] = useState('')
  const [confirmCents, setConfirmCents] = useState<number | null>(null)
  const [method, setMethod] = useState('')
  const [recipient, setRecipient] = useState('')
  const data = query.data?.data
  const config = configQuery.data?.data
  const symbol = config?.currency_symbol ?? '¥'
  const available = data?.stat[4] ?? 0
  const methods = config?.withdraw_methods ?? []
  const [validation, setValidation] = useState('')

  const submit = () => {
    setValidation('')
    if (dialog === 'transfer') {
      const cents = centsFromInput(amount)
      if (cents == null || cents > available) {
        setValidation(
          text(
            '金额需大于零、不超过可用佣金，最多两位小数。',
            'Enter an amount greater than zero, within your available commission, with at most two decimal places.',
          ),
        )
        return
      }
      setConfirmCents(cents)
    } else {
      if (!recipient.trim() || !methods.includes(method)) return
      void task.run(
        async () => {
          await accountWrite('withdraw', {
            withdraw_method: method,
            withdraw_account: recipient.trim(),
          })
          setDialog(null)
          setRecipient('')
          await query.refetch()
        },
        text(
          '提现申请已提交，可在「我的工单」查看进展。',
          'Withdrawal requested. Track progress in My tickets.',
        ),
      )
    }
  }

  return (
    <>
      <SectionHeading
        title={
          page > 0
            ? text('佣金发放记录', 'Commission history')
            : text('我的邀请', 'My invitations')
        }
        action={
          page > 0 ? (
            <Button onClick={() => setPage(0)}>
              {text('返回邀请', 'Back to invitations')}
            </Button>
          ) : (
            <Button
              disabled={task.busy}
              onClick={() => {
                void query.refetch()
                void configQuery.refetch()
              }}
            >
              {text('刷新', 'Refresh')}
            </Button>
          )
        }
      />
      <TaskMessage message={task.message} />
      {page > 0 ? (
        <AccountLoading
          loading={records.isLoading}
          error={records.error}
          retry={records.refetch}
        >
          <Stack spacing={1.5}>
            {!records.data?.data.length && (
              <AccountPanel>
                <Typography color="text.secondary">
                  {text('暂无佣金记录', 'No commission records')}
                </Typography>
              </AccountPanel>
            )}
            {records.data?.data.map((row) => (
              <AccountPanel key={row.id ?? `${row.trade_no}-${row.created_at}`}>
                <Typography sx={{ fontWeight: 600 }}>
                  {accountMoney(row.get_amount, symbol)}
                </Typography>
                <Typography variant="body2">
                  {text('订单：', 'Order: ')}
                  {row.trade_no} · {accountMoney(row.order_amount, symbol)}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {accountDate(row.created_at)}
                </Typography>
              </AccountPanel>
            ))}
            <Stack
              direction="row"
              sx={{ justifyContent: 'space-between', alignItems: 'center' }}
            >
              <Button
                disabled={page <= 1 || records.isFetching}
                onClick={() => setPage(page - 1)}
              >
                {text('上一页', 'Previous')}
              </Button>
              <Typography variant="body2">
                {page} /{' '}
                {Math.max(1, Math.ceil((records.data?.total ?? 0) / 10))}
              </Typography>
              <Button
                disabled={
                  page * 10 >= (records.data?.total ?? 0) || records.isFetching
                }
                onClick={() => setPage(page + 1)}
              >
                {text('下一页', 'Next')}
              </Button>
            </Stack>
          </Stack>
        </AccountLoading>
      ) : (
        <AccountLoading
          loading={query.isLoading || configQuery.isLoading}
          error={query.error || configQuery.error}
          retry={() => Promise.all([query.refetch(), configQuery.refetch()])}
        >
          {data && (
            <Stack spacing={2}>
              <AccountPanel>
                <Typography color="text.secondary">
                  {text('可用佣金', 'Available commission')}
                </Typography>
                <Typography variant="h4" sx={{ fontWeight: 700, my: 1 }}>
                  {accountMoney(available, symbol)}
                </Typography>
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                    gap: 2,
                    my: 2,
                  }}
                >
                  <Box>
                    <Typography variant="body2" color="text.secondary">
                      {text('已邀请注册', 'Invited users')}
                    </Typography>
                    <Typography>{data.stat[0] ?? 0}</Typography>
                  </Box>
                  <Box>
                    <Typography variant="body2" color="text.secondary">
                      {text('佣金比例', 'Commission rate')}
                    </Typography>
                    <Typography>{data.stat[3] ?? 0}%</Typography>
                  </Box>
                  <Box>
                    <Typography variant="body2" color="text.secondary">
                      {text('累计佣金', 'Total commission')}
                    </Typography>
                    <Typography>
                      {accountMoney(data.stat[1], symbol)}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="body2" color="text.secondary">
                      {text('确认中佣金', 'Pending commission')}
                    </Typography>
                    <Typography>
                      {accountMoney(data.stat[2], symbol)}
                    </Typography>
                  </Box>
                </Box>
                {flag(config?.commission_distribution_enable) && (
                  <Typography variant="body2" color="text.secondary">
                    {text('佣金分配：', 'Distribution: ')}
                    {config?.commission_distribution_l1 ?? 0}% /{' '}
                    {config?.commission_distribution_l2 ?? 0}% /{' '}
                    {config?.commission_distribution_l3 ?? 0}%
                  </Typography>
                )}
                <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1, mt: 2 }}>
                  <Button
                    variant="contained"
                    disabled={task.busy || available <= 0}
                    onClick={() => {
                      setAmount('')
                      setValidation('')
                      setDialog('transfer')
                    }}
                  >
                    {text('划转至账户余额', 'Transfer to balance')}
                  </Button>
                  {!flag(config?.withdraw_close) && methods.length > 0 && (
                    <Button
                      variant="outlined"
                      disabled={task.busy || available <= 0}
                      onClick={() => {
                        setMethod(methods[0])
                        setValidation('')
                        setDialog('withdraw')
                      }}
                    >
                      {text('申请佣金提现', 'Request withdrawal')}
                    </Button>
                  )}
                  <Button onClick={() => setPage(1)}>
                    {text('佣金发放记录', 'Commission history')}
                  </Button>
                </Stack>
              </AccountPanel>
              <AccountPanel>
                <SectionHeading
                  title={text('邀请码管理', 'Invitation codes')}
                  action={
                    <Button
                      disabled={task.busy}
                      onClick={() => {
                        void task.run(
                          async () => {
                            await accountWrite('invite_save')
                            await query.refetch()
                          },
                          text('邀请码已生成', 'Invitation code created'),
                        )
                      }}
                    >
                      {text('生成邀请码', 'Generate code')}
                    </Button>
                  }
                />
                <Stack spacing={2}>
                  {!data.codes.length && (
                    <Typography color="text.secondary">
                      {text('暂无邀请码', 'No invitation codes')}
                    </Typography>
                  )}
                  {data.codes.map((item) => (
                    <Stack
                      key={item.code}
                      direction="row"
                      sx={{
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 2,
                      }}
                    >
                      <Box>
                        <Typography sx={{ userSelect: 'text' }}>
                          {item.code}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {accountDate(item.created_at)}
                        </Typography>
                      </Box>
                      <Button
                        startIcon={<ContentCopyOutlined />}
                        disabled={task.busy}
                        onClick={() => {
                          void task.run(
                            () => copyInviteLink(item.code),
                            text('邀请链接已复制', 'Invitation link copied'),
                          )
                        }}
                      >
                        {text('复制链接', 'Copy link')}
                      </Button>
                    </Stack>
                  ))}
                </Stack>
              </AccountPanel>
            </Stack>
          )}
        </AccountLoading>
      )}
      {dialog && (
        <Dialog
          open
          maxWidth="xs"
          fullWidth
          onClose={task.busy ? undefined : () => setDialog(null)}
        >
          <Box
            component="form"
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <DialogTitle>
              {dialog === 'transfer'
                ? text('划转至账户余额', 'Transfer to balance')
                : text('申请佣金提现', 'Request withdrawal')}
            </DialogTitle>
            <DialogContent>
              <Stack spacing={2} sx={{ pt: 1 }}>
                <TaskMessage message={task.message} />
                {validation && <Alert severity="warning">{validation}</Alert>}
                {dialog === 'transfer' ? (
                  <>
                    <Typography variant="body2">
                      {text('可用佣金：', 'Available: ')}
                      {accountMoney(available, symbol)}
                    </Typography>
                    <TextField
                      label={text('划转金额', 'Amount')}
                      value={amount}
                      required
                      disabled={task.busy}
                      slotProps={{ htmlInput: { inputMode: 'decimal' } }}
                      onChange={(event) => setAmount(event.target.value)}
                    />
                  </>
                ) : (
                  <>
                    <TextField
                      select
                      label={text('提现方式', 'Withdrawal method')}
                      value={method}
                      required
                      disabled={task.busy}
                      onChange={(event) => setMethod(event.target.value)}
                    >
                      {methods.map((value) => (
                        <MenuItem key={value} value={value}>
                          {value}
                        </MenuItem>
                      ))}
                    </TextField>
                    <TextField
                      label={text('收款账号', 'Recipient account')}
                      value={recipient}
                      required
                      disabled={task.busy}
                      onChange={(event) => setRecipient(event.target.value)}
                    />
                  </>
                )}
              </Stack>
            </DialogContent>
            <DialogActions>
              <Button disabled={task.busy} onClick={() => setDialog(null)}>
                {text('取消', 'Cancel')}
              </Button>
              <Button type="submit" disabled={task.busy}>
                {text('继续', 'Continue')}
              </Button>
            </DialogActions>
          </Box>
        </Dialog>
      )}
      {confirmCents != null && (
        <AccountConfirm
          title={text('确认划转', 'Confirm transfer')}
          busy={task.busy}
          onClose={() => setConfirmCents(null)}
          onConfirm={() => {
            void task.run(
              async () => {
                await accountWrite('transfer', {
                  transfer_amount: confirmCents,
                })
                setConfirmCents(null)
                setDialog(null)
                await query.refetch()
              },
              text(
                '佣金已转入消费余额',
                'Commission transferred to your balance',
              ),
            )
          }}
        >
          {text(
            `确认将 ${accountMoney(confirmCents, symbol)} 佣金转入消费余额？`,
            `Transfer ${accountMoney(confirmCents, symbol)} of commission to your purchase balance?`,
          )}
        </AccountConfirm>
      )}
    </>
  )
}
