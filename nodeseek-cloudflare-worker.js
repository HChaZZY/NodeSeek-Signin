// NodeSeek 签到 Cloudflare Worker
// 使用 2captcha 解决 Turnstile 验证码
// new Env('NodeSeek签到(CloudflareWorker)')
//
// 环境变量配置：
// user: 用户名，多个账户用&分割，如：user1&user2
// pass: 密码，多个密码用&分割，如：pass1&pass2（与user一一对应）
// CAPTCHA_API_KEY: 2captcha API密钥 (必填)
// CAPTCHA_API_URL: 2captcha API地址 (可选，默认 https://api.2captcha.com)
// NS_COOKIE: 已有的Cookie，多个用&分割（可选，如果提供则跳过登录）
// BotToken: Telegram Bot Token（可选）
// ChatID: Telegram Chat ID（可选，用于接收通知）

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  }
};

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname === '/checkin' && request.method === 'POST') {
    // 手动触发签到
    const result = await performCheckin(env);
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response('NodeSeek 签到服务运行中', { status: 200 });
}

async function handleScheduled(env) {
  await performCheckin(env);
}

// ==================== 2captcha 验证码解决器 ====================

class TwoCaptchaSolver {
  constructor(apiKey, apiBaseUrl = 'https://api.2captcha.com') {
    this.apiKey = apiKey;
    this.createTaskUrl = `${apiBaseUrl}/createTask`;
    this.getResultUrl = `${apiBaseUrl}/getTaskResult`;
    this.maxRetries = 40; // 最大重试次数（2分钟）
    this.retryInterval = 3000; // 重试间隔（3秒）
  }

  /**
   * 解决 Turnstile 验证码
   * @param {string} url - 网站URL
   * @param {string} sitekey - 网站密钥
   * @returns {Promise<string>} 验证令牌
   */
  async solve(url, sitekey) {
    try {
      console.log('开始创建验证码任务...');
      const taskId = await this._createTask(url, sitekey);

      if (!taskId) {
        throw new Error('创建任务失败：未返回任务ID');
      }

      console.log(`任务已创建，ID: ${taskId}`);
      console.log('等待验证码解决...');

      const token = await this._getTaskResult(taskId);
      console.log('✅ 验证码解决成功');

      return token;
    } catch (error) {
      console.error(`❌ 验证码解决失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 创建验证码任务
   */
  async _createTask(url, sitekey) {
    const data = {
      clientKey: this.apiKey,
      task: {
        type: 'TurnstileTaskProxyless',
        websiteURL: url,
        websiteKey: sitekey
      },
      softId: 0 // 可以设置为你的软件ID
    };

    try {
      const response = await fetch(this.createTaskUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();

      if (result.errorId === 0) {
        return result.taskId;
      } else {
        throw new Error(`API错误 (${result.errorId}): ${result.errorDescription || result.errorCode || '未知错误'}`);
      }
    } catch (error) {
      if (error.message.includes('API错误')) {
        throw error;
      }
      throw new Error(`创建任务请求失败: ${error.message}`);
    }
  }

  /**
   * 获取任务结果（轮询）
   */
  async _getTaskResult(taskId) {
    const data = {
      clientKey: this.apiKey,
      taskId: taskId
    };

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await fetch(this.getResultUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(data)
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const result = await response.json();

        if (result.errorId !== 0) {
          throw new Error(`API错误 (${result.errorId}): ${result.errorDescription || result.errorCode || '未知错误'}`);
        }

        const status = result.status;

        if (status === 'ready') {
          const token = result.solution?.token;
          if (!token) {
            throw new Error('解决成功但未返回令牌');
          }
          return token;
        } else if (status === 'processing') {
          console.log(`[${attempt}/${this.maxRetries}] 验证码处理中...`);
          await this._sleep(this.retryInterval);
        } else {
          throw new Error(`未知状态: ${status}`);
        }
      } catch (error) {
        if (error.message.includes('API错误') || error.message.includes('未知状态')) {
          throw error;
        }

        if (attempt === this.maxRetries) {
          throw new Error(`获取结果失败: ${error.message}`);
        }

        console.log(`获取结果请求失败，重试中... (${attempt}/${this.maxRetries})`);
        await this._sleep(this.retryInterval);
      }
    }

    throw new Error(`验证码解决超时（已重试${this.maxRetries}次）`);
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ==================== NodeSeek 签到逻辑 ====================

/**
 * 执行签到主流程
 */
async function performCheckin(env) {
  const users = env.user || '';
  const passwords = env.pass || '';
  const captchaApiKey = env.CAPTCHA_API_KEY || '';
  const captchaApiUrl = env.CAPTCHA_API_URL || 'https://api.2captcha.com';
  const nsCookies = env.NS_COOKIE || '';
  const botToken = env.BotToken || '';
  const chatId = env.ChatID || '';

  // 验证必要参数
  if (!users || !passwords) {
    const errorMsg = '❌ 未配置 user 或 pass 环境变量';
    console.error(errorMsg);
    await sendTelegramMessage(errorMsg, botToken, chatId);
    return { success: false, message: errorMsg };
  }

  if (!captchaApiKey) {
    const errorMsg = '❌ 未配置 CAPTCHA_API_KEY 环境变量';
    console.error(errorMsg);
    await sendTelegramMessage(errorMsg, botToken, chatId);
    return { success: false, message: errorMsg };
  }

  const userList = users.split('&').filter(u => u.trim());
  const passList = passwords.split('&').filter(p => p.trim());
  const cookieList = nsCookies.split('&').filter(c => c.trim());

  if (userList.length !== passList.length) {
    const errorMsg = '❌ user 和 pass 的数量不匹配';
    console.error(errorMsg);
    await sendTelegramMessage(errorMsg, botToken, chatId);
    return { success: false, message: errorMsg };
  }

  const results = [];
  const allMessages = [];

  for (let i = 0; i < userList.length; i++) {
    const user = userList[i].trim();
    const password = passList[i].trim();
    const existingCookie = cookieList[i] || '';

    console.log(`\n=== 处理账户 ${i + 1}: ${user} ===`);

    try {
      // 尝试使用现有 Cookie 签到
      let cookie = existingCookie;
      let loginAttempted = false;

      if (cookie) {
        console.log('使用现有 Cookie 尝试签到...');
        const signResult = await sign(cookie);

        if (signResult.success) {
          const msg = `账户${i + 1}(${user}): ✅ ${signResult.message}`;
          results.push({ success: true, message: msg });
          allMessages.push(msg);
          continue;
        } else if (signResult.needLogin) {
          console.log('Cookie 已失效，需要重新登录');
          loginAttempted = true;
        }
      }

      // 需要登录
      if (!cookie || loginAttempted) {
        console.log('开始登录流程...');
        const loginResult = await sessionLogin(user, password, captchaApiKey, captchaApiUrl);

        if (!loginResult.success) {
          throw new Error(loginResult.message);
        }

        cookie = loginResult.cookie;
        console.log('✅ 登录成功，开始签到...');

        // 使用新 Cookie 签到
        const signResult = await sign(cookie);

        if (signResult.success) {
          const msg = `账户${i + 1}(${user}): ✅ ${signResult.message} (已重新登录)`;
          results.push({ success: true, message: msg });
          allMessages.push(msg);
        } else {
          throw new Error(signResult.message);
        }
      }
    } catch (error) {
      const errorMsg = `账户${i + 1}(${user}): ❌ ${error.message}`;
      results.push({ success: false, message: errorMsg });
      allMessages.push(errorMsg);
      console.error(errorMsg);
    }
  }

  // 发送汇总消息到 Telegram
  const successCount = results.filter(r => r.success).length;
  const totalCount = results.length;
  const summaryMsg = `🔔 NodeSeek 签到结果 (${successCount}/${totalCount})\n\n${allMessages.join('\n')}`;

  await sendTelegramMessage(summaryMsg, botToken, chatId);

  return {
    success: results.some(r => r.success),
    results: results,
    message: summaryMsg
  };
}

/**
 * 登录并获取 Cookie
 */
async function sessionLogin(user, password, captchaApiKey, captchaApiUrl) {
  try {
    // 1. 解决验证码
    console.log('正在使用 2captcha 解决验证码...');
    const solver = new TwoCaptchaSolver(captchaApiKey, captchaApiUrl);

    const token = await solver.solve(
      'https://www.nodeseek.com/signIn.html',
      '0x4AAAAAAAaNy7leGjewpVyR'
    );

    console.log('验证码令牌已获取');

    // 2. 提交登录请求
    const loginData = {
      username: user,
      password: password,
      token: token,
      source: 'turnstile'
    };

    const response = await fetch('https://www.nodeseek.com/api/account/signIn', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Origin': 'https://www.nodeseek.com',
        'Referer': 'https://www.nodeseek.com/signIn.html'
      },
      body: JSON.stringify(loginData)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    if (data.success) {
      // 提取 Cookie
      const setCookieHeaders = response.headers.get('set-cookie') || '';
      let cookie = '';

      if (setCookieHeaders) {
        // 解析 Set-Cookie 头
        const cookies = setCookieHeaders.split(',').map(c => {
          const parts = c.trim().split(';');
          return parts[0]; // 只取第一部分 (name=value)
        }).join('; ');
        cookie = cookies;
      }

      console.log(`✅ 登录成功: ${data.message || '登录成功'}`);

      return {
        success: true,
        cookie: cookie,
        message: data.message || '登录成功'
      };
    } else {
      throw new Error(data.message || '登录失败');
    }
  } catch (error) {
    console.error(`❌ 登录失败: ${error.message}`);
    return {
      success: false,
      message: `登录失败: ${error.message}`
    };
  }
}

/**
 * 执行签到
 */
async function sign(cookie) {
  if (!cookie) {
    return {
      success: false,
      needLogin: true,
      message: '无有效Cookie'
    };
  }

  try {
    // 生成随机数
    const random = Math.random().toString(36).substring(2, 15);

    const response = await fetch(`https://www.nodeseek.com/api/attendance?random=${random}`, {
      method: 'POST',
      headers: {
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Origin': 'https://www.nodeseek.com',
        'Referer': 'https://www.nodeseek.com/'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    const msg = data.message || '';

    // 判断签到结果
    if (msg.includes('鸡腿') || data.success) {
      return {
        success: true,
        needLogin: false,
        message: msg
      };
    } else if (msg.includes('已完成签到')) {
      return {
        success: true,
        needLogin: false,
        message: msg
      };
    } else if (data.status === 404 || msg.includes('请先登录')) {
      return {
        success: false,
        needLogin: true,
        message: 'Cookie已失效'
      };
    } else {
      throw new Error(msg || '签到失败');
    }
  } catch (error) {
    console.error(`❌ 签到失败: ${error.message}`);
    return {
      success: false,
      needLogin: false,
      message: error.message
    };
  }
}

// ==================== Telegram 通知 ====================

/**
 * 发送 Telegram 消息
 */
async function sendTelegramMessage(message, botToken, chatId) {
  if (!chatId) {
    console.log('未配置 ChatID，跳过 Telegram 通知');
    return;
  }

  const now = new Date();
  const formattedTime = now.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  const fullMessage = `执行时间: ${formattedTime}\n\n${message}`;

  try {
    let url;
    if (botToken && botToken.trim() !== '') {
      // 使用官方 Telegram API
      url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    } else {
      // 使用第三方代理服务（不推荐）
      console.log('⚠️ 未配置 BotToken，使用第三方代理服务');
      url = `https://api.tg.090227.xyz/sendMessage`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: fullMessage,
        parse_mode: 'HTML'
      })
    });

    if (response.ok) {
      console.log('✅ Telegram 消息发送成功');
    } else {
      const errorText = await response.text();
      console.error('❌ Telegram 消息发送失败:', response.status, errorText);
    }
  } catch (error) {
    console.error('❌ 发送 Telegram 消息时出错:', error.message);
  }
}
