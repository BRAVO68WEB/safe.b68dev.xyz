const contentDisposition = require('content-disposition')
const etag = require('etag')
const fsPromises = require('fs/promises')
const jetpack = require('fs-jetpack')
const SimpleDataStore = require('./../utils/SimpleDataStore')
const errors = require('./../errorsController')
const utils = require('./../utilsController')
const serveUtils = require('./../utils/serveUtils')
const logger = require('./../../logger')

class ServeStatic {
  directory: string
  contentDispositionStore: any
  contentTypesMaps: Map<string, string> | undefined

  #options: any

  constructor (directory: string, options: any = {}) {
    if (!directory || typeof directory !== 'string') {
      throw new TypeError('Root directory must be set')
    }

    this.directory = serveUtils.forwardSlashes(directory)

    if (this.directory.endsWith('/')) {
      this.directory = this.directory.slice(0, -1)
    }

    if (options.acceptRanges === undefined) {
      options.acceptRanges = true
    }

    if (options.etag === undefined) {
      options.etag = true
    }

    if (options.ignorePatterns) {
      if (!Array.isArray(options.ignorePatterns) || options.ignorePatterns.some((pattern: any) => typeof pattern !== 'string')) {
        throw new TypeError('Middleware option ignorePatterns must be an array of string')
      }
    }

    if (options.lastModified === undefined) {
      options.lastModified = true
    }

    if (options.setHeaders && typeof options.setHeaders !== 'function') {
      throw new TypeError('Middleware option setHeaders must be a function')
    }

    if (typeof options.overrideContentTypes === 'object') {
      this.contentTypesMaps = new Map()

      const types = Object.keys(options.overrideContentTypes)
      for (const type of types) {
        const extensions = options.overrideContentTypes[type]
        if (Array.isArray(extensions)) {
          for (const extension of extensions) {
            this.contentTypesMaps.set(extension, type)
          }
        }
      }

      if (this.contentTypesMaps.size) {
        logger.debug(`Initiated Content-Type overrides map for ${this.contentTypesMaps.size} extension(s).`)
      } else {
        this.contentTypesMaps = undefined
      }
    }

    if (options.setContentDisposition) {
      this.contentDispositionStore = new SimpleDataStore(
        options.contentDispositionOptions || {
          limit: 50,
          strategy: SimpleDataStore.STRATEGIES[0]
        }
      )

      logger.debug('Initiated SimpleDataStore for Content-Disposition: ' +
         `{ limit: ${this.contentDispositionStore.limit}, strategy: "${this.contentDispositionStore.strategy}" }`)
    }

    this.#options = options
  }

  async #handle (req: any, res: any, fullPath: string, stat: any, setHeaders?: Function) {
    const extname = utils.extname(req.path).substring(1)

    res.type(extname)

    await this.#setHeaders(req, res, stat, extname)

    if (typeof setHeaders === 'function') {
      setHeaders(req, res)
    }

    if (serveUtils.assertConditionalGET(req, res)) {
      return res.end()
    }

    const result = serveUtils.buildReadStreamOptions(req, res, stat, this.#options.acceptRanges)
    if (!result) {
      return res.end()
    }

    if (req.method === 'HEAD') {
      res.header('Content-Length', String(result.length))
      return res.end()
    }

    if (result.options.start === 0 && this.contentDispositionStore) {
      await this.#setContentDisposition(req, res)
    }

    if (result.length === 0) {
      res.end()
    }

    return this.#stream(req, res, fullPath, result)
  }

  async #get (fullPath: string) {
    const stat = await fsPromises.stat(fullPath)

    if (stat.isDirectory()) return

    return stat
  }

  async #handler (req: any, res: any) {
    if (!res || res.headersSent) return

    if (this.#options.ignorePatterns && this.#options.ignorePatterns.some((pattern: string) => req.path.startsWith(pattern))) {
      return errors.handleNotFound(req, res)
    }

    const fullPath = this.directory + req.path
    const stat = await this.#get(fullPath)
      .catch((error: any) => {
        if (error.code !== 'ENOENT') {
          throw error
        }
      })
    if (stat === undefined) {
      return errors.handleNotFound(req, res)
    }

    return this.#handle(req, res, fullPath, stat)
  }

  async #setContentDisposition (req: any, res: any) {
    if (req.path.indexOf('/', 1) !== -1) return

    const name = req.path.substring(1)
    try {
      let original = this.contentDispositionStore.get(name)
      if (original === undefined) {
        this.contentDispositionStore.hold(name)
        original = await utils.db.table('files')
          .where('name', name)
          .select('original')
          .first()
          .then((_file: any) => {
            this.contentDispositionStore.set(name, _file.original)
            return _file.original
          })
      }
      if (original) {
        const isSvg = name.toLowerCase().endsWith('.svg')
        const dispositionType = isSvg ? 'attachment' : 'inline'
        res.header('Content-Disposition', contentDisposition(original, { type: dispositionType }))
      }
    } catch (error) {
      this.contentDispositionStore.delete(name)
      logger.error(error)
    }
  }

  async #setHeaders (req: any, res: any, stat: any, extname: string) {
    if (this.contentTypesMaps && req.path.indexOf('/', 1) === -1) {
      const contentType = this.contentTypesMaps.get(extname)
      if (contentType) {
        res.header('content-type', contentType)
      }
    }

    if (this.#options.setHeaders) {
      this.#options.setHeaders(req, res)
    }

    if (this.#options.acceptRanges && !res.get('Accept-Ranges')) {
      res.header('Accept-Ranges', 'bytes')
    }

    if (this.#options.lastModified && !res.get('Last-Modified')) {
      const modified = stat.mtime.toUTCString()
      res.header('Last-Modified', modified)
    }

    if (this.#options.etag && !res.get('ETag')) {
      const val = etag(stat)
      res.header('ETag', val)
    }
  }

  async #stream (req: any, res: any, fullPath: string, result: any) {
    const readStream = jetpack.createReadStream(fullPath, result.options)

    readStream.on('error', (error: Error) => {
      readStream.destroy()
      logger.error(error)
    })

    return res.stream(readStream, result.length)
  }

  get handle () {
    return this.#handle.bind(this)
  }

  get handler () {
    return this.#handler.bind(this)
  }
}

export = ServeStatic
