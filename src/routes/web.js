const express = require('express')
const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const path = require('path')
const fs = require('fs')
const redis = require('../models/redis')
const logger = require('../utils/logger')
const config = require('../../config/config')

// redis.setSession 的 ttl 单位是秒，而 adminSessionTimeout 配置单位是毫秒（响应里的 expiresIn 也按毫秒给前端）。
// 之前直接传毫秒值，导致会话 TTL 被放大 1000 倍（24h → ~1000 天），泄露的 token 长期有效。
const ADMIN_SESSION_TTL_SECONDS = Math.max(1, Math.ceil(config.security.adminSessionTimeout / 1000))
const {
  loginRateLimit,
  penalizeLogin,
  clearLoginLimit
} = require('../middleware/securityHardening')

const router = express.Router()

// 管理员凭据的唯一真实数据源
const INIT_FILE_PATH = path.join(__dirname, '../../data/init.json')

/**
 * 从 init.json 重建 Redis 中的管理员凭据缓存。
 *
 * `data/init.json` 是管理员凭据的 single source of truth，Redis 中的副本随时可以从它重建。
 * 因此「凭据缓存缺失」不是错误状态，而是一个可自愈的中间态 —— 登录、改密、获取用户信息
 * 三条路径都必须调用本函数自愈，而不是各自向调用方报错。
 *
 * 本函数是这三条路径共用的唯一实现：历史缺陷的成因正是「同一份数据、两套读取契约」
 * （登录侧有兜底所以一直正常，改密侧没有所以必然 500），复制实现会保留这个成因。
 *
 * @returns {Promise<object|null>} 重建后的凭据对象；init.json 不存在时返回 null
 */
async function reloadAdminCredentialsFromInit() {
  if (!fs.existsSync(INIT_FILE_PATH)) {
    return null
  }

  const initData = JSON.parse(fs.readFileSync(INIT_FILE_PATH, 'utf8'))
  const saltRounds = 10
  const passwordHash = await bcrypt.hash(initData.adminPassword, saltRounds)

  const adminData = {
    username: initData.adminUsername,
    passwordHash,
    createdAt: initData.initializedAt || new Date().toISOString(),
    lastLogin: null,
    updatedAt: initData.updatedAt || null
  }

  // 走专用入口写入，不带 TTL（凭据是配置不是会话）
  await redis.setAdminCredentials(adminData)
  logger.info('✅ Admin credentials reloaded from init.json')

  return adminData
}

// 🏠 服务静态文件
router.use('/assets', express.static(path.join(__dirname, '../../web/assets')))

// 🌐 页面路由重定向到新版 admin-spa
router.get('/', (req, res) => {
  res.redirect(301, '/admin-next')
})

// 🔐 管理员登录
router.post('/auth/login', loginRateLimit, async (req, res) => {
  try {
    const { username, password } = req.body

    // [SECHARDEN] login-validate: 强制字符串类型，拒绝对象/数组/数字（修复类型混淆 500 与 NoSQL 探测）
    if (typeof username !== 'string' || typeof password !== 'string') {
      await penalizeLogin(req)
      return res.status(400).json({
        error: 'Invalid input',
        message: 'Username and password must be strings'
      })
    }

    if (!username || !password) {
      return res.status(400).json({
        error: 'Missing credentials',
        message: 'Username and password are required'
      })
    }

    // 从Redis获取管理员信息（专用入口，key 缺失时返回 null）
    let adminData = await redis.getAdminCredentials()

    // 如果Redis中没有管理员凭据，尝试从init.json重新加载（与改密、获取用户信息共用同一实现）
    if (!adminData) {
      try {
        adminData = await reloadAdminCredentialsFromInit()
      } catch (error) {
        logger.error('❌ Failed to reload admin credentials:', error)
        return res.status(401).json({
          error: 'Invalid credentials',
          message: 'Invalid username or password'
        })
      }

      // init.json 不存在：此处沿用 401 而非 5xx，避免向未认证方泄露凭据配置状态
      if (!adminData) {
        return res.status(401).json({
          error: 'Invalid credentials',
          message: 'Invalid username or password'
        })
      }
    }

    // 验证用户名和密码
    const isValidUsername = adminData.username === username
    const isValidPassword = await bcrypt.compare(password, adminData.passwordHash)

    if (!isValidUsername || !isValidPassword) {
      // [SECHARDEN] login-penalize: 记录失败以触发 IP 限流
      await penalizeLogin(req)
      logger.security(`Failed login attempt for username: ${username}`)
      return res.status(401).json({
        error: 'Invalid credentials',
        message: 'Invalid username or password'
      })
    }

    // 生成会话token
    const sessionId = crypto.randomBytes(32).toString('hex')

    // 存储会话
    const sessionData = {
      username: adminData.username,
      loginTime: new Date().toISOString(),
      lastActivity: new Date().toISOString()
    }

    await redis.setSession(sessionId, sessionData, ADMIN_SESSION_TTL_SECONDS)

    // 不再更新 Redis 中的最后登录时间，因为 Redis 只是缓存
    // init.json 是唯一真实数据源

    // [SECHARDEN] login-clear: 成功登录清除该 IP 失败计数
    await clearLoginLimit(req)
    logger.success(`Admin login successful: ${username}`)

    return res.json({
      success: true,
      token: sessionId,
      expiresIn: config.security.adminSessionTimeout,
      username: adminData.username // 返回真实用户名
    })
  } catch (error) {
    logger.error('❌ Login error:', error)
    return res.status(500).json({
      error: 'Login failed',
      message: 'Internal server error'
    })
  }
})

// 🚪 管理员登出
router.post('/auth/logout', async (req, res) => {
  try {
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.cookies?.adminToken

    if (token) {
      await redis.deleteSession(token)
      logger.success('🚪 Admin logout successful')
    }

    return res.json({ success: true, message: 'Logout successful' })
  } catch (error) {
    logger.error('❌ Logout error:', error)
    return res.status(500).json({
      error: 'Logout failed',
      message: 'Internal server error'
    })
  }
})

// 🔑 修改账户信息
router.post('/auth/change-password', async (req, res) => {
  try {
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.cookies?.adminToken

    if (!token) {
      return res.status(401).json({
        error: 'No token provided',
        message: 'Authentication required'
      })
    }

    const { newUsername, currentPassword, newPassword } = req.body

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'Current password and new password are required'
      })
    }

    // 验证新密码长度
    if (newPassword.length < 8) {
      return res.status(400).json({
        error: 'Password too short',
        message: 'New password must be at least 8 characters long'
      })
    }

    // 获取当前会话
    const sessionData = await redis.getSession(token)

    // 🔒 安全修复：检查空对象
    if (!sessionData || Object.keys(sessionData).length === 0) {
      return res.status(401).json({
        error: 'Invalid token',
        message: 'Session expired or invalid'
      })
    }

    // 🔒 安全修复：验证会话完整性
    if (!sessionData.username || !sessionData.loginTime) {
      logger.security(
        `🔒 Invalid session structure in /auth/change-password from ${req.ip || 'unknown'}`
      )
      await redis.deleteSession(token)
      return res.status(401).json({
        error: 'Invalid session',
        message: 'Session data corrupted or incomplete'
      })
    }

    // 获取当前管理员信息（专用入口，key 缺失时返回 null）
    let adminData = await redis.getAdminCredentials()

    // 凭据缓存缺失不是故障，而是可自愈的中间态：init.json 是唯一真实数据源，
    // 随时可以从它重建。与登录路径共用同一实现，不在此复制一份。
    if (!adminData) {
      try {
        adminData = await reloadAdminCredentialsFromInit()
      } catch (error) {
        logger.error('❌ Failed to reload admin credentials:', error)
        return res.status(500).json({
          error: 'Configuration unreadable',
          message: 'Failed to read administrator credentials from init.json'
        })
      }

      if (!adminData) {
        return res.status(500).json({
          error: 'Configuration file not found',
          message: 'init.json file is missing'
        })
      }
    }

    // 验证当前密码
    const isValidPassword = await bcrypt.compare(currentPassword, adminData.passwordHash)
    if (!isValidPassword) {
      logger.security(`Invalid current password attempt for user: ${sessionData.username}`)
      return res.status(401).json({
        error: 'Invalid current password',
        message: 'Current password is incorrect'
      })
    }

    // 准备更新的数据
    const updatedUsername =
      newUsername && newUsername.trim() ? newUsername.trim() : adminData.username

    // 先更新 init.json（唯一真实数据源）
    if (!fs.existsSync(INIT_FILE_PATH)) {
      return res.status(500).json({
        error: 'Configuration file not found',
        message: 'init.json file is missing'
      })
    }

    try {
      const initData = JSON.parse(fs.readFileSync(INIT_FILE_PATH, 'utf8'))
      // const oldData = { ...initData }; // 备份旧数据

      // 更新 init.json
      initData.adminUsername = updatedUsername
      initData.adminPassword = newPassword // 保存明文密码到init.json
      initData.updatedAt = new Date().toISOString()

      // 先写入文件（如果失败则不会影响 Redis）
      fs.writeFileSync(INIT_FILE_PATH, JSON.stringify(initData, null, 2))

      // 文件写入成功后，更新 Redis 缓存
      const saltRounds = 10
      const newPasswordHash = await bcrypt.hash(newPassword, saltRounds)

      const updatedAdminData = {
        username: updatedUsername,
        passwordHash: newPasswordHash,
        createdAt: adminData.createdAt,
        lastLogin: adminData.lastLogin,
        updatedAt: new Date().toISOString()
      }

      // 走专用入口写入：经 setSession 写入会被盖上 24h TTL，凭据到点蒸发后
      // 下一次改密必然 500 —— 即「上一次成功的修改正是下一次失败的原因」。
      await redis.setAdminCredentials(updatedAdminData)
    } catch (fileError) {
      logger.error('❌ Failed to update init.json:', fileError)
      return res.status(500).json({
        error: 'Update failed',
        message: 'Failed to update configuration file'
      })
    }

    // 清除当前会话（强制用户重新登录）
    await redis.deleteSession(token)

    logger.success(`Admin password changed successfully for user: ${updatedUsername}`)

    return res.json({
      success: true,
      message: 'Password changed successfully. Please login again.',
      newUsername: updatedUsername
    })
  } catch (error) {
    logger.error('❌ Change password error:', error)
    return res.status(500).json({
      error: 'Change password failed',
      message: 'Internal server error'
    })
  }
})

// 👤 获取当前用户信息
router.get('/auth/user', async (req, res) => {
  try {
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.cookies?.adminToken

    if (!token) {
      return res.status(401).json({
        error: 'No token provided',
        message: 'Authentication required'
      })
    }

    // 获取当前会话
    const sessionData = await redis.getSession(token)

    // 🔒 安全修复：检查空对象
    if (!sessionData || Object.keys(sessionData).length === 0) {
      return res.status(401).json({
        error: 'Invalid token',
        message: 'Session expired or invalid'
      })
    }

    // 🔒 安全修复：验证会话完整性
    if (!sessionData.username || !sessionData.loginTime) {
      logger.security(`Invalid session structure in /auth/user from ${req.ip || 'unknown'}`)
      await redis.deleteSession(token)
      return res.status(401).json({
        error: 'Invalid session',
        message: 'Session data corrupted or incomplete'
      })
    }

    // 获取管理员信息（专用入口，key 缺失时返回 null）
    let adminData = await redis.getAdminCredentials()

    // 与登录、改密共用同一自愈实现：缓存缺失时从 init.json 重建，
    // 而不是让响应里的 username 变成 undefined（空对象会通过 `if (!adminData)` 守卫）。
    if (!adminData) {
      try {
        adminData = await reloadAdminCredentialsFromInit()
      } catch (error) {
        logger.error('❌ Failed to reload admin credentials:', error)
        return res.status(500).json({
          error: 'Configuration unreadable',
          message: 'Failed to read administrator credentials from init.json'
        })
      }

      if (!adminData) {
        return res.status(500).json({
          error: 'Configuration file not found',
          message: 'init.json file is missing'
        })
      }
    }

    return res.json({
      success: true,
      user: {
        username: adminData.username,
        loginTime: sessionData.loginTime,
        lastActivity: sessionData.lastActivity
      }
    })
  } catch (error) {
    logger.error('❌ Get user info error:', error)
    return res.status(500).json({
      error: 'Get user info failed',
      message: 'Internal server error'
    })
  }
})

// 🔄 刷新token
router.post('/auth/refresh', async (req, res) => {
  try {
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.cookies?.adminToken

    if (!token) {
      return res.status(401).json({
        error: 'No token provided',
        message: 'Authentication required'
      })
    }

    const sessionData = await redis.getSession(token)

    // 🔒 安全修复：检查空对象（hgetall 对不存在的 key 返回 {}）
    if (!sessionData || Object.keys(sessionData).length === 0) {
      return res.status(401).json({
        error: 'Invalid token',
        message: 'Session expired or invalid'
      })
    }

    // 🔒 安全修复：验证会话完整性（必须有 username 和 loginTime）
    if (!sessionData.username || !sessionData.loginTime) {
      logger.security(`Invalid session structure detected from ${req.ip || 'unknown'}`)
      await redis.deleteSession(token) // 清理无效/伪造的会话
      return res.status(401).json({
        error: 'Invalid session',
        message: 'Session data corrupted or incomplete'
      })
    }

    // 更新最后活动时间
    sessionData.lastActivity = new Date().toISOString()
    await redis.setSession(token, sessionData, ADMIN_SESSION_TTL_SECONDS)

    return res.json({
      success: true,
      token,
      expiresIn: config.security.adminSessionTimeout
    })
  } catch (error) {
    logger.error('❌ Token refresh error:', error)
    return res.status(500).json({
      error: 'Token refresh failed',
      message: 'Internal server error'
    })
  }
})

module.exports = router
