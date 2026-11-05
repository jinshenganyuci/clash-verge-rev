import { AddRounded, SearchRounded } from '@mui/icons-material'
import { Box, Button, Chip, Divider, MenuItem, Stack, TextField, Typography } from '@mui/material'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'

import { useAccountQuery, useAccountTask, useAccountText } from '@/hooks/use-xboard'
import { accountWrite } from '@/services/xboard'

import { accountDate, flag } from './format'
import { AccountConfirm, AccountLoading, AccountPanel, SectionHeading, TaskMessage } from './shared'

interface Article { id: number; title: string; category?: string; body?: string }
interface TicketMessage { id: number; is_me: boolean | number; created_at: number; message: string }
interface Ticket { id: number; subject: string; status: number; reply_status: number; level: number; created_at: number; updated_at: number; message?: TicketMessage[] }

export function AccountKnowledge() {
  const text = useAccountText()
  const { i18n } = useTranslation()
  const language = ({ zh: 'zh-CN', zhtw: 'zh-TW', jp: 'ja-JP', ko: 'ko-KR', fa: 'fa-IR' } as Record<string, string>)[i18n.language] ?? 'en-US'
  const [input, setInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [selected, setSelected] = useState<Article | null>(null)
  const query = useAccountQuery<Record<string, Article[]> | Article[][]>('knowledge', { language, keyword })
  const detail = useAccountQuery<Article>('knowledge', { language, id: selected?.id ?? 0 }, selected != null)
  const groups = Object.entries(query.data?.data ?? {})
  const hasArticles = groups.some(([, items]) => items.length > 0)
  return <><SectionHeading title={selected?.title ?? text('使用文档', 'Documentation')} action={<Button onClick={() => { if (selected) setSelected(null); else void query.refetch() }}>{selected ? text('返回文档', 'Back to articles') : text('刷新', 'Refresh')}</Button>} />
    {selected ? <AccountLoading loading={detail.isLoading} error={detail.error} retry={detail.refetch}><AccountPanel><Box sx={{ userSelect: 'text', '& pre': { whiteSpace: 'pre-wrap' }, '& code': { overflowWrap: 'anywhere' } }}><ReactMarkdown skipHtml components={{
      a: ({ children, href }) => <span>{children}{href && /^https?:\/\//.test(href) ? ` (${href})` : ''}</span>,
      img: ({ alt }) => <span>{alt ?? ''}</span>,
    }}>{detail.data?.data.body ?? ''}</ReactMarkdown></Box></AccountPanel></AccountLoading> : <>
      <Stack component="form" direction="row" spacing={1} sx={{ mb: 2 }} onSubmit={(event) => { event.preventDefault(); setKeyword(input.trim()) }}><TextField fullWidth size="small" label={text('搜索使用文档', 'Search documentation')} value={input} slotProps={{ htmlInput: { maxLength: 255 } }} onChange={(event) => setInput(event.target.value)} /><Button type="submit" startIcon={<SearchRounded />}>{text('搜索', 'Search')}</Button></Stack>
      <AccountLoading loading={query.isLoading} error={query.error} empty={!hasArticles} retry={query.refetch}><Stack spacing={2}>{groups.filter(([, articles]) => articles.length > 0).map(([category, articles]) => <AccountPanel key={category}><Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>{articles[0].category ?? category}</Typography><Stack alignItems="flex-start">{articles.map((article) => <Button key={article.id} sx={{ textAlign: 'left' }} onClick={() => setSelected(article)}>{article.title}</Button>)}</Stack></AccountPanel>)}</Stack></AccountLoading>
    </>}
  </>
}

export function AccountTickets() {
  const text = useAccountText()
  const task = useAccountTask()
  const [selected, setSelected] = useState<number | 'new' | null>(null)
  const [subject, setSubject] = useState('')
  const [level, setLevel] = useState(0)
  const [body, setBody] = useState('')
  const [reply, setReply] = useState('')
  const [closing, setClosing] = useState(false)
  const query = useAccountQuery<Ticket[]>('tickets')
  const detail = useAccountQuery<Ticket>('tickets', { id: typeof selected === 'number' ? selected : 0 }, typeof selected === 'number')
  const ticket = detail.data?.data
  const rows = query.data?.data ?? []
  const levels = [text('低', 'Low'), text('中', 'Medium'), text('高', 'High')]
  const status = (row: Ticket) => row.status === 1 ? text('已关闭', 'Closed') : row.reply_status === 1 ? text('已回复', 'Replied') : text('等待回复', 'Awaiting reply')
  const create = async () => {
    await task.run(async () => {
      await accountWrite('ticket_save', { subject: subject.trim(), level, message: body.trim() })
      setSubject(''); setBody(''); setSelected(null)
      await query.refetch()
    }, text('工单已提交', 'Ticket submitted'))
  }
  return <><SectionHeading title={selected === 'new' ? text('新建工单', 'New ticket') : ticket && selected != null ? ticket.subject : text('我的工单', 'My tickets')} action={selected != null ? <Button disabled={task.busy} onClick={() => { setSelected(null); setReply('') }}>{text('返回列表', 'Back to list')}</Button> : <Button startIcon={<AddRounded />} onClick={() => setSelected('new')}>{text('新建工单', 'New ticket')}</Button>} /><TaskMessage message={task.message} />
    {selected === 'new' ? <AccountPanel><Stack component="form" spacing={2} onSubmit={(event) => { event.preventDefault(); void create() }}><TextField label={text('工单主题', 'Subject')} value={subject} required disabled={task.busy} onChange={(event) => setSubject(event.target.value)} /><TextField select label={text('工单级别', 'Priority')} value={level} disabled={task.busy} onChange={(event) => setLevel(Number(event.target.value))}>{levels.map((label, index) => <MenuItem key={label} value={index}>{label}</MenuItem>)}</TextField><TextField label={text('描述遇到的问题', 'Describe your issue')} multiline minRows={5} value={body} required disabled={task.busy} onChange={(event) => setBody(event.target.value)} /><Button type="submit" variant="contained" disabled={task.busy || !subject.trim() || !body.trim()}>{text('提交工单', 'Submit ticket')}</Button></Stack></AccountPanel> : typeof selected === 'number' ? <AccountLoading loading={detail.isLoading} error={detail.error} retry={detail.refetch}>{ticket && <AccountPanel><Stack spacing={2}><Stack direction="row" gap={1} flexWrap="wrap"><Chip size="small" label={status(ticket)} /><Chip size="small" label={levels[ticket.level] ?? '—'} /><Typography variant="caption" color="text.secondary">{accountDate(ticket.created_at)}</Typography></Stack><Divider />{ticket.message?.map((message) => <Box key={message.id ?? `${message.created_at}-${message.message}`} sx={{ p: 2, bgcolor: flag(message.is_me) ? 'action.hover' : 'background.default', borderRadius: 2 }}><Typography variant="caption" color="text.secondary">{flag(message.is_me) ? text('我', 'Me') : text('客服', 'Support')} · {accountDate(message.created_at)}</Typography><Typography sx={{ whiteSpace: 'pre-wrap', userSelect: 'text', mt: 0.5 }}>{message.message}</Typography></Box>)}{ticket.status === 0 && <><TextField multiline minRows={3} label={text('输入回复内容', 'Your reply')} value={reply} disabled={task.busy} onChange={(event) => setReply(event.target.value)} /><Stack direction="row" spacing={1}><Button variant="contained" disabled={task.busy || !reply.trim()} onClick={() => { void task.run(async () => { await accountWrite('ticket_reply', { id: selected, message: reply.trim() }); setReply(''); await detail.refetch(); await query.refetch() }, text('回复已提交', 'Reply submitted')) }}>{text('提交回复', 'Send reply')}</Button><Button color="inherit" disabled={task.busy} onClick={() => setClosing(true)}>{text('关闭工单', 'Close ticket')}</Button></Stack></>}</Stack></AccountPanel>}</AccountLoading> : <AccountLoading loading={query.isLoading} error={query.error} empty={!rows.length} retry={query.refetch}><Stack spacing={1.5}>{rows.map((row) => <AccountPanel key={row.id}><Stack direction="row" justifyContent="space-between" alignItems="center" gap={2}><Box><Typography fontWeight={600}>{row.subject}</Typography><Typography variant="body2" color="text.secondary">{status(row)} · {levels[row.level]} · {accountDate(row.updated_at)}</Typography></Box><Button onClick={() => setSelected(row.id)}>{text('查看', 'View')}</Button></Stack></AccountPanel>)}</Stack></AccountLoading>}
    {closing && typeof selected === 'number' && <AccountConfirm title={text('关闭工单', 'Close ticket')} busy={task.busy} onClose={() => setClosing(false)} onConfirm={() => { void task.run(async () => { await accountWrite('ticket_close', { id: selected }); setClosing(false); await detail.refetch(); await query.refetch() }) }}>{text('关闭后将无法继续回复这张工单。', 'You will no longer be able to reply to this ticket.')}</AccountConfirm>}
  </>
}
