/*
 * ServeStaticQuick.
 *
 * This is intended as a compromise between ServeStatic handler and
 * ServeLiveDirectory middleware.
 *
 * This monitors and caches the configured directory's file tree for quick lookups,
 * thus allowing multiple instances of this middleware to be used together, if needed.
 *
 * When matches are found, it will then simply spawn ReadStream to the physical files.
 * Due to the fact that it does not have to pre-cache the whole files into memory,
 * this is likely the better choice to serve generic assets
 * in an environment where memory space is a premium.
 *
 * This class also has Conditional GETs support,
 * which involves handling cache-related headers such as
 * If-Match, If-Unmodified-Since, ETag, etc.
 * And partial bytes fetch by handling Content-Range header,
 * which is useful for streaming, among other things.
 */

const chokidar = require('chokidar')
const etag = require('etag')
const fs = require('fs')
const serveUtils = require('./../utils/serveUtils')
const logger = require('./../../logger')

class ServeStaticQuick {
  directory
  files
  watcher

  #options
  #readyPromise
  #readyResolve

  constructor (directory, options = {}) {
    if (!directory || typeof directory !== 'string') {
      throw new TypeError('Root directory must be set')
    }

    this.directory = serveUtils.forwardSlashes(directory)

    // Ensure does not end with a forward slash
    if (this.directory.endsWith('/')) {
      this.directory = this.directory.slice(0, -1)
    }

    if (options.acceptRanges === undefined) {
      options.acceptRanges = true
    }

    if (options.etag === undefined) {
      options.etag = true
    }

    if (options.lastModified === undefined) {
      options.lastModified = true
    }

    if (options.setHeaders && typeof options.setHeaders !== 'function') {
      throw new TypeError('Middleware option setHeaders must be a function')
    }

    this.files = new Map()

    this.watcher = chokidar.watch(this.directory, {
      alwaysStat: true,
      awaitWriteFinish: {
        pollInterval: 100,
        stabilityThreshold: 500
      }
    })

    this.#bindWatchHandlers()

    this.#options = options
  }

  handler (req, res, stat) {
    // Set Content-Type
    res.type(req.path)

    // Set header fields
    this.#setHeaders(req, res, stat)

    // Conditional GET support
    if (serveUtils.assertConditionalGET(req, res)) {
      return res.end()
    }

    // ReadStream options with Content-Range support if required
    const { options, length } = serveUtils.buildReadStreamOptions(req, res, stat, this.#options.acceptRanges)

    // HEAD support
    if (req.method === 'HEAD') {
      // If HEAD, also set Content-Length (must be string)
      res.header('Content-Length', String(length))
      return res.end()
    }

    if (length === 0) {
      res.end()
    }

    return this.#stream(req, res, stat, options, length)
  }

  // Returns a promise which resolves to true once ServeStaticQuick is ready
  ready () {
    // Resolve with true if ready is not a promise
    if (this.#readyPromise === true) return Promise.resolve(true)

    // Create a promise if one does not exist for ready event
    if (this.#readyPromise === undefined) {
      this.#readyPromise = new Promise((resolve) => (this.#readyResolve = resolve))
    }

    return this.#readyPromise
  }

  #bindWatchHandlers () {
    this.watcher.on('all', (event, path, stat) => {
      const relPath = serveUtils.relativePath(this.directory, path)

      if (!relPath) return // skips root directory

      switch (event) {
        case 'add':
        case 'addDir':
        case 'change':
          this.files.set(relPath, stat)
          break
        case 'unlink':
        case 'unlinkDir':
          this.files.delete(relPath)
          break
      }
    })

    // Bind 'ready' for when all files have been loaded
    this.watcher.once('ready', () => {
      // Resolve pending promise if one exists
      if (typeof this.#readyResolve === 'function') {
        this.#readyResolve()
        this.#readyResolve = null
      }

      // Mark instance as ready
      this.#readyPromise = true
    })
  }

  #get (path) {
    const stat = this.files.get(path)

    if (!stat || stat.isDirectory()) return

    return stat
  }

  #middleware (req, res, next) {
    // Only process GET and HEAD requests
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next()
    }

    const stat = this.#get(req.path)
    if (stat === undefined) {
      return next()
    }

    return this.handler(req, res, stat)
  }

  #setHeaders (req, res, stat) {
    // Always do external setHeaders function first,
    // in case it will overwrite the following default headers anyways
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

  #stream (req, res, stat, options, length) {
    const fullPath = this.directory + req.path
    const readStream = fs.createReadStream(fullPath, options)

    readStream.on('error', error => {
      readStream.destroy()
      logger.error(error)
    })

    // 2nd param will be set as Content-Length header (must be number)
    return res.stream(readStream, length)
  }

  get middleware () {
    return this.#middleware.bind(this)
  }
}

module.exports = ServeStaticQuick
