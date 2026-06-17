const LiveDirectory = require('live-directory')
const serveUtils = require('./../utils/serveUtils')

class ServeLiveDirectory {
  instance: any
  directory: string

  #options: any

  constructor (directory: string, options: any = {}) {
    if (!directory || typeof directory !== 'string') {
      throw new TypeError('Root directory must be set')
    }

    this.directory = serveUtils.forwardSlashes(directory)

    if (this.directory.endsWith('/')) {
      this.directory = this.directory.slice(0, -1)
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

    const instanceOptions = Object.assign({}, options.instanceOptions)
    instanceOptions.path = this.directory

    delete options.instanceOptions

    if (!instanceOptions.ignore) {
      instanceOptions.ignore = (path: string) => {
        return path.startsWith('.')
      }
    }

    this.instance = new LiveDirectory(instanceOptions)

    this.#options = options
  }

  get (path: string) {
    return this.instance.get(path)
  }

  handler (req: any, res: any, path: string, file: any) {
    res.type(file.extension)
    this.#setHeaders(req, res, file)

    if (serveUtils.assertConditionalGET(req, res)) {
      return res.end()
    }

    if (req.method === 'HEAD') {
      return res.end()
    }

    return res.send(file.buffer)
  }

  ready () {
    return this.instance.ready()
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

    const file = this.get(path)
    if (file === undefined) {
      return next()
    }

    return this.handler(req, res, path, file)
  }

  #setHeaders (req: any, res: any, file: any) {
    if (this.#options.setHeaders) {
      this.#options.setHeaders(req, res)
    }

    if (this.#options.lastModified && !res.get('Last-Modified')) {
      const modified = new Date(file.last_update).toUTCString()
      res.header('Last-Modified', modified)
    }

    if (this.#options.etag && !res.get('ETag')) {
      const val = file.etag
      res.header('ETag', val)
    }
  }

  get middleware () {
    return this.#middleware.bind(this)
  }
}

export = ServeLiveDirectory
