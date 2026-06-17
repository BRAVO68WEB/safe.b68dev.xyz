const nunjucks = require('nunjucks')

class NunjucksRenderer {
  directory: string
  environment: any

  #persistentCaches = new Map<string, string>()

  constructor (directory = '', options: any = {}) {
    if (typeof directory !== 'string') {
      throw new TypeError('Root directory must be a string value')
    }

    this.directory = directory

    this.environment = nunjucks.configure(
      this.directory,
      Object.assign(options, {
        autoescape: true
      })
    )
  }

  #middleware (req: any, res: any, next: () => void) {
    res.render = (path: string, context?: any, usePersistentCache?: boolean) =>
      this.#render(res, path, context, usePersistentCache)
    return next()
  }

  #render (res: any, path: string, context?: any, usePersistentCache = false) {
    if (!path) {
      throw new Error('Missing Nunjucks template name.')
    }

    return new Promise((resolve, reject) => {
      const template = `${path}.njk`

      if (usePersistentCache) {
        const cached = this.#persistentCaches.get(template)
        if (cached) {
          return resolve(cached)
        }
      }

      this.environment.render(template, context, (err: Error | null, html: string) => {
        if (err) {
          return reject(err)
        }
        if (usePersistentCache) {
          this.#persistentCaches.set(template, html)
        }
        resolve(html)
      })
    }).then(html => {
      res.header('Content-Type', 'text/html; charset=utf-8')
      res.send(html)
      return html
    })
  }

  get middleware () {
    return this.#middleware.bind(this)
  }
}

export = NunjucksRenderer
