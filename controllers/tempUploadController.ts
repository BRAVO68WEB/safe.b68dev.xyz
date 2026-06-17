import * as path from 'path'
import * as crypto from 'crypto'
import ClientError from './utils/ClientError'
import ServerError from './utils/ServerError'

const config = require('./utils/ConfigManager')
const paths = require('./pathsController')
const utils = require('./utilsController')
const logger = require('./../logger')

const self: Record<string, any> = {}

// Config defaults
const tempConfig = config.tempUploads || {}
self.maxSize = tempConfig.maxSize || 50 // MB
self.maxSizeBytes = self.maxSize * 1e6
self.retentionHours = tempConfig.retentionHours || 24
self.maxPerIpPerHour = tempConfig.maxPerIpPerHour || 10
self.enabled = tempConfig.enabled !== false

// In-memory rate limiter (per IP)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

function checkRateLimit (ip: string): void {
  const now = Date.now()
  const entry = rateLimitMap.get(ip)

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 3600000 })
    return
  }

  if (entry.count >= self.maxPerIpPerHour) {
    throw new ClientError('Too many temporary uploads. Try again later.', { statusCode: 429 })
  }

  entry.count++
}

// Cleanup stale rate limit entries every 10 minutes
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) {
      rateLimitMap.delete(ip)
    }
  }
}, 600000)

self.upload = async (req: any, res: any) => {
  if (!self.enabled) {
    throw new ClientError('Temporary uploads are disabled.', { statusCode: 403 })
  }

  // Rate limit
  checkRateLimit(req.ip)

  // Parse multipart using HyperExpress's built-in parser
  req.files = []
  req.body = {}

  await req.multipart({}, async (field: any) => {
    const name = field.name
    if (!field.file) {
      req.body[name] = field.value || ''
      return
    }

    const file: any = {
      fieldname: name,
      originalname: field.file.name || '',
      mimetype: field.file.mime_type || 'application/octet-stream'
    }

    // Write to temp file
    const tmpPath = path.join(require('os').tmpdir(), `temp_upload_${Date.now()}_${Math.random().toString(36).slice(2)}`)
    const writeStream = require('fs').createWriteStream(tmpPath)
    await new Promise((resolve, reject) => {
      field.file.stream.pipe(writeStream)
      writeStream.on('finish', resolve)
      writeStream.on('error', reject)
    })
    const stat = require('fs').statSync(tmpPath)
    file.size = stat.size
    file.path = tmpPath

    req.files.push(file)
  })

  const files = req.files
  if (!files || !files.length) {
    throw new ClientError('No files uploaded.')
  }

  if (files.length > 1) {
    // Clean up temp files
    for (const f of files) {
      try { require('fs').unlinkSync(f.path) } catch {}
    }
    throw new ClientError('Only one file at a time for temporary uploads.')
  }

  const file = files[0]
  const extname = path.extname(file.originalname || '').toLowerCase()
  const originalname = file.originalname || 'unknown'
  const size = file.size || 0

  if (size === 0) {
    try { require('fs').unlinkSync(file.path) } catch {}
    throw new ClientError('Empty files are not allowed.')
  }

  if (size > self.maxSizeBytes) {
    try { require('fs').unlinkSync(file.path) } catch {}
    throw new ClientError(`File too large. Maximum size is ${self.maxSize} MB.`)
  }

  // Generate unique identifier
  const identifier = crypto.randomBytes(8).toString('base64url')
  const filename = `temp_${identifier}${extname}`
  const filePath = path.join(paths.uploads, filename)

  // Move from temp to uploads (copy + unlink to handle cross-device)
  require('fs').copyFileSync(file.path, filePath)
  try { require('fs').unlinkSync(file.path) } catch {}

  const now = Math.floor(Date.now() / 1000)
  const expiresAt = now + (self.retentionHours * 3600)

  // Store in database
  await utils.db.table('temp_uploads').insert({
    name: filename,
    original: originalname,
    type: file.mimetype || 'application/octet-stream',
    size: String(size),
    hash: null,
    ip: req.ip,
    identifier,
    created_at: now,
    expires_at: expiresAt,
    download_count: 0
  })

  const url = `${config.domain || config.homeDomain || ''}/temp/${identifier}`

  return res.json({
    success: true,
    files: [{
      url,
      identifier,
      original: originalname,
      size,
      expiresAt
    }]
  })
}

self.get = async (req: any, res: any) => {
  const identifier = req.path_parameters?.identifier || req.params?.identifier
  if (!identifier) {
    throw new ClientError('Missing identifier.')
  }

  const file = await utils.db.table('temp_uploads')
    .where('identifier', identifier)
    .first()

  if (!file) {
    throw new ClientError('File not found.', { statusCode: 404 })
  }

  const now = Math.floor(Date.now() / 1000)
  if (file.expires_at < now) {
    // File expired, clean up
    try {
      const fs = require('fs')
      const filePath = path.join(paths.uploads, file.name)
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
      await utils.db.table('temp_uploads').where('id', file.id).delete()
    } catch (err) {
      logger.error(err)
    }
    throw new ClientError('File has expired.', { statusCode: 410 })
  }

  return res.json({
    success: true,
    file: {
      identifier: file.identifier,
      original: file.original,
      type: file.type,
      size: parseInt(file.size),
      createdAt: file.created_at,
      expiresAt: file.expires_at,
      downloadCount: file.download_count,
      url: `${config.domain || config.homeDomain || ''}/temp/${file.identifier}`
    }
  })
}

self.serve = async (req: any, res: any) => {
  const identifier = req.path_parameters?.identifier || req.params?.identifier
  if (!identifier) {
    throw new ClientError('Missing identifier.')
  }

  const file = await utils.db.table('temp_uploads')
    .where('identifier', identifier)
    .first()

  if (!file) {
    throw new ClientError('File not found.', { statusCode: 404 })
  }

  const now = Math.floor(Date.now() / 1000)
  if (file.expires_at < now) {
    try {
      const fs = require('fs')
      const filePath = path.join(paths.uploads, file.name)
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
      await utils.db.table('temp_uploads').where('id', file.id).delete()
    } catch (err) {
      logger.error(err)
    }
    throw new ClientError('File has expired.', { statusCode: 410 })
  }

  // Increment download count
  await utils.db.table('temp_uploads')
    .where('id', file.id)
    .increment('download_count', 1)

  // Serve the file
  const fs = require('fs')
  const filePath = path.join(paths.uploads, file.name)
  if (!fs.existsSync(filePath)) {
    throw new ClientError('File not found on disk.', { statusCode: 404 })
  }

  res.header('Content-Type', file.type || 'application/octet-stream')
  res.header('Content-Disposition', `inline; filename="${file.original}"`)
  res.header('Cache-Control', 'no-store')

  const readStream = fs.createReadStream(filePath)
  return res.stream(readStream)
}

self.renderPage = async (req: any, res: any) => {
  return res.render('temp', {
    config,
    utils,
    versions: utils.versionStrings,
    maxSize: self.maxSize,
    retentionHours: self.retentionHours
  })
}

self.cleanupExpired = async () => {
  const now = Math.floor(Date.now() / 1000)
  const expired = await utils.db.table('temp_uploads')
    .where('expires_at', '<', now)

  if (!expired.length) return { deleted: 0 }

  const fs = require('fs')
  let deleted = 0

  for (const file of expired) {
    try {
      const filePath = path.join(paths.uploads, file.name)
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
      await utils.db.table('temp_uploads').where('id', file.id).delete()
      deleted++
    } catch (err) {
      logger.error(err)
    }
  }

  return { deleted }
}

export = self
