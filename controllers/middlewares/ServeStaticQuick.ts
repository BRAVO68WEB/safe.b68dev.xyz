const chokidar = require('chokidar')
const etag = require('etag')
const jetpack = require('fs-jetpack')
const nodePath = require('node:path')
const serveUtils = require('./../utils/serveUtils')
const logger = require('./../../logger')

interface FileData {
  stat: any
  extname: string
}

class ServeStaticQuick {
  directory: string
  files: Map<string, FileData>
  watcher: any

  #options: any
  #readyPromise: any
  #readyResolve: any

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

    if (options.ignore && typeof options.ignore !== 'function') {
      throw new TypeError('Middleware option ignore must be a function')
    }

    if (options.lastModified === undefined) {
      options.lastModified = true
    }

    if (options.setHeaders && typeof options.setHeaders !== 'function') {
      throw new TypeError('Middleware option setHeaders must be a function')
    }

    this.files = new Map()

    this.watcher = chokidar.watch(this.directory, {
      alwaysStat: false,
      awaitWriteFinish: {
        pollInterval: 100,
        stabilityThreshold: 500
      }
    })

    this.#bindWatchHandlers()

    this.#options = options
  }

  get (path: string): FileData | undefined {
    const data = this.files.get(path)

    if (!data?.stat || data?.stat?.isDirectory()) return

    return data
  }

  handler (req: any, res: any, path: string, data: FileData) {
    res.type(data.extname)
    this.#setHeaders(req, res, data.stat)

    if (serveUtils.assertConditionalGET(req, res)) {
      return res.end()
    }

    const result = serveUtils.buildReadStreamOptions(req, res, data.stat, this.#options.acceptRanges)
    if (!result) {
      return res.end()
    }

    if (req.method === 'HEAD') {
      res.header('Content-Length', String(result.length))
      return res.end()
    }

    if (result.length === 0) {
      res.end()
    }

    return this.#stream(req, res, path, data.stat, result)
  }

  ready () {
    if (this.#readyPromise === true) return Promise.resolve(true)

    if (this.#readyPromise === undefined) {
      this.#readyPromise = new Promise((resolve) => (this.#readyResolve = resolve))
    }

    return this.#readyPromise
  }

  #bindWatchHandlers () {
    this.watcher.on('all', (event: string, path: string, stat: any) => {
      const relPath = serveUtils.relativePath(this.directory, path)

      if (!relPath) return

      switch (event) {
        case 'add':
        case 'addDir':
        case 'change':
          if (!this.#options.ignore || !this.#options.ignore(relPath, stat)) {
            this.files.set(relPath, {
              stat,
              extname: nodePath.extname(relPath).substring(1)
            })
          }
          break
        case 'unlink':
        case 'unlinkDir':
          this.files.delete(relPath)
          break
      }
    })

    this.watcher.once('ready', () => {
      if (typeof this.#readyResolve === 'function') {
        this.#readyResolve()
        this.#readyResolve = null
      }

      this.#readyPromise = true
    })
  }

  #middleware (req: any, res: any, next: () => void) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next()
    }

    let path = req.path
    if (this.#options.root) {
      if (path.indexOf(this.#options.root) === 0) {
        path = path.replace(this.#options.root, '')
      } else {
        return next()
      }
    }

    const data = this.get(path)
    if (data === undefined) {
      return next()
    }

    return this.handler(req, res, path, data)
  }

  #setHeaders (req: any, res: any, stat: any) {
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

  #stream (req: any, res: any, path: string, stat: any, result: any) {
    const fullPath = this.directory + path
    const readStream = jetpack.createReadStream(fullPath, result.options)

    readStream.on('error', (error: Error) => {
      readStream.destroy()
      logger.error(error)
    })

    return res.stream(readStream, result.length)
  }

  get middleware () {
    return this.#middleware.bind(this)
  }
}

export = ServeStaticQuick
