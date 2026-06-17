import randomstring = require('randomstring')
import { RateLimiterMemory } from 'rate-limiter-flexible'
import perms = require('./permissionController')
import utils = require('./utilsController')
import ClientError = require('./utils/ClientError')
import ServerError = require('./utils/ServerError')
import logger = require('./../logger')

interface TokenSelf {
  tokenLength: number
  tokenMaxTries: number
  onHold: Set<string>
  authFailuresRateLimiter: InstanceType<typeof RateLimiterMemory>
  getUniqueToken: (res?: any) => Promise<string>
  unholdTokens: (res: any) => void
  verify: (req: any, res: any) => Promise<any>
  list: (req: any, res: any) => Promise<any>
  change: (req: any, res: any) => Promise<any>
}

const self: TokenSelf = {
  tokenLength: 64,
  tokenMaxTries: 3,

  onHold: new Set(),

  authFailuresRateLimiter: new RateLimiterMemory({
    points: 6,
    duration: 10 * 60
  })
} as TokenSelf

self.getUniqueToken = async (res?: any): Promise<string> => {
  for (let i = 0; i < self.tokenMaxTries; i++) {
    const token = randomstring.generate(self.tokenLength)

    if (self.onHold.has(token)) {
      logger.debug(`Token ${utils.mask(token)} is currently held by another request (${i + 1}/${utils.idMaxTries}).`)
      continue
    }

    self.onHold.add(token)

    const user = await utils.db.table('users')
      .where('token', token)
      .select('id')
      .first()
    if (user) {
      self.onHold.delete(token)
      logger.debug(`User with token ${utils.mask(token)} already exists (${i + 1}/${utils.idMaxTries}).`)
      continue
    }

    if (res) {
      if (!res.locals.tokens) {
        res.locals.tokens = []
        res.once('finish', () => { self.unholdTokens(res) })
      }
      res.locals.tokens.push(token)
    }

    return token
  }

  throw new ServerError('Failed to allocate a unique token. Try again?')
}

self.unholdTokens = (res: any): void => {
  if (!res.locals.tokens) return

  for (const token of res.locals.tokens) {
    self.onHold.delete(token)
    logger.debug(`Unheld token ${utils.mask(token)}.`)
  }

  delete res.locals.tokens
}

self.verify = async (req: any, res: any): Promise<any> => {
  const token = typeof req.body.token === 'string'
    ? req.body.token.trim()
    : ''

  if (!token) {
    throw new ClientError('No token provided.', { statusCode: 403 })
  }

  const rateLimiterRes = await self.authFailuresRateLimiter.get(req.ip)
  if (rateLimiterRes && rateLimiterRes.remainingPoints <= 0) {
    throw new ClientError('Too many auth failures. Try again in a while.', { statusCode: 429 })
  }

  const user = await utils.db.table('users')
    .where('token', token)
    .select('username', 'permission')
    .first()

  if (!user) {
    await self.authFailuresRateLimiter.consume(req.ip, 1)
    throw new ClientError('Invalid token.', { statusCode: 403, code: 10001 })
  }

  const obj: any = {
    success: true,
    username: user.username,
    permissions: perms.mapPermissions(user)
  }

  const group = perms.group(user)
  if (group) {
    obj.group = group
    if (utils.retentions.enabled) {
      obj.retentionPeriods = utils.retentions.periods[group]
      obj.defaultRetentionPeriod = utils.retentions.default[group]
    }
  }

  if (utils.clientVersion) {
    obj.version = utils.clientVersion
  }

  return res.json(obj)
}

self.list = async (req: any, res: any): Promise<any> => {
  return res.json({ success: true, token: req.locals.user.token })
}

self.change = async (req: any, res: any): Promise<any> => {
  const newToken = await self.getUniqueToken(res)

  await utils.db.table('users')
    .where('token', req.locals.user.token)
    .update({
      token: newToken,
      timestamp: Math.floor(Date.now() / 1000)
    })

  return res.json({ success: true, token: newToken })
}

export = self
