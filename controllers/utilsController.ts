import { promisify } from 'util'
import { AbortController } from 'abort-controller'
import fastq = require('fastq')
import fetch = require('node-fetch')
import ffmpeg = require('fluent-ffmpeg')
import jetpack = require('fs-jetpack')
import knex = require('knex')
import MarkdownIt = require('markdown-it')
import path = require('path')
import sharp = require('sharp')
import paths = require('./pathsController')
import perms = require('./permissionController')
import ClientError = require('./utils/ClientError')
import Constants = require('./utils/Constants')
import ServerError = require('./utils/ServerError')
import SimpleDataStore = require('./utils/SimpleDataStore')
import StatsManager = require('./utils/StatsManager')
import config = require('./utils/ConfigManager')
import logger = require('./../logger')

const devmode = process.env.NODE_ENV === 'development'

interface Retentions {
  enabled: boolean
  periods: Record<string, any[]>
  default: Record<string, any>
}

interface MarkdownData {
  instance: any
  defaultRenderers: Record<string, any>
}

interface UtilsSelf {
  devmode: boolean
  inspect: any
  db: any
  md: MarkdownData
  gitHash: string | null
  idMaxTries: number
  stripTagsBlacklistedExts: string[]
  thumbsSize: number
  ffprobe: any
  timezoneOffset: number
  retentions: Retentions
  albumRenderStore: InstanceType<typeof SimpleDataStore>
  contentDispositionStore: any
  clientVersion?: string
  fetch: (url: string, options?: any) => Promise<any>
  mayGenerateThumb: (extname: string) => boolean
  isAnimatedThumb: (extname: string) => boolean
  extname: (filename: string, lower?: boolean) => string
  escape: (string: string) => string
  unescape: (string: string) => string
  stripIndents: (string: string) => string
  mask: (string: string) => string
  pathSafeIp: (ip: string) => string
  filterUniquifySqlArray: (value: any, index: number, array: any[]) => boolean
  unlistenEmitters: (emitters: any[], eventName: string, listener: any) => void
  assertRequestType: (req: any, type: string) => void
  assertJSON: (req: any, res: any) => Promise<void>
  generateThumbs: (name: string, extname: string, force?: boolean) => Promise<boolean>
  stripTags: (name: string, extname: string) => Promise<any>
  unlinkFile: (filename: string) => Promise<void>
  bulkDeleteFromDb: (field: string, values?: any[], user?: any, permissionBypass?: boolean) => Promise<any[]>
  purgeCloudflareCache: (names: string[], uploads?: boolean, thumbs?: boolean) => Promise<any[]>
  bulkDeleteExpired: (dryrun?: boolean, verbose?: boolean) => Promise<any>
  deleteStoredAlbumRenders: (albumids: any[]) => void
  invalidateStatsCache: (type: string) => void
  buildStatsPayload: (name: string) => any
  stats: (req: any, res: any) => Promise<any>
  statsCategory: (req: any, res: any) => Promise<any>
}

const self: UtilsSelf = {
  devmode,
  inspect: devmode && require('util').inspect,

  db: knex(config.database),
  md: {
    instance: new MarkdownIt({
      html: false,
      breaks: true,
      linkify: true
    }),
    defaultRenderers: {}
  },
  gitHash: null,

  idMaxTries: config.uploads.maxTries || 1,

  stripTagsBlacklistedExts: Array.isArray(config.uploads.stripTags.blacklistExtensions)
    ? config.uploads.stripTags.blacklistExtensions
    : [],

  thumbsSize: config.uploads.generateThumbs.size || 200,
  ffprobe: promisify(ffmpeg.ffprobe),

  timezoneOffset: new Date().getTimezoneOffset(),

  retentions: {
    enabled: false,
    periods: {},
    default: {}
  },

  albumRenderStore: new SimpleDataStore({
    limit: 10,
    strategy: SimpleDataStore.STRATEGIES[0]
  }),
  contentDispositionStore: null
} as UtilsSelf

self.md.defaultRenderers.link_open = self.md.instance.renderer.rules.link_open || function (tokens: any, idx: number, options: any, env: any, that: any) {
  return that.renderToken(tokens, idx, options)
}

self.md.instance.renderer.rules.link_open = function (tokens: any, idx: number, options: any, env: any, that: any) {
  const aIndex = tokens[idx].attrIndex('target')
  if (aIndex < 0) {
    tokens[idx].attrPush(['target', '_blank'])
  } else {
    tokens[idx].attrs[aIndex][1] = '_blank'
  }
  const relIndex = tokens[idx].attrIndex('rel')
  if (relIndex < 0) {
    tokens[idx].attrPush(['rel', 'noopener noreferrer'])
  } else {
    tokens[idx].attrs[relIndex][1] = 'noopener noreferrer'
  }
  return self.md.defaultRenderers.link_open(tokens, idx, options, env, that)
}

if (typeof config.uploads.retentionPeriods === 'object' &&
  Object.keys(config.uploads.retentionPeriods).length) {
  const _retentionPeriods: Record<string, any[]> = Object.assign({}, config.uploads.retentionPeriods)
  const _groups: Record<string, number> = { _: -1 }
  Object.assign(_groups, perms.permissions)

  const names = Object.keys(_groups)
  for (const name of names) {
    if (Array.isArray(_retentionPeriods[name]) && _retentionPeriods[name].length) {
      _retentionPeriods[name] = _retentionPeriods[name]
        .filter((v: any) => (Number.isFinite(v) && v >= 0) || v === null)
    } else {
      _retentionPeriods[name] = []
    }
  }

  if (!_retentionPeriods._.length && !config.private) {
    logger.error('Guests\' retention periods are missing, yet this installation is not set to private.')
    process.exit(1)
  }

  const _sorted = Object.keys(_groups)
    .sort((a, b) => _groups[a] - _groups[b])

  for (let i = 0; i < _sorted.length; i++) {
    const current = _sorted[i]
    const _periods = [..._retentionPeriods[current]]
    self.retentions.default[current] = _periods.length ? _periods[0] : null

    if (i > 0) {
      for (let j = i - 1; j >= 0; j--) {
        const lower = _sorted[j]
        if (_groups[lower] < _groups[current]) {
          _periods.unshift(..._retentionPeriods[lower])
          if (self.retentions.default[current] === null) {
            self.retentions.default[current] = self.retentions.default[lower]
          }
        }
      }
    }

    self.retentions.periods[current] = _periods
      .filter((v: any, i: number, a: any[]) => v !== null && a.indexOf(v) === i)
      .sort((a: any, b: any) => a - b)

    if (self.retentions.periods[current].length) {
      self.retentions.enabled = true
    }
  }
} else if (Array.isArray(config.uploads.temporaryUploadAges) && config.uploads.temporaryUploadAges.length) {
  self.retentions.periods._ = config.uploads.temporaryUploadAges
    .filter((v: any) => Number.isFinite(v) && v >= 0)
  self.retentions.default._ = self.retentions.periods._[0]

  for (const name of Object.keys(perms.permissions)) {
    self.retentions.periods[name] = self.retentions.periods._
    self.retentions.default[name] = self.retentions.default._
  }

  self.retentions.enabled = true
}

self.fetch = (url: string, options: any = {}): Promise<any> => {
  if (options.timeout === undefined) {
    return fetch(url, options)
  }

  const abortController = new AbortController()
  const timeout = setTimeout(() => {
    abortController.abort()
  }, options.timeout)

  options.signal = abortController.signal
  delete options.timeout

  return fetch(url, options)
    .finally(() => {
      clearTimeout(timeout)
    })
}

const cloudflareAuth = config.cloudflare && config.cloudflare.zoneId &&
  (config.cloudflare.apiToken || config.cloudflare.userServiceKey ||
  (config.cloudflare.apiKey && config.cloudflare.email))

const cloudflarePurgeCacheQueue = cloudflareAuth && fastq.promise(async (chunk: string[]) => {
  const MAX_TRIES = 3
  const url = `https://api.cloudflare.com/client/v4/zones/${config.cloudflare.zoneId}/purge_cache`

  const result: any = {
    success: false,
    files: chunk,
    errors: []
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  }
  if (config.cloudflare.apiToken) {
    headers.Authorization = `Bearer ${config.cloudflare.apiToken}`
  } else if (config.cloudflare.userServiceKey) {
    headers['X-Auth-User-Service-Key'] = config.cloudflare.userServiceKey
  } else if (config.cloudflare.apiKey && config.cloudflare.email) {
    headers['X-Auth-Key'] = config.cloudflare.apiKey
    headers['X-Auth-Email'] = config.cloudflare.email
  }

  for (let i = 0; i < MAX_TRIES; i++) {
    const _log = (message: string) => {
      let prefix = `[CF]: ${i + 1}/${MAX_TRIES}: ${path.basename(chunk[0])}`
      if (chunk.length > 1) prefix += ',\u2026'
      logger.log(`${prefix}: ${message}`)
    }

    const response = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ files: chunk }),
      headers
    })
      .then((res: any) => res.json())
      .catch((error: any) => error)

    if (response instanceof Error) {
      const errorString = response.toString()
      if (i < MAX_TRIES - 1) {
        _log(`${errorString}. Retrying in 5 seconds\u2026`)
        await new Promise(resolve => setTimeout(resolve, 5000))
        continue
      }
      result.errors = [errorString]
      break
    }

    const hasErrorsArray = Array.isArray(response.errors) && response.errors.length
    if (hasErrorsArray) {
      const rateLimit = response.errors.find((error: any) => /rate limit/i.test(error.message))
      if (rateLimit && i < MAX_TRIES - 1) {
        _log(`${rateLimit.code}: ${rateLimit.message}. Retrying in a minute\u2026`)
        await new Promise(resolve => setTimeout(resolve, 60000))
        continue
      }
    }

    result.success = response.success
    result.errors = hasErrorsArray
      ? response.errors.map((error: any) => `${error.code}: ${error.message}`)
      : []
    break
  }

  return result
}, 1)

self.mayGenerateThumb = (extname: string): boolean => {
  extname = extname.toLowerCase()
  return (config.uploads.generateThumbs.image && (Constants.IMAGE_EXTS as readonly string[]).includes(extname)) ||
    (config.uploads.generateThumbs.video && (Constants.VIDEO_EXTS as readonly string[]).includes(extname))
}

self.isAnimatedThumb = (extname: string): boolean => {
  extname = extname.toLowerCase()
  return (config.uploads.generateThumbs.animated && (Constants.ANIMATED_EXTS as readonly string[]).includes(extname))
}

const extPreserves: RegExp[] = [
  /\.tar\.\w+/i
]

self.extname = (filename: string, lower?: boolean): string => {
  if (!/\../.test(filename)) return ''

  let multi = ''
  let extname = ''

  if (/\.\d{3}$/.test(filename)) {
    multi = filename.slice(filename.lastIndexOf('.') - filename.length)
    filename = filename.slice(0, filename.lastIndexOf('.'))
  }

  for (const extPreserve of extPreserves) {
    const match = filename.match(extPreserve)
    if (match && match[0]) {
      extname = match[0]
      break
    }
  }

  if (!extname) {
    extname = filename.slice(filename.lastIndexOf('.') - filename.length)
  }

  const str = extname + multi
  return lower ? str.toLowerCase() : str
}

const escapeMap: Record<string, string> = {
  '&': '&amp;',
  '"': '&quot;',
  '\'': '&#39;',
  '<': '&lt;',
  '>': '&gt;',
  '\\': '&#92;'
}

const escapeRegex = /[&"'<>\\]/g

const unescapeMap: Record<string, string> = Object.keys(escapeMap).reduce((ret: Record<string, string>, key: string) => {
  ret[escapeMap[key]] = key
  return ret
}, {})

const unescapeRegex = /&(amp|quot|#39|lt|gt|#92);/g

self.escape = (string: string): string => {
  return string.replace(escapeRegex, key => escapeMap[key])
}

self.unescape = (string: string): string => {
  return string.replace(unescapeRegex, key => unescapeMap[key])
}

self.stripIndents = (string: string): string => {
  if (!string) return string
  const result = string.replace(/^[^\S\n]+/gm, '')
  const match = result.match(/^[^\S\n]*(?=\S)/gm)
  const indent = match && Math.min(...match.map(el => el.length))
  if (indent) {
    const regexp = new RegExp(`^.{${indent}}`, 'gm')
    return result.replace(regexp, '')
  }
  return result
}

self.mask = (string: string): string => {
  if (!string) return string
  const max = Math.min(Math.floor(string.length / 2), 8)
  const fragment = Math.floor(max / 2)
  if (string.length <= fragment) {
    return '*'.repeat(string.length)
  } else {
    return string.substring(0, fragment) +
      '*'.repeat(Math.min(string.length - (fragment * 2), 4)) +
      string.substring(string.length - fragment)
  }
}

self.pathSafeIp = (ip: string): string => {
  if (!ip) return ''
  return ip.replace(/:/g, '-')
}

self.filterUniquifySqlArray = (value: any, index: number, array: any[]): boolean => {
  return value !== null &&
    value !== undefined &&
    value !== '' &&
    array.indexOf(value) === index
}

self.unlistenEmitters = (emitters: any[], eventName: string, listener: any): void => {
  emitters.forEach(emitter => {
    if (!emitter) return
    emitter.off(eventName, listener)
  })
}

self.assertRequestType = (req: any, type: string): void => {
  if (!req.is(type)) {
    throw new ClientError(`Request Content-Type must be ${type}.`)
  }
}

self.assertJSON = async (req: any, res: any): Promise<void> => {
  self.assertRequestType(req, 'application/json')
  req.body = await req.json()
}

self.generateThumbs = async (name: string, extname: string, force?: boolean): Promise<boolean> => {
  extname = extname.toLowerCase()
  const thumbname = name.slice(0, -extname.length)
  let thumbext = '.png'
  if (self.isAnimatedThumb(extname)) thumbext = '.gif'

  const thumbfile = path.join(paths.thumbs, thumbname + thumbext)

  try {
    if (thumbext === '.gif') {
      const staticthumb = path.join(paths.thumbs, thumbname + '.png')
      const stat = await jetpack.inspectAsync(staticthumb)
      if (stat) {
        await jetpack.removeAsync(staticthumb)
      }
    }

    const stat = await jetpack.inspectAsync(thumbfile)
    if (stat) {
      if (stat.type === 'symlink') {
        await jetpack.removeAsync(thumbfile)
      } else if (!force) {
        return true
      }
    }

    const input = path.join(paths.uploads, name)

    if ((Constants.IMAGE_EXTS as readonly string[]).includes(extname)) {
      const sharpOptions: any = {}
      if (thumbext === '.gif') {
        sharpOptions.animated = true
      }

      const resizeOptions: any = {
        width: self.thumbsSize,
        height: self.thumbsSize,
        fit: 'contain',
        background: {
          r: 0,
          g: 0,
          b: 0,
          alpha: 0
        }
      }

      const image = sharp(input, sharpOptions)

      const metadata = await image.metadata()
      if (metadata.width > resizeOptions.width || metadata.height > resizeOptions.height) {
        await image
          .resize(resizeOptions)
          .toFile(thumbfile)
      } else if (metadata.width === resizeOptions.width && metadata.height === resizeOptions.height) {
        await image
          .toFile(thumbfile)
      } else {
        const x = resizeOptions.width - metadata.width!
        const y = resizeOptions.height - metadata.height!
        await image
          .extend({
            top: Math.floor(y / 2),
            bottom: Math.ceil(y / 2),
            left: Math.floor(x / 2),
            right: Math.ceil(x / 2),
            background: resizeOptions.background
          })
          .toFile(thumbfile)
      }
    } else if ((Constants.VIDEO_EXTS as readonly string[]).includes(extname)) {
      const metadata = await self.ffprobe(input)

      const duration = parseInt(metadata.format.duration)
      if (isNaN(duration)) {
        throw new Error('File does not have valid duration metadata')
      }

      const videoStream = metadata.streams && metadata.streams.find((s: any) => s.codec_type === 'video')
      if (!videoStream || !videoStream.width || !videoStream.height) {
        throw new Error('File does not have valid video stream metadata')
      }

      await new Promise<void>((resolve, reject) => {
        ffmpeg(input)
          .on('error', (error: any) => reject(error))
          .on('end', () => resolve())
          .screenshots({
            folder: paths.thumbs,
            filename: name.slice(0, -extname.length) + '.png',
            timemarks: [
              config.uploads.generateThumbs.videoTimemark || '20%'
            ],
            size: videoStream.width >= videoStream.height
              ? `${self.thumbsSize}x?`
              : `?x${self.thumbsSize}`
          })
      })
        .catch((error: any) => error)
        .then(async (error: any) => {
          if (await jetpack.existsAsync(thumbfile)) {
            return true
          } else {
            throw error || new Error('FFMPEG exited with empty output file')
          }
        })
    } else {
      return false
    }
  } catch (error: any) {
    logger.error(`[${name}]: generateThumbs(): ${error.toString().trim()}`)
    await jetpack.removeAsync(thumbfile)
    try {
      await jetpack.symlinkAsync(paths.thumbPlaceholder, thumbfile)
      return true
    } catch (err: any) {
      logger.error(`[${name}]: generateThumbs(): ${err.toString().trim()}`)
      return false
    }
  }

  return true
}

self.stripTags = async (name: string, extname: string): Promise<any> => {
  extname = extname.toLowerCase()
  if (self.stripTagsBlacklistedExts.includes(extname)) return false

  const fullPath = path.join(paths.uploads, name)
  let tmpPath: string | undefined
  let isError: boolean | undefined

  try {
    if ((Constants.IMAGE_EXTS as readonly string[]).includes(extname)) {
      const tmpName = `tmp-${name}`
      tmpPath = path.join(paths.uploads, tmpName)
      await jetpack.renameAsync(fullPath, tmpName)
      await sharp(tmpPath)
        .toFile(fullPath)
    } else if (config.uploads.stripTags.video && (Constants.VIDEO_EXTS as readonly string[]).includes(extname)) {
      const tmpName = `tmp-${name}`
      tmpPath = path.join(paths.uploads, tmpName)
      await jetpack.renameAsync(fullPath, tmpName)
      await new Promise<void>((resolve, reject) => {
        ffmpeg(tmpPath)
          .output(fullPath)
          .outputOptions([
            '-c copy',
            '-map_metadata:g -1:g',
            '-map_metadata:s:v -1:g',
            '-map_metadata:s:a -1:g'
          ])
          .on('error', (error: any) => reject(error))
          .on('end', () => resolve())
          .run()
      })
    } else {
      return false
    }
  } catch (error: any) {
    logger.error(`[${name}]: stripTags(): ${error.toString().trim()}`)
    isError = true
  }

  if (tmpPath) {
    await jetpack.removeAsync(tmpPath)
  }

  if (isError) {
    throw new ServerError('An error occurred while stripping tags. The format may not be supported.')
  }

  return jetpack.inspectAsync(fullPath)
}

self.unlinkFile = async (filename: string): Promise<void> => {
  await jetpack.removeAsync(path.join(paths.uploads, filename))

  const identifier = filename.split('.')[0]
  const extname = self.extname(filename, true)

  if ((Constants.IMAGE_EXTS as readonly string[]).includes(extname) || (Constants.VIDEO_EXTS as readonly string[]).includes(extname)) {
    await jetpack.removeAsync(path.join(paths.thumbs, `${identifier}.png`))
  }
}

self.bulkDeleteFromDb = async (field: string, values: any[] = [], user?: any, permissionBypass = false): Promise<any[]> => {
  if ((!user && !permissionBypass) || !['id', 'name'].includes(field) || !values.length) {
    return values
  }

  const MAX_VARIABLES_CHUNK_SIZE = 999
  const chunks: any[][] = []
  while (values.length) {
    chunks.push(values.splice(0, MAX_VARIABLES_CHUNK_SIZE))
  }

  const failed: any[] = []
  const ismoderator = permissionBypass || perms.is(user, 'moderator')

  try {
    const unlinkeds: any[] = []
    const albumids: any[] = []

    await Promise.all(chunks.map(async (chunk: any[]) => {
      const files = await self.db.table('files')
        .whereIn(field, chunk)
        .where(function (this: any) {
          if (!ismoderator) {
            this.where('userid', user.id)
          }
        })

      failed.push(...chunk.filter(value => !files.find((file: any) => file[field] === value)))

      const unlinked: any[] = []

      await Promise.all(files.map(async (file: any) => {
        try {
          await self.unlinkFile(file.name)
          unlinked.push(file)
        } catch (error) {
          logger.error(error)
          failed.push(file[field])
        }
      }))

      if (!unlinked.length) return

      await self.db.table('files')
        .whereIn('id', unlinked.map((file: any) => file.id))
        .del()
      self.invalidateStatsCache('uploads')

      unlinked.forEach((file: any) => {
        if (file.albumid && !albumids.includes(file.albumid)) {
          albumids.push(file.albumid)
        }
        if (self.contentDispositionStore) {
          self.contentDispositionStore.delete(file.name)
        }
      })

      unlinkeds.push(...unlinked)
    }))

    if (unlinkeds.length) {
      if (albumids.length) {
        self.db.table('albums')
          .whereIn('id', albumids)
          .update('editedAt', Math.floor(Date.now() / 1000))
          .catch(logger.error)
        self.deleteStoredAlbumRenders(albumids)
      }

      if (config.cloudflare.purgeCache) {
        self.purgeCloudflareCache(unlinkeds.map((file: any) => file.name), true, true)
          .then((results: any[]) => {
            for (const result of results) {
              if (result.errors.length) {
                result.errors.forEach((error: string) => logger.error(`[CF]: ${error}`))
              }
            }
          })
      }
    }
  } catch (error) {
    logger.error(error)
  }

  return failed
}

self.purgeCloudflareCache = async (names: string[], uploads?: boolean, thumbs?: boolean): Promise<any[]> => {
  const errors: string[] = []
  if (!cloudflareAuth) {
    errors.push('Cloudflare auth is incomplete or missing')
  }
  if (!Array.isArray(names) || !names.length) {
    errors.push('Names array is invalid or empty')
  }
  if (errors.length) {
    return [{ success: false, files: [], errors }]
  }

  let domain = config.domain
  if (!uploads) domain = config.homeDomain

  const thumbNames: string[] = []
  names = names.map(name => {
    if (uploads) {
      const url = `${domain}/${name}`
      const extname = self.extname(name)
      if (thumbs && self.mayGenerateThumb(extname)) {
        thumbNames.push(`${domain}/thumbs/${name.slice(0, -extname.length)}.png`)
      }
      return url
    } else {
      return name === 'home' ? domain : `${domain}/${name}`
    }
  })
  names.push(...thumbNames)

  const MAX_LENGTH = 30
  const chunks: string[][] = []
  while (names.length) {
    chunks.push(names.splice(0, MAX_LENGTH))
  }

  const results: any[] = []
  for (const chunk of chunks) {
    const result = await cloudflarePurgeCacheQueue.push(chunk)
    results.push(result)
  }
  return results
}

self.bulkDeleteExpired = async (dryrun?: boolean, verbose?: boolean): Promise<any> => {
  const timestamp = Date.now() / 1000
  const fields = ['id']
  if (verbose) fields.push('name')

  const result: any = {}
  result.expired = await self.db.table('files')
    .where('expirydate', '<=', timestamp)
    .select(fields)

  if (!dryrun) {
    const field = fields[0]
    const values = result.expired.slice().map((row: any) => row[field])
    result.failed = await self.bulkDeleteFromDb(field, values, null, true)
    if (verbose && result.failed.length) {
      result.failed = result.failed
        .map((failed: any) => result.expired.find((file: any) => file[fields[0]] === failed))
    }
  }
  return result
}

self.deleteStoredAlbumRenders = (albumids: any[]): void => {
  for (const albumid of albumids) {
    self.albumRenderStore.delete(`${albumid}`)
    self.albumRenderStore.delete(`${albumid}-nojs`)
  }
}

self.invalidateStatsCache = StatsManager.invalidateStatsCache

self.buildStatsPayload = (name: string): any => {
  return {
    ...((StatsManager.cachedStats[name] && StatsManager.cachedStats[name].cache) || {}),
    meta: {
      key: name,
      ...(StatsManager.cachedStats[name]
        ? {
            cached: Boolean(StatsManager.cachedStats[name].cache),
            generatedOn: StatsManager.cachedStats[name].generatedOn || 0,
            maxAge: typeof StatsManager.statGenerators[name].maxAge === 'number'
              ? StatsManager.statGenerators[name].maxAge
              : null
          }
        : {
            cached: false
          }),
      type: StatsManager.Type.HIDDEN
    }
  }
}

self.stats = async (req: any, res: any): Promise<any> => {
  const isadmin = perms.is(req.locals.user, 'admin')
  if (!isadmin) {
    return res.status(403).end()
  }

  const hrstart = process.hrtime()

  await StatsManager.generateStats(self.db)

  const stats = StatsManager.statNames.reduce((acc: Record<string, any>, name: string) => {
    const title = StatsManager.statGenerators[name].title
    acc[title] = self.buildStatsPayload(name)
    return acc
  }, {})

  return res.json({ success: true, stats, hrtime: process.hrtime(hrstart) })
}

self.statsCategory = async (req: any, res: any): Promise<any> => {
  const isadmin = perms.is(req.locals.user, 'admin')
  if (!isadmin) {
    return res.status(403).end()
  }

  const category = req.path_parameters && req.path_parameters.category
  if (!category || !StatsManager.statNames.includes(category)) {
    throw new ClientError('Bad request.')
  }

  const hrstart = process.hrtime()

  await StatsManager.generateStats(self.db, [category], true)

  const title = StatsManager.statGenerators[category].title
  const stats: Record<string, any> = {
    [title]: self.buildStatsPayload(category)
  }

  return res.json({ success: true, stats, hrtime: process.hrtime(hrstart) })
}

export = self
