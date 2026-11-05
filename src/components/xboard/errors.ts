const chineseErrors: Record<string, string> = {
  'The account service could not be reached. Please try again.':
    '暂时无法连接账号服务，请检查网络后重试。',
  'The encrypted account data could not be read or saved on this Windows account.':
    '无法读取或保存本机账号信息，请重新登录。',
  'The account service returned an invalid response.':
    '账号服务返回的数据格式无效，请稍后重试。',
  'Your session expired. Please sign in again.': '登录已失效，请重新登录。',
  'No subscription nodes are currently available.':
    '暂无可用订阅节点，请稍后刷新。',
  'Too many requests. Please try again later.': '请求过于频繁，请稍后重试。',
  'The account service is temporarily unavailable.':
    '账号服务暂时不可用，请稍后重试。',
  'This email is already registered. Please sign in.':
    '这个邮箱已经注册，请返回登录。',
  'Incorrect email or password.': '邮箱或密码不正确。',
  'This account is suspended.': '账号已停用，请联系服务支持。',
  'The email verification code is incorrect or expired.':
    '邮箱验证码错误或已过期。',
  'Registration is closed.': '站点已关闭注册。',
  'A valid invitation code is required.': '请填写有效的邀请码。',
  'A verification code was already sent. Please wait before requesting another.':
    '验证码已发送，请稍后再请求。',
  'The current password is incorrect.': '旧密码不正确。',
  'The commission balance is insufficient.': '可用佣金不足。',
  'The account service declined this request. Check the information and try again.':
    '请求未完成，请检查填写的信息后重试。',
  'Enter a valid email and a password of at least eight characters.':
    '请填写有效邮箱，密码至少需要 8 个字符。',
  'Your account was created, but the session could not be saved. Please sign in instead of registering again.':
    '账号已创建，但无法保存登录信息。请返回登录，不要重复注册。',
  'Registration could not be confirmed. The account may already exist. Try signing in before registering again.':
    '未能确认注册结果，账号可能已经创建。请先尝试登录，再决定是否重新注册。',
}

export function accountError(error: unknown, chinese: boolean) {
  const message =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : error &&
            typeof error === 'object' &&
            'detail' in error &&
            typeof error.detail === 'string'
          ? error.detail
          : ''
  return chinese ? (chineseErrors[message] ?? message) : message
}
