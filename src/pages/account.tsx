import {
  ArrowBackRounded,
  ArticleOutlined,
  AssignmentOutlined,
  ConfirmationNumberOutlined,
  DnsOutlined,
  GroupAddOutlined,
  ManageAccountsOutlined,
  QueryStatsOutlined,
} from '@mui/icons-material'
import {
  Box,
  Button,
  CardActionArea,
  Paper,
  Stack,
  Typography,
} from '@mui/material'
import { useState } from 'react'

import { BasePage } from '@/components/base'
import { AccountAuth } from '@/components/xboard/account-auth'
import { AccountInvite } from '@/components/xboard/account-invite'
import { AccountOverview } from '@/components/xboard/account-overview'
import { AccountSettings } from '@/components/xboard/account-settings'
import {
  AccountNodes,
  AccountOrders,
  AccountTraffic,
} from '@/components/xboard/account-status'
import {
  AccountKnowledge,
  AccountTickets,
} from '@/components/xboard/account-support'
import { AccountLoading } from '@/components/xboard/shared'
import { useAccountText, useXboard } from '@/hooks/use-xboard'

type Section =
  | 'nodes'
  | 'traffic'
  | 'knowledge'
  | 'tickets'
  | 'orders'
  | 'invite'
  | 'settings'

export default function AccountPage() {
  const account = useXboard()
  return (
    <AccountContent
      key={account.data?.signed_in ? `member:${account.data.email}` : 'guest'}
    />
  )
}

function AccountContent() {
  const text = useAccountText()
  const account = useXboard()
  const [section, setSection] = useState<Section | null>(null)
  const entries = [
    {
      id: 'nodes' as const,
      title: text('节点状态', 'Node status'),
      hint: text('在线状态与倍率', 'Availability and rates'),
      icon: <DnsOutlined />,
      component: <AccountNodes />,
    },
    {
      id: 'traffic' as const,
      title: text('流量明细', 'Traffic details'),
      hint: text('每日用量与计费', 'Daily usage and billing'),
      icon: <QueryStatsOutlined />,
      component: <AccountTraffic />,
    },
    {
      id: 'knowledge' as const,
      title: text('使用文档', 'Documentation'),
      hint: text('搜索和阅读教程', 'Find guides and tutorials'),
      icon: <ArticleOutlined />,
      component: <AccountKnowledge />,
    },
    {
      id: 'tickets' as const,
      title: text('我的工单', 'My tickets'),
      hint: text('提交问题与查看回复', 'Contact support and read replies'),
      icon: <ConfirmationNumberOutlined />,
      component: <AccountTickets />,
    },
    {
      id: 'orders' as const,
      title: text('我的订单', 'My orders'),
      hint: text('记录与详情', 'Order history and details'),
      icon: <AssignmentOutlined />,
      component: <AccountOrders />,
    },
    {
      id: 'invite' as const,
      title: text('我的邀请', 'My invitations'),
      hint: text('邀请码与佣金记录', 'Invitation codes and commissions'),
      icon: <GroupAddOutlined />,
      component: <AccountInvite />,
    },
    {
      id: 'settings' as const,
      title: text('账号设置', 'Account settings'),
      hint: text('钱包、密码与通知', 'Balance, password and notifications'),
      icon: <ManageAccountsOutlined />,
      component: <AccountSettings />,
    },
  ]
  return (
    <BasePage
      title={text('账户', 'Account')}
      contentStyle={{ padding: '8px 2px 24px' }}
      header={
        section && account.data?.signed_in ? (
          <Button
            startIcon={<ArrowBackRounded />}
            onClick={() => setSection(null)}
          >
            {text('返回账户', 'Back to account')}
          </Button>
        ) : undefined
      }
    >
      <Box sx={{ maxWidth: 1120, mx: 'auto' }}>
        <AccountLoading
          loading={account.isLoading}
          error={account.error}
          retry={account.refetch}
        >
          {!account.data?.signed_in ? (
            <AccountAuth />
          ) : (
            <Box key={account.data.email}>
              {section ? (
                entries.find((entry) => entry.id === section)?.component
              ) : (
                <Stack spacing={3}>
                  <AccountOverview />
                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: {
                        xs: '1fr',
                        sm: 'repeat(2, 1fr)',
                        lg: 'repeat(3, 1fr)',
                      },
                      gap: 2,
                    }}
                  >
                    {entries.map((entry) => (
                      <Paper
                        key={entry.id}
                        variant="outlined"
                        sx={{ borderRadius: 3, overflow: 'hidden' }}
                      >
                        <CardActionArea
                          onClick={() => setSection(entry.id)}
                          sx={{ p: 2.5, height: '100%' }}
                        >
                          <Stack spacing={1}>
                            <Box sx={{ color: 'primary.main' }}>
                              {entry.icon}
                            </Box>
                            <Typography variant="subtitle1" fontWeight={600}>
                              {entry.title}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              {entry.hint}
                            </Typography>
                          </Stack>
                        </CardActionArea>
                      </Paper>
                    ))}
                  </Box>
                </Stack>
              )}
            </Box>
          )}
        </AccountLoading>
      </Box>
    </BasePage>
  )
}
