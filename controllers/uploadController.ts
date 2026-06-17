import blake3 = require('blake3')
import contentDisposition = require('content-disposition')
import jetpack = require('fs-jetpack')
import parseDuration = require('parse-duration')
import path = require('path')
import randomstring = require('randomstring')
import searchQuery = require('search-query-parser')
import auth = require('./authController')
import paths = require('./pathsController')
import perms = require('./permissionController')
import utils = require('./utilsController')
import ClientError = require('./utils/ClientError')
import Constants = require('./utils/Constants')
import ScannerManager = require('./utils/ScannerManager')
import ServerError = require('./utils/ServerError')
import config = require('./utils/ConfigManager')
import logger = require('./../logger')

if (config.uploads.cacheFileIdentifiers) {
  logger.error('Config option "uploads.cacheFileIdentifiers" is DEPRECATED.')
  logger.error('There is now only "uploads.queryDatabaseForIdentifierMatch" for a similar behavior.')
}

interface UploadSelf {
  onHold: Set<string>
  isExtensionFiltered: (extname: string) => boolean
  parseFileIdentifierLength: (fileLength: any) => number
  getUniqueUploadIdentifier: (length: number, extension?: string, res?: any) => Promise<string>
  unholdUploadIdentifiers: (res: any) => void
  assertRetentionPeriod: (user: any, age: any) => number | null
  parseStripTags: (stripTags: any) => boolean
  upload: (req: any, res: any) => Promise<any>
  unfreezeChunksData: (files?: any[], increase?: boolean) => Promise<void>
  cleanUpFiles: (files?: any[]) => Promise<void>
  actuallyUpload: (req: any, res: any, data?: any) => Promise<any>
  actuallyUploadUrls: (req: any, res: any, data?: any) => Promise<any>
  finishChunks: (req: any, res: any) => Promise<any>
  actuallyFinishChunks: (req: any, res: any, files: any[]) => Promise<any>
  cleanUpChunks: (uuid: string) => Promise<void>
  assertScanUserBypass: (user: any, filenames: string | string[]) => boolean
  assertScanFileBypass: (data: any) => boolean
  scanFiles: (user: any, filesData: any[]) => Promise<string | undefined>
  stripTags: (filesData: any[]) => Promise<void>
  storeFilesToDb: (req: any, res: any, filesData: any[]) => Promise<any[]>
  sendUploadResponse: (req: any, res: any, stored: any[]) => Promise<any>
  delete: (req: any, res: any) => Promise<any>
  bulkDelete: (req: any, res: any) => Promise<any>
  list: (req: any, res: any) => Promise<any>
  get: (req: any, res: any) => Promise<any>
}

const self: UploadSelf = {
  onHold: new Set()
} as UploadSelf

const fileIdentifierLengthFallback = 32
const fileIdentifierLengthChangeable = !config.uploads.fileIdentifierLength.force &&
  typeof config.uploads.fileIdentifierLength.min === 'number' &&
  typeof config.uploads.fileIdentifierLength.max === 'number'

const maxSize = parseInt(config.uploads.maxSize)
const maxSizeBytes = maxSize * 1e6

const maxFilesPerUpload = 20

const busboyOptions: any = {
  defParamCharset: 'utf8',
  limits: {
    fileSize: maxSizeBytes,
    fields: 6,
    files: maxFilesPerUpload
  }
}

const urlMaxSize = parseInt(config.uploads.urlMaxSize)
const urlMaxSizeBytes = urlMaxSize * 1e6

const urlFetchTimeout = 10 * 1000

const chunkedUploads = config.uploads.chunkSize &&
  typeof config.uploads.chunkSize === 'object' &&
  config.uploads.chunkSize.default
const chunkedUploadsTimeout = config.uploads.chunkSize.timeout || 1800000
const chunksData: Record<string, any> = {}
const maxChunksCount = maxSize

const extensionsFilter = Array.isArray(config.extensionsFilter) &&
  config.extensionsFilter.length
const urlExtensionsFilter = Array.isArray(config.uploads.urlExtensionsFilter) &&
  config.uploads.urlExtensionsFilter.length

const enableHashing = config.uploads.hash === undefined
  ? true
  : Boolean(config.uploads.hash)

const queryDatabaseForIdentifierMatch = config.uploads.queryDatabaseForIdentifierMatch ||
  config.uploads.queryDbForFileCollisions

const uploadsPerPage = config.dashboard
  ? Math.max(Math.min(config.dashboard.uploadsPerPage || 0, 100), 1)
  : 25

class ChunksData {
  uuid: string
  root: string
  filename: string
  path: string
  chunks: number
  writeStream: any
  hashStream: any
  processing: boolean
  _timeout?: ReturnType<typeof setTimeout>

  constructor (uuid: string) {
    this.uuid = uuid
    this.root = path.join(paths.chunks, this.uuid)
    this.filename = 'tmp'
    this.path = path.join(this.root, this.filename)
    this.chunks = 0
    this.writeStream = null
    this.hashStream = null
    this.processing = true
  }

  onTimeout (): void {
    self.cleanUpChunks(this.uuid)
  }

  setTimeout (delay: number): void {
    this.clearTimeout()
    this._timeout = setTimeout(this.onTimeout.bind(this), delay)
  }

  clearTimeout (): void {
    if (this._timeout) {
      clearTimeout(this._timeout)
    }
  }
}

const initChunks = async (uuid: string): Promise<any> => {
  if (chunksData[uuid] === undefined) {
    chunksData[uuid] = new ChunksData(uuid)
    await jetpack.dirAsync(chunksData[uuid].root, { empty: true })

    chunksData[uuid].writeStream = jetpack.createWriteStream(chunksData[uuid].path, { flags: 'a' })
    chunksData[uuid].hashStream = enableHashing && blake3.createHash()
  } else if (chunksData[uuid].processing) {
    throw new ClientError('Previous chunk upload is still being processed. Parallel chunked uploads is not supported.')
  }

  chunksData[uuid].setTimeout(chunkedUploadsTimeout)
  return chunksData[uuid]
}

self.isExtensionFiltered = (extname: string): boolean => {
  if (!extname && config.filterNoExtension) return true

  if (extname && extensionsFilter) {
    const match = config.extensionsFilter.includes(extname.toLowerCase())
    const whitelist = config.extensionsFilterMode === 'whitelist'
    if ((!whitelist && match) || (whitelist && !match)) return true
  }

  return false
}

self.parseFileIdentifierLength = (fileLength: any): number => {
  if (!config.uploads.fileIdentifierLength) return fileIdentifierLengthFallback

  const parsed = parseInt(fileLength)
  if (isNaN(parsed) ||
    !fileIdentifierLengthChangeable ||
    parsed < config.uploads.fileIdentifierLength.min ||
    parsed > config.uploads.fileIdentifierLength.max) {
    return config.uploads.fileIdentifierLength.default || fileIdentifierLengthFallback
  } else {
    return parsed
  }
}

self.getUniqueUploadIdentifier = async (length: number, extension = '', res?: any): Promise<string> => {
  for (let i = 0; i < utils.idMaxTries; i++) {
    const identifier = randomstring.generate(length)

    if (queryDatabaseForIdentifierMatch) {
      if (self.onHold.has(identifier)) {
        logger.debug(`Identifier ${identifier} is currently held by another upload (${i + 1}/${utils.idMaxTries}).`)
        continue
      }

      self.onHold.add(identifier)

      const file = await utils.db.table('files')
        .whereRaw('?? like ?', ['name', `${identifier}.%`])
        .select('id')
        .first()
      if (file) {
        self.onHold.delete(identifier)
        logger.debug(`Identifier ${identifier} is already in use (${i + 1}/${utils.idMaxTries}).`)
        continue
      }

      if (res) {
        if (!res.locals.identifiers) {
          res.locals.identifiers = []
          res.once('finish', () => { self.unholdUploadIdentifiers(res) })
        }
        res.locals.identifiers.push(identifier)
      }
    } else {
      const name = identifier + extension
      const exists = jetpack.existsAsync(path.join(paths.uploads, name))
      if (exists) {
        logger.debug(`${name} is already in use (${i + 1}/${utils.idMaxTries}).`)
        continue
      }
    }

    return identifier
  }

  throw new ServerError('Failed to allocate a unique name for the upload. Try again?')
}

self.unholdUploadIdentifiers = (res: any): void => {
  if (!res.locals.identifiers) return

  for (const identifier of res.locals.identifiers) {
    self.onHold.delete(identifier)
  }

  delete res.locals.identifiers
}

self.assertRetentionPeriod = (user: any, age: any): number | null => {
  if (!utils.retentions.enabled) {
    return null
  }

  const group = user ? perms.group(user) : '_'
  if (!group || !utils.retentions.periods[group]) {
    throw new ClientError('You are not eligible for any file retention periods.', { statusCode: 403 })
  }

  let parsed = parseFloat(age)
  if (Number.isNaN(parsed) || age < 0) {
    parsed = utils.retentions.default[group]
  } else if (!utils.retentions.periods[group].includes(parsed)) {
    throw new ClientError('You are not eligible for the specified file retention period.', { statusCode: 403 })
  }

  if (!parsed && !utils.retentions.periods[group].includes(0)) {
    throw new ClientError('Permanent uploads are not permitted.', { statusCode: 403 })
  }

  return parsed
}

self.parseStripTags = (stripTags: any): boolean => {
  if (!config.uploads.stripTags) return false

  if (config.uploads.stripTags.force || stripTags === undefined) {
    return config.uploads.stripTags.default
  }

  return Boolean(parseInt(stripTags))
}

self.upload = async (req: any, res: any): Promise<any> => {
  let isMultipart = req.locals.nojs
  let isJson: boolean | undefined
  if (!req.locals.nojs) {
    isMultipart = req.is('multipart/form-data')
    isJson = req.is('application/json')
    if (!isMultipart && !isJson) {
      throw new ClientError('Request Content-Type must be either multipart/form-data or application/json.')
    }
  }

  if (config.privateUploadGroup) {
    if (!req.locals.user || !perms.is(req.locals.user, config.privateUploadGroup)) {
      throw new ClientError(config.privateUploadCustomResponse || 'Your usergroup is not permitted to upload new files.', { statusCode: 403 })
    }
  }

  let albumid = parseInt(req.headers.albumid || (req.path_parameters && req.path_parameters.albumid))
  if (isNaN(albumid)) albumid = null

  const age = self.assertRetentionPeriod(req.locals.user, req.headers.age)

  if (isMultipart) {
    return self.actuallyUpload(req, res, { albumid, age })
  } else {
    req.body = await req.json()
    return self.actuallyUploadUrls(req, res, { albumid, age })
  }
}

self.unfreezeChunksData = async (files: any[] = [], increase = false): Promise<void> => {
  for (const file of files) {
    if (!file.chunksData) return
    if (increase) file.chunksData.chunks++
    file.chunksData.processing = false
  }
}

self.cleanUpFiles = async (files: any[] = []): Promise<void> => {
  await Promise.all(files.map(async (file: any) => {
    if (file.chunksData) {
      return self.cleanUpChunks(file.chunksData.uuid).catch(logger.error)
    } else if (file.filename) {
      return utils.unlinkFile(file.filename).catch(logger.error)
    }
  }))
}

self.actuallyUpload = async (req: any, res: any, data: any = {}): Promise<any> => {
  req.body = {}
  req.files = []

  await req.multipart(busboyOptions, async (field: any) => {
    if (field.truncated) {
      let name = field.name
      if (name.startsWith('dz')) {
        name = name.replace(/^dz/, '')
      }

      req.body[name] = field.value || ''
      return
    }

    if (!field.file) return

    const file: any = {
      field: field.name,
      albumid: data.albumid,
      age: data.age,
      originalname: field.file.name || '',
      mimetype: field.mime_type || 'application/octet-stream'
    }
    req.files.push(file)

    file.extname = utils.extname(file.originalname)

    const isChunk = typeof req.body.uuid === 'string' && Boolean(req.body.uuid)
    if (isChunk) {
      const sanitizedUuid = String(req.body.uuid).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
      if (!sanitizedUuid) {
        throw new ClientError('Invalid UUID.')
      }
      const uuid = `${utils.pathSafeIp(req.ip)}_${sanitizedUuid}`
      file.chunksData = await initChunks(uuid)
      file.filename = file.chunksData.filename
      file.path = file.chunksData.path
    } else {
      const length = self.parseFileIdentifierLength(req.headers.filelength)
      const identifier = await self.getUniqueUploadIdentifier(length, file.extname, res)
      file.filename = identifier + file.extname
      file.path = path.join(paths.uploads, file.filename)
    }

    const readStream = field.file.stream
    let writeStream: any
    let hashStream: any
    let _reject: any

    await new Promise<void>((resolve, reject) => {
      _reject = reject

      if (file.chunksData) {
        writeStream = file.chunksData.writeStream
        hashStream = file.chunksData.hashStream
      } else {
        writeStream = jetpack.createWriteStream(file.path)
        hashStream = enableHashing && blake3.createHash()
      }

      readStream.once('error', _reject)

      writeStream.once('error', _reject)

      if (hashStream) {
        hashStream.once('error', _reject)

        readStream.on('data', (data: any) => {
          if (hashStream.hash?.hash) {
            hashStream.update(data)
          }
        })
      }

      if (file.chunksData) {
        readStream.once('end', () => resolve())
      } else {
        writeStream.once('finish', () => {
          file.size = writeStream.bytesWritten || 0
          if (hashStream?.hash?.hash) {
            const hash = hashStream.digest('hex')
            file.hash = file.size === 0 ? '' : hash
          }
          return resolve()
        })
      }

      readStream.pipe(writeStream, { end: !file.chunksData })
    }).catch((error: any) => {
      if (writeStream && !writeStream.destroyed) {
        writeStream.destroy()
      }
      if (hashStream?.hash?.hash) {
        hashStream.dispose()
      }

      throw error
    }).finally(() => {
      if (!file.chunksData) return
      utils.unlistenEmitters([writeStream, hashStream], 'error', _reject)
    })
  }).catch((error: any) => {
    self.cleanUpFiles(req.files)
    self.unfreezeChunksData(req.files)

    if (typeof error === 'string') {
      throw new ClientError(error)
    } else {
      throw error
    }
  })

  if (!req.files.length) {
    throw new ClientError('No files.')
  }

  try {
    for (const file of req.files) {
      if (file.field !== 'files[]') {
        throw new ClientError(`Unexpected file-type field: ${file.field}`)
      }

      if (self.isExtensionFiltered(file.extname)) {
        throw new ClientError(`${file.extname ? `${file.extname.substr(1).toUpperCase()} files` : 'Files with no extension'} are not permitted.`)
      }

      if (config.filterEmptyFile && file.size === 0) {
        throw new ClientError('Empty files are not allowed.')
      }
    }
  } catch (error) {
    self.cleanUpFiles(req.files)
    self.unfreezeChunksData(req.files)

    throw error
  }

  if (req.files.some((file: any) => file.chunksData)) {
    self.unfreezeChunksData(req.files, true)
    return res.json({ success: true })
  }

  if (req.locals.nojs) {
    await new Promise<void>((resolve, reject) => {
      auth.optionalUser(req, res, (error: any) => {
        if (error) return reject(error)
        return resolve()
      }, {
        token: req.body.token
      })
    })
  }

  const filesData = req.files

  if (ScannerManager.instance) {
    const scanResult = await self.scanFiles(req.locals.user, filesData)
    if (scanResult) {
      throw new ClientError(scanResult)
    }
  }

  if (self.parseStripTags(req.headers.striptags)) {
    await self.stripTags(filesData)
  }

  const stored = await self.storeFilesToDb(req, res, filesData)
  return self.sendUploadResponse(req, res, stored)
}

self.actuallyUploadUrls = async (req: any, res: any, data: any = {}): Promise<any> => {
  if (!config.uploads.urlMaxSize) {
    throw new ClientError('Upload by URLs is disabled at the moment.', { statusCode: 403 })
  }

  const urls = req.body.urls
  if (!Array.isArray(urls) || !urls.length || urls.some((url: string) => !/^https?:\/\//.test(url))) {
    throw new ClientError('Bad request.')
  }

  const isPrivateUrl = (urlStr: string): boolean => {
    try {
      const parsed = new URL(urlStr)
      const hostname = parsed.hostname
      const privatePatterns = [
        /^127\./,
        /^10\./,
        /^172\.(1[6-9]|2[0-9]|3[01])\./,
        /^192\.168\./,
        /^169\.254\./,
        /^0\./,
        /^\[::1\]$/,
        /^\[fc/,
        /^\[fd/,
        /^\[fe80/,
        /^localhost$/i,
        /^0x/,
        /^\d+$/
      ]
      return privatePatterns.some(pattern => pattern.test(hostname))
    } catch {
      return true
    }
  }

  for (const url of urls) {
    if (isPrivateUrl(url)) {
      throw new ClientError('Fetching internal/private URLs is not allowed.')
    }
  }

  if (urls.length > maxFilesPerUpload) {
    throw new ClientError(`Maximum ${maxFilesPerUpload} URLs at a time.`)
  }

  const assertSize = (size: number, isContentLength = false): void => {
    if (config.filterEmptyFile && size === 0) {
      throw new ClientError('Empty files are not allowed.')
    } else if (size > urlMaxSizeBytes) {
      if (isContentLength) {
        throw new ClientError(`File too large. Content-Length header reports file is bigger than ${urlMaxSize} MB.`)
      } else {
        throw new ClientError(`File too large. File is bigger than ${urlMaxSize} MB.`)
      }
    }
  }

  const filesData: any[] = []

  await Promise.all(urls.map(async (url: string) => {
    const file: any = {
      url,
      albumid: data.albumid,
      age: data.age
    }
    filesData.push(file)

    if (config.uploads.urlProxy) {
      url = config.uploads.urlProxy
        .replace(/{url}/g, encodeURIComponent(url))
        .replace(/{url-noprot}/g, encodeURIComponent(url.replace(/^https?:\/\//, '')))
    }

    const headStart = Date.now()
    try {
      const head = await utils.fetch(url, {
        method: 'HEAD',
        size: urlMaxSizeBytes,
        timeout: urlFetchTimeout
      })

      if (head.status === 200) {
        const contentLength = parseInt(head.headers.get('content-length'))
        if (!Number.isNaN(contentLength)) {
          assertSize(contentLength, true)
        }
      }
    } catch (ex: any) {
      if (ex instanceof ClientError) {
        throw ex
      }
    }

    const length = self.parseFileIdentifierLength(req.headers.filelength)
    const identifier = await self.getUniqueUploadIdentifier(length, '.tmp', res)

    file.filename = identifier + '.tmp'
    file.path = path.join(paths.uploads, file.filename)

    let writeStream: any
    let hashStream: any

    return Promise.resolve().then(async () => {
      writeStream = jetpack.createWriteStream(file.path)
      hashStream = enableHashing && blake3.createHash()

      const _timeout = urlFetchTimeout - (Date.now() - headStart)

      if (_timeout <= 0) {
        throw new ClientError('Fetch timed out. Try again?')
      }

      const fetchFile = await utils.fetch(url, {
        method: 'GET',
        size: urlMaxSizeBytes,
        timeout: _timeout
      })
        .then((res: any) => new Promise<any>((resolve, reject) => {
          if (res.status !== 200) {
            return resolve(res)
          }

          writeStream.once('error', reject)
          res.body.once('error', reject)

          if (hashStream) {
            hashStream.once('error', reject)
            res.body.pause()
            res.body.on('data', (d: any) => hashStream.update(d))
          }

          res.body.pipe(writeStream)
          writeStream.once('finish', () => resolve(res))
        }))
        .catch((ex: any) => {
          throw new ClientError(`${ex.code ? `${ex.code}: ` : ''}${ex.message}`)
        })

      if (fetchFile.status !== 200) {
        throw new ServerError(`${fetchFile.status} ${fetchFile.statusText}`)
      }

      assertSize(writeStream.bytesWritten)

      const contentDispositionHeader = fetchFile.headers.get('content-disposition')
      if (contentDispositionHeader) {
        const parsed = contentDisposition.parse(contentDispositionHeader)
        if (parsed && parsed.parameters) {
          file.originalname = parsed.parameters.filename
        }
      }

      if (!file.originalname) {
        file.originalname = path.basename(url).split(/[?#]/)[0]
      }

      file.extname = utils.extname(file.originalname)

      let filtered = false
      if (urlExtensionsFilter && ['blacklist', 'whitelist'].includes(config.uploads.urlExtensionsFilterMode)) {
        const match = config.uploads.urlExtensionsFilter.includes(file.extname.toLowerCase())
        const whitelist = config.uploads.urlExtensionsFilterMode === 'whitelist'
        filtered = ((!whitelist && match) || (whitelist && !match))
      } else {
        filtered = self.isExtensionFiltered(file.extname)
      }

      if (filtered) {
        throw new ClientError(`${file.extname ? `${file.extname.substr(1).toUpperCase()} files` : 'Files with no extension'} are not permitted.`)
      }

      const _identifier = queryDatabaseForIdentifierMatch
        ? identifier
        : await self.getUniqueUploadIdentifier(length, file.extname, res)
      const _name = _identifier + file.extname

      await jetpack.renameAsync(file.path, _name)

      file.filename = _name
      file.path = path.join(paths.uploads, _name)

      const contentType = fetchFile.headers.get('content-type')
      file.mimetype = (contentType && contentType.split(';')[0]) || 'application/octet-stream'
      file.size = writeStream.bytesWritten
      file.hash = hashStream
        ? hashStream.digest('hex')
        : null
    }).catch((err: any) => {
      if (writeStream && !writeStream.destroyed) {
        writeStream.destroy()
      }
      if (hashStream?.hash?.hash) {
        hashStream.dispose()
      }

      throw err
    })
  })).catch(async (error: any) => {
    if (filesData.length) {
      Promise.all(filesData.map(async (file: any) => {
        if (!file.filename) return
        return utils.unlinkFile(file.filename).catch(logger.error)
      }))
    }

    throw error
  })

  if (ScannerManager.instance) {
    const scanResult = await self.scanFiles(req.locals.user, filesData)
    if (scanResult) {
      throw new ClientError(scanResult)
    }
  }

  const stored = await self.storeFilesToDb(req, res, filesData)
  return self.sendUploadResponse(req, res, stored)
}

self.finishChunks = async (req: any, res: any): Promise<any> => {
  if (!chunkedUploads) {
    throw new ClientError('Chunked upload is disabled.', { statusCode: 403 })
  }

  const files = req.body.files
  if (!Array.isArray(files) || !files.length || files.some((file: any) => {
    return typeof file !== 'object' || !file.uuid
  })) {
    throw new ClientError('Bad request.')
  }

  files.forEach((file: any) => {
    file.uuid = `${utils.pathSafeIp(req.ip)}_${file.uuid}`
    file.chunksData = chunksData[file.uuid]
  })

  if (files.some((file: any) => !file.chunksData || file.chunksData.processing)) {
    throw new ClientError('Invalid file UUID, chunks data had already timed out, or is still processing. Try again?')
  }

  return self.actuallyFinishChunks(req, res, files)
    .catch((error: any) => {
      Promise.all(files.map(async (file: any) => {
        return self.cleanUpChunks(file.uuid).catch(logger.error)
      }))
      throw error
    })
}

self.actuallyFinishChunks = async (req: any, res: any, files: any[]): Promise<any> => {
  const filesData: any[] = []
  await Promise.all(files.map(async (file: any) => {
    chunksData[file.uuid].clearTimeout()

    chunksData[file.uuid].writeStream.end()
    const bytesWritten = chunksData[file.uuid].writeStream.bytesWritten
    const hash = chunksData[file.uuid].hashStream
      ? chunksData[file.uuid].hashStream.digest('hex')
      : null

    if (chunksData[file.uuid].chunks < 2 || chunksData[file.uuid].chunks > maxChunksCount) {
      throw new ClientError('Invalid chunks count.')
    }

    const extname = typeof file.original === 'string' ? utils.extname(file.original) : ''
    if (self.isExtensionFiltered(extname)) {
      throw new ClientError(`${extname ? `${extname.substr(1).toUpperCase()} files` : 'Files with no extension'} are not permitted.`)
    }

    const age = self.assertRetentionPeriod(req.locals.user, file.age)

    let size = typeof file.size === 'number' ? file.size : undefined
    if (size === undefined) {
      size = bytesWritten
    } else if (size !== bytesWritten) {
      throw new ClientError(`Written bytes (${bytesWritten}) does not match actual size reported by client (${size}).`)
    }

    if (config.filterEmptyFile && size === 0) {
      throw new ClientError('Empty files are not allowed.')
    } else if (size > maxSizeBytes) {
      throw new ClientError(`File too large. Chunks are bigger than ${maxSize} MB.`)
    }

    const tmpfile = path.join(chunksData[file.uuid].root, chunksData[file.uuid].filename)

    const stat = await jetpack.inspectAsync(tmpfile)
    if (stat.size !== size) {
      throw new ClientError(`Resulting physical file size (${stat.size}) does not match expected size (${size}).`)
    }

    const length = self.parseFileIdentifierLength(file.filelength)
    const identifier = await self.getUniqueUploadIdentifier(length, extname, res)
    const name = identifier + extname

    const destination = path.join(paths.uploads, name)
    await jetpack.moveAsync(tmpfile, destination)

    await self.cleanUpChunks(file.uuid).catch(logger.error)

    let albumid = parseInt(file.albumid)
    if (isNaN(albumid)) {
      albumid = null
    }

    filesData.push({
      filename: name,
      originalname: file.original || '',
      extname,
      mimetype: file.type || 'application/octet-stream',
      path: destination,
      size,
      hash,
      albumid,
      age
    })
  }))

  if (ScannerManager.instance) {
    const scanResult = await self.scanFiles(req.locals.user, filesData)
    if (scanResult) {
      throw new ClientError(scanResult)
    }
  }

  if (self.parseStripTags(req.headers.striptags)) {
    await self.stripTags(filesData)
  }

  const stored = await self.storeFilesToDb(req, res, filesData)
  return self.sendUploadResponse(req, res, stored)
}

self.cleanUpChunks = async (uuid: string): Promise<void> => {
  if (!uuid || !chunksData[uuid]) return

  if (chunksData[uuid].writeStream && !chunksData[uuid].writeStream.destroyed) {
    chunksData[uuid].writeStream.destroy()
  }
  if (chunksData[uuid].hashStream?.hash?.hash) {
    chunksData[uuid].hashStream.dispose()
  }

  await jetpack.removeAsync(chunksData[uuid].root)

  delete chunksData[uuid]
}

self.assertScanUserBypass = (user: any, filenames: string | string[]): boolean => {
  if (!user || !ScannerManager.groupBypass) {
    return false
  }

  if (!Array.isArray(filenames)) {
    filenames = [filenames]
  }

  logger.debug(`[ClamAV]: ${filenames.join(', ')}: Skipped, uploaded by ${user.username} (${ScannerManager.groupBypass})`)
  return perms.is(user, ScannerManager.groupBypass)
}

self.assertScanFileBypass = (data: any): boolean => {
  if (typeof data !== 'object' || !data.filename) {
    return false
  }

  const extname = data.extname || utils.extname(data.filename)
  if (ScannerManager.whitelistExtensions && ScannerManager.whitelistExtensions.includes(extname)) {
    logger.debug(`[ClamAV]: ${data.filename}: Skipped, extension whitelisted`)
    return true
  }

  if (ScannerManager.maxSize && data.size !== undefined && data.size > ScannerManager.maxSize) {
    logger.debug(`[ClamAV]: ${data.filename}: Skipped, size ${data.size} > ${ScannerManager.maxSize}`)
    return true
  }

  return false
}

self.scanFiles = async (user: any, filesData: any[]): Promise<string | undefined> => {
  const filenames = filesData.map(file => file.filename)
  if (self.assertScanUserBypass(user, filenames)) {
    return undefined
  }

  const foundThreats: string[] = []
  const unableToScan: string[] = []
  const result = await Promise.all(filesData.map(async (file: any) => {
    if (self.assertScanFileBypass(file)) return

    logger.debug(`[ClamAV]: ${file.filename}: Scanning\u2026`)
    const response = await ScannerManager.instance.isInfected(file.path)
    if (response.isInfected) {
      logger.log(`[ClamAV]: ${file.filename}: ${response.viruses.join(', ')}`)
      foundThreats.push(...response.viruses)
    } else if (response.isInfected === null) {
      logger.log(`[ClamAV]: ${file.filename}: Unable to scan`)
      unableToScan.push(file.filename)
    } else {
      logger.debug(`[ClamAV]: ${file.filename}: File is clean`)
    }
  })).then(() => {
    if (foundThreats.length) {
      const more = foundThreats.length > 1
      return `Threat${more ? 's' : ''} detected: ${foundThreats[0]}${more ? ', and more' : ''}.`
    } else if (unableToScan.length) {
      const more = unableToScan.length > 1
      return `Unable to scan: ${unableToScan[0]}${more ? ', and more' : ''}.`
    }
  }).catch((error: any) => {
    logger.error(`[ClamAV]: ${filenames.join(', ')}: ${error.toString()}`)
    return 'An unexpected error occurred with ClamAV, please contact the site owner.'
  })

  if (result) {
    Promise.all(filesData.map(async (file: any) =>
      utils.unlinkFile(file.filename).catch(logger.error)
    ))
  }

  return result
}

self.stripTags = async (filesData: any[]): Promise<void> => {
  try {
    await Promise.all(filesData.map(async (file: any) => {
      const stat = await utils.stripTags(file.filename, file.extname)
      if (stat) {
        file.size = stat.size
      }
    }))
  } catch (error) {
    Promise.all(filesData.map(async (file: any) =>
      utils.unlinkFile(file.filename).catch(logger.error)
    ))

    throw error
  }
}

self.storeFilesToDb = async (req: any, res: any, filesData: any[]): Promise<any[]> => {
  const stored: any[] = []
  const albumids: any[] = []

  for (const file of filesData) {
    if (enableHashing) {
      const dbFile = await utils.db.table('files')
        .where(function (this: any) {
          if (req.locals.user) {
            this.where('userid', req.locals.user.id)
          } else {
            this.whereNull('userid')
          }
        })
        .where({
          hash: file.hash,
          size: String(file.size)
        })
        .first()

      if (dbFile) {
        await utils.unlinkFile(file.filename).catch(logger.error)
        logger.debug(`Unlinked ${file.filename} since a duplicate named ${dbFile.name} exists`)

        if (req.path === '/nojs') {
          dbFile.original = file.originalname
        }

        stored.push({
          file: dbFile,
          repeated: true
        })
        continue
      }
    }

    const timestamp = Math.floor(Date.now() / 1000)
    const data: any = {
      name: file.filename,
      original: file.originalname,
      type: file.mimetype,
      size: String(file.size),
      hash: file.hash,
      ip: config.uploads.storeIP !== false ? req.ip : null,
      timestamp
    }

    if (req.locals.user) {
      data.userid = req.locals.user.id
      data.albumid = file.albumid
      if (data.albumid !== null && !albumids.includes(data.albumid)) {
        albumids.push(data.albumid)
      }
    }

    if (file.age) {
      data.expirydate = data.timestamp + (file.age * 3600)
    }

    stored.push({ file: data })

    if (utils.mayGenerateThumb(file.extname)) {
      utils.generateThumbs(file.filename, file.extname, true).catch(logger.error)
    }
  }

  const fresh = stored.filter(entry => !entry.repeated)
  if (fresh.length) {
    let authorizedIds: any[] = []
    if (albumids.length) {
      authorizedIds = await utils.db.table('albums')
        .where({ userid: req.locals.user.id })
        .whereIn('id', albumids)
        .select('id')
        .then((rows: any[]) => rows.map((row: any) => row.id))

      for (const entry of fresh) {
        if (entry.file.albumid !== null && !authorizedIds.includes(entry.file.albumid)) {
          entry.file.albumid = null
        }
      }
    }

    await utils.db.transaction(async (trx: any) => {
      await trx('files')
        .insert(fresh.map(entry => entry.file))
      utils.invalidateStatsCache('uploads')

      if (authorizedIds.length) {
        await trx('albums')
          .whereIn('id', authorizedIds)
          .update('editedAt', Math.floor(Date.now() / 1000))
        utils.deleteStoredAlbumRenders(authorizedIds)
      }
    })
  }

  return stored
}

self.sendUploadResponse = async (req: any, res: any, stored: any[]): Promise<any> => {
  return res.json({
    success: true,
    files: stored.map((entry: any) => {
      const map: any = {
        name: entry.file.name,
        original: entry.file.original,
        url: `${config.domain ? `${config.domain}/` : ''}${entry.file.name}`,
        hash: entry.file.hash,
        size: Number(entry.file.size)
      }

      if (entry.file.expirydate) {
        map.expirydate = entry.file.expirydate
      }

      if (req.path === '/nojs') {
        map.original = entry.file.original
      }

      if (req.locals.user) {
        map.deleteUrl = `${config.homeDomain || ''}/file/${entry.file.name}?delete`
      }

      if (entry.repeated) {
        map.repeated = true
      }

      return map
    })
  })
}

self.delete = async (req: any, res: any): Promise<any> => {
  const id = parseInt(req.body.id)
  req.body = {
    _legacy: true,
    field: 'id',
    values: isNaN(id) ? undefined : [id]
  }

  return self.bulkDelete(req, res)
}

self.bulkDelete = async (req: any, res: any): Promise<any> => {
  const field = req.body.field || 'id'
  const values = req.body.values

  if (!Array.isArray(values) || !values.length) {
    throw new ClientError('No array of files specified.')
  }

  const failed = await utils.bulkDeleteFromDb(field, values, req.locals.user)

  return res.json({ success: true, failed })
}

self.list = async (req: any, res: any): Promise<any> => {
  const all = req.headers.all === '1'
  const filters = req.headers.filters
  const minoffset = Number(req.headers.minoffset) || 0
  const ismoderator = perms.is(req.locals.user, 'moderator')
  if (all && !ismoderator) {
    return res.status(403).end()
  }

  const albumid = req.path_parameters && Number(req.path_parameters.albumid)
  const basedomain = config.domain

  const MAX_WILDCARDS_IN_KEY: number = 2
  const MAX_TEXT_QUERIES: number = 3
  const MAX_SORT_KEYS: number = 2
  const MAX_IS_KEYS: number = 1

  let timezoneOffset = 0
  if (minoffset !== undefined) {
    timezoneOffset = 60000 * (utils.timezoneOffset - minoffset)
  }

  const filterObj: any = {
    uploaders: [],
    excludeUploaders: [],
    queries: {
      exclude: {}
    },
    typeIs: {
      image: Constants.IMAGE_EXTS,
      video: Constants.VIDEO_EXTS,
      audio: Constants.AUDIO_EXTS
    },
    flags: {}
  }
  const typeIsKeys = Object.keys(filterObj.typeIs)

  const sortObj: any = {
    casts: {
      size: 'integer'
    },
    maps: {
      date: 'timestamp',
      expiry: 'expirydate',
      originalname: 'original'
    },
    nullsLast: [
      'userid',
      'type',
      'albumid',
      'expirydate',
      'ip'
    ],
    parsed: []
  }

  function sqlLikeParser (pattern: string): { count: number; escaped: string } {
    const escaped = pattern
      .replace(/(?<!\\)%/g, '\\%')
      .replace(/(?<!\\)_/g, '\\_')

    const match = pattern.match(/(?<!\\)(\*|\?)/g)
    if (match && match.length) {
      return {
        count: match.length,
        escaped: escaped
          .replace(/(?<!\\)\*/g, '%')
          .replace(/(?<!\\)\?/g, '_')
      }
    } else {
      return {
        count: 0,
        escaped: `%${escaped}%`
      }
    }
  }

  if (filters) {
    const keywords = ['type']

    if (isNaN(albumid)) {
      keywords.push('albumid')
    }

    if (all) {
      keywords.push('ip', 'user')
    }

    const ranges = [
      'date',
      'expiry'
    ]

    keywords.push('is', 'sort', 'orderby')
    filterObj.queries = searchQuery.parse(filters, {
      keywords,
      ranges,
      tokenize: true,
      alwaysArray: true,
      offsets: false
    })

    if (filterObj.queries.orderby) {
      if (!filterObj.queries.sort) filterObj.queries.sort = []
      filterObj.queries.sort.push(...filterObj.queries.orderby)
      delete filterObj.queries.orderby
    }

    if (typeof filterObj.queries.exclude.text === 'string') {
      filterObj.queries.exclude.text = [filterObj.queries.exclude.text]
    }

    let textQueries = 0
    if (filterObj.queries.text) textQueries += filterObj.queries.text.length
    if (filterObj.queries.exclude.text) textQueries += filterObj.queries.exclude.text.length

    if (!ismoderator && textQueries > MAX_TEXT_QUERIES) {
      throw new ClientError(`Users are only allowed to use ${MAX_TEXT_QUERIES} non-keyed keyword${MAX_TEXT_QUERIES === 1 ? '' : 's'} at a time.`)
    }

    if (filterObj.queries.text) {
      for (let i = 0; i < filterObj.queries.text.length; i++) {
        const result = sqlLikeParser(filterObj.queries.text[i])
        if (!ismoderator && result.count > MAX_WILDCARDS_IN_KEY) {
          throw new ClientError(`Users are only allowed to use ${MAX_WILDCARDS_IN_KEY} wildcard${MAX_WILDCARDS_IN_KEY === 1 ? '' : 's'} per key.`)
        }
        filterObj.queries.text[i] = result.escaped
      }
    }

    if (filterObj.queries.exclude.text) {
      for (let i = 0; i < filterObj.queries.exclude.text.length; i++) {
        const result = sqlLikeParser(filterObj.queries.exclude.text[i])
        if (!ismoderator && result.count > MAX_WILDCARDS_IN_KEY) {
          throw new ClientError(`Users are only allowed to use ${MAX_WILDCARDS_IN_KEY} wildcard${MAX_WILDCARDS_IN_KEY === 1 ? '' : 's'} per key.`)
        }
        filterObj.queries.exclude.text[i] = result.escaped
      }
    }

    for (const key of keywords) {
      let queryIndex = -1
      let excludeIndex = -1

      if (filterObj.queries[key]) {
        filterObj.queries[key] = filterObj.queries[key].filter((v: any, i: number, a: any[]) => a.indexOf(v) === i)
        queryIndex = filterObj.queries[key].indexOf('-')
      }
      if (filterObj.queries.exclude[key]) {
        filterObj.queries.exclude[key] = filterObj.queries.exclude[key].filter((v: any, i: number, a: any[]) => a.indexOf(v) === i)
        excludeIndex = filterObj.queries.exclude[key].indexOf('-')
      }

      const inQuery = queryIndex !== -1
      const inExclude = excludeIndex !== -1
      if (inQuery || inExclude) {
        filterObj.flags[`${key}Null`] = inExclude ? false : inQuery
        if (inQuery) {
          if (filterObj.queries[key].length === 1) {
            delete filterObj.queries[key]
          } else {
            filterObj.queries[key].splice(queryIndex, 1)
          }
        }
        if (inExclude) {
          if (filterObj.queries.exclude[key].length === 1) {
            delete filterObj.queries.exclude[key]
          } else {
            filterObj.queries.exclude[key].splice(excludeIndex, 1)
          }
        }
      }
    }

    const parseDate = (date: string, resetMs?: boolean): Date | null => {
      const formattedMatch = date.match(/^(\d{4})?(\/\d{2})?(\/\d{2})?\s?(\d{2})?(:\d{2})?(:\d{2})?$/)
      if (formattedMatch) {
        const dateObj = new Date(Date.now() + timezoneOffset)

        if (formattedMatch[1] !== undefined) {
          dateObj.setFullYear(Number(formattedMatch[1]),
            formattedMatch[2] !== undefined ? (Number(formattedMatch[2].slice(1)) - 1) : 0,
            formattedMatch[3] !== undefined ? Number(formattedMatch[3].slice(1)) : 1)
        }

        if (formattedMatch[4] !== undefined) {
          dateObj.setHours(Number(formattedMatch[4]),
            formattedMatch[5] !== undefined ? Number(formattedMatch[5].slice(1)) : 0,
            formattedMatch[6] !== undefined ? Number(formattedMatch[6].slice(1)) : 0)
        }

        if (resetMs) {
          dateObj.setMilliseconds(0)
        }

        return new Date(dateObj.getTime() - timezoneOffset)
      } else if (/^\d+$/.test(date)) {
        return new Date(parseInt(date) * 1000)
      }
      return null
    }

    const parseRelativeDuration = (operator: string, duration: string, resetMs?: boolean, inverse = false): { from: number | null; to: number | null } | null => {
      let milliseconds = parseDuration(duration)
      if (isNaN(milliseconds) || typeof milliseconds !== 'number') {
        return null
      }

      let from = operator === '<'
      if (inverse) {
        from = !from
        milliseconds = -milliseconds
      }

      const dateObj = new Date(Date.now() + timezoneOffset - milliseconds)
      if (resetMs) {
        dateObj.setMilliseconds(0)
      }

      const range: { from: number | null; to: number | null } = { from: null, to: null }
      const offsetDateObj = new Date(dateObj.getTime() - timezoneOffset)
      if (from) {
        range.from = Math.floor(offsetDateObj.getTime() / 1000)
      } else {
        range.to = Math.ceil(offsetDateObj.getTime() / 1000)
      }
      return range
    }

    for (const range of ranges) {
      if (filterObj.queries[range]) {
        if (filterObj.queries[range].from) {
          const relativeMatch = filterObj.queries[range].from.match(/^(<|>)(.*)$/)
          if (relativeMatch && relativeMatch[2]) {
            filterObj.queries[range] = parseRelativeDuration(relativeMatch[1], relativeMatch[2], true, (range === 'expiry'))
            continue
          } else {
            const parsed = parseDate(filterObj.queries[range].from, true)
            filterObj.queries[range].from = parsed ? Math.floor(parsed.getTime() / 1000) : null
          }
        }
        if (filterObj.queries[range].to) {
          const parsed = parseDate(filterObj.queries[range].to, true)
          filterObj.queries[range].to = parsed ? Math.ceil(parsed.getTime() / 1000) : null
        }
      }
    }

    if (filterObj.queries.user || filterObj.queries.exclude.user) {
      const usernames: string[] = []
      if (filterObj.queries.user) {
        usernames.push(...filterObj.queries.user)
      }
      if (filterObj.queries.exclude.user) {
        usernames.push(...filterObj.queries.exclude.user)
      }

      const uploaders = await utils.db.table('users')
        .whereIn('username', usernames)
        .select('id', 'username')

      if (!uploaders || (uploaders.length !== usernames.length)) {
        const notFound = usernames.filter((username: string) => {
          return !uploaders.find((uploader: any) => uploader.username === username)
        })
        if (notFound) {
          throw new ClientError(`User${notFound.length === 1 ? '' : 's'} not found: ${notFound.join(', ')}.`)
        }
      }

      for (const uploader of uploaders) {
        if (filterObj.queries.user && filterObj.queries.user.includes(uploader.username)) {
          filterObj.uploaders.push(uploader)
        } else {
          filterObj.excludeUploaders.push(uploader)
        }
      }

      delete filterObj.queries.user
      delete filterObj.queries.exclude.user
    }

    if (filterObj.queries.sort) {
      const allowed = [
        'expirydate',
        'id',
        'name',
        'original',
        'size',
        'timestamp'
      ]

      if (isNaN(albumid)) {
        allowed.push('albumid')
      }

      if (all) {
        allowed.push('ip', 'userid')
      }

      for (const obQuery of filterObj.queries.sort) {
        const tmp = obQuery.toLowerCase().split(':')
        const column = sortObj.maps[tmp[0]] || tmp[0]

        if (!allowed.includes(column)) {
          throw new ClientError(`Column "${column}" cannot be used for sorting.\n\nTry the following instead:\n${allowed.join(', ')}`)
        }

        sortObj.parsed.push({
          column,
          order: (tmp[1] && /^d/i.test(tmp[1])) ? 'desc' : 'asc',
          clause: sortObj.nullsLast.includes(column) ? 'nulls last' : '',
          cast: sortObj.casts[column] || null
        })
      }

      if (!ismoderator && sortObj.parsed.length > MAX_SORT_KEYS) {
        throw new ClientError(`Users are only allowed to use ${MAX_SORT_KEYS} sort key${MAX_SORT_KEYS === 1 ? '' : 's'} at a time.`)
      }

      delete filterObj.queries.sort
    }

    if (filterObj.queries.is || filterObj.queries.exclude.is) {
      const types: string[] = []

      if (filterObj.queries.is) {
        filterObj.queries.is = filterObj.queries.is.map((type: string) => type.toLowerCase())
        types.push(...filterObj.queries.is)
      }
      if (filterObj.queries.exclude.is) {
        filterObj.queries.exclude.is = filterObj.queries.exclude.is.map((type: string) => type.toLowerCase())
        types.push(...filterObj.queries.exclude.is)
      }

      let isKeys = 0
      let isLast: boolean | undefined

      for (const type of types) {
        if (!typeIsKeys.includes(type)) {
          throw new ClientError(`Found invalid type-is key: ${type}.`)
        }

        if (filterObj.queries.is && filterObj.queries.is.includes(type)) {
          filterObj.flags[`is${type}`] = true
        } else {
          filterObj.flags[`is${type}`] = false
        }

        isKeys++

        if (isLast === undefined) {
          isLast = filterObj.flags[`is${type}`]
        } else if (filterObj.flags[`is${type}`] !== isLast) {
          throw new ClientError('Cannot mix inclusion and exclusion type-is keys.')
        }
      }

      if (!ismoderator && isKeys > MAX_IS_KEYS) {
        throw new ClientError(`Users are only allowed to use ${MAX_IS_KEYS} type-is key${MAX_IS_KEYS === 1 ? '' : 's'} at a time.`)
      }

      delete filterObj.queries.is
      delete filterObj.queries.exclude.is
    }
  }

  function filter (this: any): void {
    if (all) {
      this.where(function (this: any) {
        this.orWhere(function (this: any) {
          if (filterObj.excludeUploaders.length) {
            this.whereNotIn('userid', filterObj.excludeUploaders.map((v: any) => v.id))
          } else if (filterObj.uploaders.length) {
            this.orWhereIn('userid', filterObj.uploaders.map((v: any) => v.id))
          }
          if ((filterObj.excludeUploaders.length && filterObj.flags.userNull !== false) ||
            (filterObj.uploaders.length && filterObj.flags.userNull) ||
            (!filterObj.excludeUploaders.length && !filterObj.uploaders.length && filterObj.flags.userNull)) {
            this.orWhereNull('userid')
          } else if (filterObj.flags.userNull === false) {
            this.whereNotNull('userid')
          }
        })

        this.orWhere(function (this: any) {
          if (filterObj.queries.exclude.ip) {
            this.whereNotIn('ip', filterObj.queries.exclude.ip)
          } else if (filterObj.queries.ip) {
            this.orWhereIn('ip', filterObj.queries.ip)
          }
          if ((filterObj.queries.exclude.ip && filterObj.flags.ipNull !== false) ||
            (filterObj.queries.ip && filterObj.flags.ipNull) ||
            (!filterObj.queries.exclude.ip && !filterObj.queries.ip && filterObj.flags.ipNull)) {
            this.orWhereNull('ip')
          } else if (filterObj.flags.ipNull === false) {
            this.whereNotNull('ip')
          }
        })
      })
    } else {
      this.where('userid', req.locals.user.id)
    }

    if (isNaN(albumid)) {
      this.andWhere(function (this: any) {
        if (filterObj.queries.exclude.albumid) {
          this.whereNotIn('albumid', filterObj.queries.exclude.albumid)
        } else if (filterObj.queries.albumid) {
          this.orWhereIn('albumid', filterObj.queries.albumid)
        }
        if ((filterObj.queries.exclude.albumid && filterObj.flags.albumidNull !== false) ||
          (filterObj.queries.albumid && filterObj.flags.albumidNull) ||
          (!filterObj.queries.exclude.albumid && !filterObj.queries.albumid && filterObj.flags.albumidNull)) {
          this.orWhereNull('albumid')
        } else if (filterObj.flags.albumidNull === false) {
          this.whereNotNull('albumid')
        }
      })
    } else if (!all) {
      this.andWhere('albumid', req.path_parameters.albumid)
    }

    this.andWhere(function (this: any) {
      if (!filterObj.queries.date ||
        (!filterObj.queries.date.from && !filterObj.queries.date.to)) {
        return
      }
      if (typeof filterObj.queries.date.from === 'number') {
        if (typeof filterObj.queries.date.to === 'number') {
          this.andWhereBetween('timestamp', [filterObj.queries.date.from, filterObj.queries.date.to])
        } else {
          this.andWhere('timestamp', '>=', filterObj.queries.date.from)
        }
      } else {
        this.andWhere('timestamp', '<=', filterObj.queries.date.to)
      }
    })

    this.andWhere(function (this: any) {
      if (!filterObj.queries.expiry ||
        (!filterObj.queries.expiry.from && !filterObj.queries.expiry.to)) {
        return
      }
      if (typeof filterObj.queries.expiry.from === 'number') {
        if (typeof filterObj.queries.expiry.to === 'number') {
          this.andWhereBetween('expirydate', [filterObj.queries.expiry.from, filterObj.queries.expiry.to])
        } else {
          this.andWhere('expirydate', '>=', filterObj.queries.expiry.from)
        }
      } else {
        this.andWhere('expirydate', '<=', filterObj.queries.expiry.to)
      }
    })

    this.andWhere(function (this: any) {
      for (const type of typeIsKeys) {
        let func: string | undefined
        let operator: string | undefined
        if (filterObj.flags[`is${type}`] === true) {
          func = 'orWhere'
          operator = 'like'
        } else if (filterObj.flags[`is${type}`] === false) {
          func = 'andWhere'
          operator = 'not like'
        }

        if (func) {
          for (const pattern of filterObj.typeIs[type].map((ext: string) => `%${ext}`)) {
            this[func]('name', operator, pattern)
          }
        }
      }
    })

    this.andWhere(function (this: any) {
      if (filterObj.queries.exclude.type) {
        this.whereNotIn('type', filterObj.queries.exclude.type)
      } else if (filterObj.queries.type) {
        this.orWhereIn('type', filterObj.queries.type)
      }
      if ((filterObj.queries.exclude.type && filterObj.flags.typeNull !== false) ||
          (filterObj.queries.type && filterObj.flags.typeNull) ||
          (!filterObj.queries.exclude.type && !filterObj.queries.type && filterObj.flags.typeNull)) {
        this.orWhereNull('type')
      } else if (filterObj.flags.typeNull === false) {
        this.whereNotNull('type')
      }
    })

    this.andWhere(function (this: any) {
      if (!filterObj.queries.text) return
      for (const pattern of filterObj.queries.text) {
        this.orWhereRaw('?? like ? escape ?', ['name', pattern, '\\'])
        this.orWhereRaw('?? like ? escape ?', ['original', pattern, '\\'])
      }
    })

    this.andWhere(function (this: any) {
      if (!filterObj.queries.exclude.text) return
      for (const pattern of filterObj.queries.exclude.text) {
        this.andWhereRaw('?? not like ? escape ?', ['name', pattern, '\\'])
        this.andWhereRaw('?? not like ? escape ?', ['original', pattern, '\\'])
      }
    })
  }

  const result: any = { success: true, files: [], uploadsPerPage, count: 0, basedomain }

  result.count = await utils.db.table('files')
    .where(filter)
    .count('id as count')
    .then((rows: any[]) => rows[0].count)
  if (!result.count) {
    return res.json(result)
  }

  let offset = req.path_parameters && Number(req.path_parameters.page)
  if (isNaN(offset)) {
    offset = 0
  } else if (offset < 0) {
    offset = Math.max(0, Math.ceil(result.count / uploadsPerPage) + offset)
  }

  const columns = ['id', 'name', 'original', 'userid', 'size', 'timestamp']

  if (utils.retentions.enabled) {
    columns.push('expirydate')
  }

  const filterByAlbums = filterObj.queries.albumid ||
    filterObj.queries.exclude.albumid ||
    filterObj.flags.albumidNull !== undefined

  if (!all || filterByAlbums) {
    columns.push('albumid')
  }

  if (all) {
    columns.push('ip')
  }

  let orderByRaw: string
  if (sortObj.parsed.length) {
    orderByRaw = sortObj.parsed.map((sort: any) => {
      if (sort.cast) {
        return utils.db.raw(`cast (?? as ${sort.cast}) ${sort.order} ${sort.clause}`.trim(), sort.column)
      } else {
        return utils.db.raw(`?? ${sort.order} ${sort.clause}`.trim(), sort.column)
      }
    }).join(', ')
  } else {
    orderByRaw = '`id` desc'
  }

  result.files = await utils.db.table('files')
    .where(filter)
    .orderByRaw(orderByRaw)
    .limit(uploadsPerPage)
    .offset(uploadsPerPage * offset)
    .select(columns)

  if (!result.files.length) {
    return res.json(result)
  }

  for (const file of result.files) {
    file.extname = utils.extname(file.name)
    if (utils.mayGenerateThumb(file.extname)) {
      let thumbext = '.png'
      if (utils.isAnimatedThumb(file.extname)) thumbext = '.gif'
      file.thumb = `thumbs/${file.name.slice(0, -file.extname.length)}${thumbext}`
    }
  }

  result.albums = {}

  if (!all || filterByAlbums) {
    const albumids = result.files
      .map((file: any) => file.albumid)
      .filter(utils.filterUniquifySqlArray)

    result.albums = await utils.db.table('albums')
      .where(function (this: any) {
        this.whereIn('id', albumids)

        if (!all) {
          this.andWhere('enabled', 1)
        }
      })
      .select('id', 'name', 'enabled')
      .then((rows: any[]) => {
        const obj: Record<number, string> = {}
        for (const row of rows) {
          obj[row.id] = row.name
        }
        return obj
      })
  }

  if (!all) {
    return res.json(result)
  }

  let usersTable = filterObj.uploaders
  if (!usersTable.length) {
    const userids = result.files
      .map((file: any) => file.userid)
      .filter(utils.filterUniquifySqlArray)

    if (!userids.length) {
      return res.json(result)
    }

    usersTable = await utils.db.table('users')
      .whereIn('id', userids)
      .select('id', 'username')
  }

  result.users = {}

  for (const user of usersTable) {
    result.users[user.id] = user.username
  }

  return res.json(result)
}

self.get = async (req: any, res: any): Promise<any> => {
  const ismoderator = perms.is(req.locals.user, 'moderator')

  const identifier = req.path_parameters && req.path_parameters.identifier
  if (identifier === undefined) {
    throw new ClientError('No identifier provided.')
  }

  const file = await utils.db.table('files')
    .where('name', identifier)
    .where(function (this: any) {
      if (!ismoderator) {
        this.where('userid', req.locals.user.id)
      }
    })
    .first()

  if (!file) {
    throw new ClientError('File not found.', { statusCode: 404 })
  }

  return res.json({ success: true, file })
}

export = self
