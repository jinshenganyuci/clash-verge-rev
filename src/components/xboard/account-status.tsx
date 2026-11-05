import { RefreshRounded } from '@mui/icons-material'
import {
  Box,
  Button,
  Chip,
  Divider,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material'
import { useState } from 'react'

import { useAccountQuery, useAccountText } from '@/hooks/use-xboard'

import {
  accountBytes,
  accountDate,
  accountMoney,
  flag,
  trafficValues,
} from './format'
import { AccountLoading, AccountPanel, SectionHeading } from './shared'

interface AccountNode {
  id?: number | string
  name: string
  type?: string
  is_online?: number | boolean
  rate?: number
  tags?: string[]
  external?: boolean
  last_check_at?: number
}
interface TrafficRow {
  record_at: number
  u: number
  d: number
  server_rate?: number | null
}
interface AccountOrder {
  trade_no: string
  status: number
  period: string
  total_amount: number
  created_at: number
  plan?: { name?: string }
}

export function AccountNodes() {
  const text = useAccountText()
  const query = useAccountQuery<AccountNode[]>('nodes')
  const rows = query.data?.data ?? []
  return (
    <>
      <SectionHeading
        title={text('节点状态', 'Node status')}
        description={text(
          '面板在线状态与计费倍率',
          'Panel availability and traffic rates',
        )}
        action={
          <Button
            startIcon={<RefreshRounded />}
            disabled={query.isFetching}
            onClick={() => {
              void query.refetch()
            }}
          >
            {text('刷新', 'Refresh')}
          </Button>
        }
      />
      <AccountLoading
        loading={query.isLoading}
        error={query.error}
        empty={!rows.length}
        retry={query.refetch}
      >
        <Stack spacing={1.5}>
          {rows.map((row) => (
            <AccountPanel key={row.id ?? `${row.name}-${row.type}-${row.rate}`}>
              <Stack
                direction="row"
               sx={{ justifyContent: "space-between", alignItems: "center", gap: 2 }}>
                <Typography sx={{ fontWeight: 600 }}>{row.name}</Typography>
                <Chip
                  size="small"
                  color={flag(row.is_online) ? 'success' : 'default'}
                  label={
                    row.is_online == null
                      ? text('未知', 'Unknown')
                      : flag(row.is_online)
                        ? text('在线', 'Online')
                        : text('离线', 'Offline')
                  }
                />
              </Stack>
              <Stack direction="row" sx={{ flexWrap: "wrap", gap: 1,  my: 1 }}>
                {row.type && (
                  <Chip
                    size="small"
                    label={row.type.toUpperCase()}
                    variant="outlined"
                  />
                )}
                {row.external && (
                  <Chip
                    size="small"
                    label={text('第三方节点', 'External node')}
                    variant="outlined"
                  />
                )}
                {row.rate != null && (
                  <Chip
                    size="small"
                    label={`${text('倍率', 'Rate')} ${row.rate}×`}
                    variant="outlined"
                  />
                )}
                {row.tags?.map((tag) => (
                  <Chip key={tag} size="small" label={tag} variant="outlined" />
                ))}
              </Stack>
              {!!row.last_check_at && (
                <Typography variant="caption" color="text.secondary">
                  {text('检查时间：', 'Last checked: ')}
                  {accountDate(row.last_check_at)}
                </Typography>
              )}
            </AccountPanel>
          ))}
        </Stack>
      </AccountLoading>
    </>
  )
}

export function AccountTraffic() {
  const text = useAccountText()
  const query = useAccountQuery<TrafficRow[]>('traffic')
  const rows = query.data?.data ?? []
  const total = rows.reduce((sum, row) => sum + trafficValues(row).billed, 0)
  const actual = rows.every((row) => trafficValues(row).upload != null)
    ? rows.reduce(
        (sum, row) => {
          const value = trafficValues(row)
          return {
            upload: sum.upload + (value.upload ?? 0),
            download: sum.download + (value.download ?? 0),
          }
        },
        { upload: 0, download: 0 },
      )
    : null
  return (
    <>
      <SectionHeading
        title={text('流量明细', 'Traffic details')}
        description={text(
          '本月每日用量与计费',
          'This month’s traffic and billing',
        )}
        action={
          <Button
            startIcon={<RefreshRounded />}
            disabled={query.isFetching}
            onClick={() => {
              void query.refetch()
            }}
          >
            {text('刷新', 'Refresh')}
          </Button>
        }
      />
      <AccountLoading
        loading={query.isLoading}
        error={query.error}
        empty={!rows.length}
        retry={query.refetch}
      >
        <AccountPanel>
          <Typography variant="h6" sx={{ mb: 1 }}>
            {text('本月扣除流量：', 'Billed this month: ')}
            {accountBytes(total)}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {actual
              ? `${text('实际上行', 'Actual upload')} ${accountBytes(actual.upload)} · ${text('实际下行', 'Actual download')} ${accountBytes(actual.download)}`
              : text(
                  '倍率为零或未知时，无法还原实际用量。',
                  'Actual usage cannot be reconstructed when the rate is zero or unknown.',
                )}
          </Typography>
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  {[
                    text('日期', 'Date'),
                    text('倍率', 'Rate'),
                    text('扣除流量', 'Billed'),
                    text('实际上行', 'Upload'),
                    text('实际下行', 'Download'),
                  ].map((label) => (
                    <TableCell key={label}>{label}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row) => {
                  const values = trafficValues(row)
                  return (
                    <TableRow key={`${row.record_at}-${row.server_rate}`}>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        {new Date(row.record_at * 1000).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        {values.rate == null ? '—' : `${values.rate}×`}
                      </TableCell>
                      <TableCell>{accountBytes(values.billed)}</TableCell>
                      <TableCell>
                        {values.upload == null
                          ? '—'
                          : accountBytes(values.upload)}
                      </TableCell>
                      <TableCell>
                        {values.download == null
                          ? '—'
                          : accountBytes(values.download)}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </Box>
        </AccountPanel>
      </AccountLoading>
    </>
  )
}

export function AccountOrders() {
  const text = useAccountText()
  const [selected, setSelected] = useState<string | null>(null)
  const query = useAccountQuery<AccountOrder[]>('orders')
  const detail = useAccountQuery<AccountOrder>(
    'order_detail',
    { trade_no: selected ?? '' },
    selected != null,
  )
  const rows = query.data?.data ?? []
  const status = (value: number) =>
    [
      text('待支付', 'Pending payment'),
      text('开通中', 'Processing'),
      text('已取消', 'Cancelled'),
      text('已完成', 'Completed'),
      text('已折抵', 'Credited'),
    ][value] ?? text('未知', 'Unknown')
  const period = (value: string) =>
    (
      ({
        month_price: text('月付', 'Monthly'),
        monthly: text('月付', 'Monthly'),
        quarter_price: text('季付', 'Quarterly'),
        quarterly: text('季付', 'Quarterly'),
        half_year_price: text('半年付', 'Half-yearly'),
        half_yearly: text('半年付', 'Half-yearly'),
        year_price: text('年付', 'Yearly'),
        yearly: text('年付', 'Yearly'),
        two_year_price: text('两年付', 'Two years'),
        two_yearly: text('两年付', 'Two years'),
        three_year_price: text('三年付', 'Three years'),
        three_yearly: text('三年付', 'Three years'),
        onetime_price: text('一次性', 'One-time'),
        onetime: text('一次性', 'One-time'),
        reset_price: text('流量重置', 'Traffic reset'),
        reset_traffic: text('流量重置', 'Traffic reset'),
      }) as Record<string, string>
    )[value] ?? value
  const order = detail.data?.data
  return (
    <>
      <SectionHeading
        title={
          selected
            ? text('订单详情', 'Order details')
            : text('我的订单', 'My orders')
        }
        action={
          <Button
            onClick={() => {
              if (selected) setSelected(null)
              else void query.refetch()
            }}
          >
            {selected
              ? text('返回列表', 'Back to list')
              : text('刷新', 'Refresh')}
          </Button>
        }
      />
      {selected ? (
        <AccountLoading
          loading={detail.isLoading}
          error={detail.error}
          retry={detail.refetch}
        >
          {order && (
            <AccountPanel>
              <Stack spacing={2}>
                <Typography variant="h6">{order.plan?.name}</Typography>
                <Typography sx={{ userSelect: 'text' }}>
                  {text('订单号：', 'Order: ')}
                  {order.trade_no}
                </Typography>
                <Divider />
                <Typography>
                  {text('状态：', 'Status: ')}
                  {status(order.status)}
                </Typography>
                <Typography>
                  {text('周期：', 'Period: ')}
                  {period(order.period)}
                </Typography>
                <Typography>
                  {text('金额：', 'Amount: ')}
                  {accountMoney(order.total_amount, '')}
                </Typography>
                <Typography>
                  {text('创建时间：', 'Created: ')}
                  {accountDate(order.created_at)}
                </Typography>
              </Stack>
            </AccountPanel>
          )}
        </AccountLoading>
      ) : (
        <AccountLoading
          loading={query.isLoading}
          error={query.error}
          empty={!rows.length}
          retry={query.refetch}
        >
          <Stack spacing={1.5}>
            {rows.map((row) => (
              <AccountPanel key={row.trade_no}>
                <Stack
                  direction="row"
                 sx={{ justifyContent: "space-between", alignItems: "center", gap: 2 }}>
                  <Box>
                    <Typography sx={{ fontWeight: 600 }}>
                      {row.plan?.name || row.trade_no}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {row.trade_no}
                    </Typography>
                    <Typography variant="body2">
                      {status(row.status)} ·{' '}
                      {accountMoney(row.total_amount, '')}
                    </Typography>
                  </Box>
                  <Button onClick={() => setSelected(row.trade_no)}>
                    {text('查看详情', 'Details')}
                  </Button>
                </Stack>
              </AccountPanel>
            ))}
          </Stack>
        </AccountLoading>
      )}
    </>
  )
}
