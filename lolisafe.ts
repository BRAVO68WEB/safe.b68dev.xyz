const logger = require('./logger')

process.on('uncaughtException', (error: Error) => {
  logger.error(error, { prefix: 'Uncaught Exception: ' })
})

process.on('unhandledRejection', (error: Error) => {
  logger.error(error, { prefix: 'Unhandled Rejection (Promise): ' })
})

process.once('SIGINT', () => {
  logger.log('SIGINT signal received, exiting lolisafe\u2026')
  process.exit(0)
})

try {
  const { chdir, cwd } = require('process')
  if (cwd() !== __dirname) {
    chdir(__dirname)
    logger.log(`Changed working directory to: ${__dirname}`)
  }
} catch (error) {
  logger.error(error)
  process.exit(1)
}

const fs = require('fs')
const helmet = require('helmet')
const HyperExpress = require('hyper-express')

const configFiles = ['config.js', 'views/_globals.njk']
for (const _file of configFiles) {
  try {
    fs.accessSync(_file, fs.constants.R_OK)
  } catch (error) {
    logger.error(`Config file '${_file}' cannot be found or read.`)
    logger.error('Please copy the provided sample file and modify it according to your needs.')
    process.exit(1)
  }
}

const config = require('./controllers/utils/ConfigManager')

logger.log('Starting lolisafe\u2026')
const safe = new HyperExpress.Server({
  trust_proxy: Boolean(config.trustProxy)
})

const errors = require('./controllers/errorsController')
const paths = require('./controllers/pathsController')
paths.initSync()
const utils = require('./controllers/utilsController')

const DebugLogging = require('./controllers/middlewares/DebugLogging')
const ExpressCompat = require('./controllers/middlewares/ExpressCompat')
const NunjucksRenderer = require('./controllers/middlewares/NunjucksRenderer')
const RateLimiter = require('./controllers/middlewares/RateLimiter')
const ServeLiveDirectory = require('./controllers/middlewares/ServeLiveDirectory')
const ServeStaticQuick = require('./controllers/middlewares/ServeStaticQuick')

const ServeStatic = require('./controllers/handlers/ServeStatic')

const ScannerManager = require('./controllers/utils/ScannerManager')

const album = require('./routes/album')
const api = require('./routes/api')
const file = require('./routes/file')
const nojs = require('./routes/nojs')
const player = require('./routes/player')
const tempUpload = require('./routes/tempUpload')

if (utils.devmode) {
  const DebugLoggingInstance = new DebugLogging()
  safe.use(DebugLoggingInstance.middleware)
}

const expressCompatInstance = new ExpressCompat()
safe.use(expressCompatInstance.middleware)

if (Array.isArray(config.rateLimiters)) {
  let whitelistedKeys: Set<string> | undefined
  if (Array.isArray(config.rateLimitersWhitelist)) {
    whitelistedKeys = new Set(config.rateLimitersWhitelist)
  }
  for (const rateLimit of config.rateLimiters) {
    const rateLimiterInstance = new RateLimiter('ip', rateLimit.options, whitelistedKeys)
    for (const route of rateLimit.routes) {
      safe.use(route, rateLimiterInstance.middleware)
    }
  }
} else if (config.rateLimits) {
  logger.error('Config option "rateLimits" is DEPRECATED.')
  logger.error('Please consult the provided sample file for the new option "rateLimiters".')
}

if (config.helmet instanceof Object) {
  if (Object.keys(config.helmet).length) {
    safe.use(helmet(config.helmet))
  }
} else {
  const defaults: Record<string, any> = {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    hsts: false,
    originAgentCluster: false
  }

  if (config.hsts instanceof Object && Object.keys(config.hsts).length) {
    defaults.hsts = config.hsts
  }

  safe.use(helmet(defaults))
}

if (config.accessControlAllowOrigin) {
  if (config.accessControlAllowOrigin === true) {
    config.accessControlAllowOrigin = '*'
  }
  safe.use((req: any, res: any, next: () => void) => {
    res.header('Access-Control-Allow-Origin', config.accessControlAllowOrigin)
    if (config.accessControlAllowOrigin !== '*') {
      res.vary('Origin')
    }
    next()
  })
}

const nunjucksRendererInstance = new NunjucksRenderer('views', {
  watch: utils.devmode
})

safe.use(nunjucksRendererInstance.middleware)

const cdnRoutes = [...config.pages]

let setHeadersForStaticAssets = (req: any, res: any) => {
  res.header('Cache-Control', 'no-cache')
}

if (config.cacheControl) {
  const cacheControls: Record<string, string> = {
    static: 'public, max-age=15778800, immutable',
    cdn: 's-max-age=15778800, proxy-revalidate',
    validate: 'no-cache',
    disable: 'no-store'
  }

  safe.use((req: any, res: any, next: () => void) => {
    res.header('Cache-Control', cacheControls.validate)
    return next()
  })

  switch (config.cacheControl) {
    case 1:
    case true:
      cdnRoutes.push('api/check')
      safe.use((req: any, res: any, next: () => void) => {
        if (req.method === 'GET' || req.method === 'HEAD') {
          const page = req.path === '/' ? 'home' : req.path.substring(1)
          if (cdnRoutes.includes(page)) {
            res.header('Cache-Control', cacheControls.cdn)
          }
        }
        return next()
      })
      break
  }

  setHeadersForStaticAssets = (req: any, res: any) => {
    res.header('Cache-Control', cacheControls.static)
  }

  safe.use('/api/album/zip', (req: any, res: any, next: () => void) => {
    const versionString = parseInt(req.query_parameters.v)
    if (versionString > 0) {
      res.header('Cache-Control', cacheControls.static)
    } else {
      res.header('Cache-Control', cacheControls.disable)
    }
    return next()
  })
}

const ServeStaticClass = config.useServeStaticQuick
  ? ServeStaticQuick
  : ServeLiveDirectory

const serveStaticDistInstance = new ServeStaticClass(paths.dist, {
  setHeaders: setHeadersForStaticAssets
})
safe.use(serveStaticDistInstance.middleware)

const serveStaticPublicInstance = new ServeStaticClass(paths.public, {
  setHeaders: setHeadersForStaticAssets
})
safe.use(serveStaticPublicInstance.middleware)

config.routes = typeof config.routes === 'object'
  ? config.routes
  : {}

if (config.routes.album !== false) safe.use(album)
if (config.routes.file !== false) safe.use(file)
if (config.routes.nojs !== false) safe.use(nojs)
if (config.routes.player !== false) safe.use(player)
safe.use(tempUpload)

safe.use('/api', api)

;(async () => {
  try {
    const knex = require('knex')
    const migrator = knex(config.database)
    try {
      await migrator.migrate.latest()
      logger.log('Database migrations completed.')
    } catch (err: any) {
      logger.error('Database migration failed:', err.message)
      process.exit(1)
    } finally {
      await migrator.destroy()
    }

    await require('./controllers/utils/initDatabase')(utils.db)

    if (!Array.isArray(config.pages) || !config.pages.length) {
      logger.error('Config file does not have any frontend pages enabled')
      process.exit(1)
    }

    utils.versionStrings = {}
    if (config.cacheControl) {
      const versions = require('./src/versions')
      if (versions['1'] && utils.devmode) {
        versions['1'] = String(Math.ceil(Date.now() / 1000))
      }
      for (const type in versions) {
        utils.versionStrings[type] = `?_=${versions[type]}`
      }
      if (versions['1']) {
        utils.clientVersion = versions['1']
      }
    }

    const serveLiveDirectoryCustomPagesInstance = new ServeLiveDirectory(paths.customPages, {
      instanceOptions: {
        keep: ['.html']
      }
    })

    if (config.cookiePolicy) {
      config.pages.push('cookiepolicy')
    }

    safe.use((req: any, res: any, next: () => void) => {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const page = req.path === '/' ? 'home' : req.path.substring(1)
        const customPage = serveLiveDirectoryCustomPagesInstance.get(`${page}.html`)
        if (customPage) {
          return serveLiveDirectoryCustomPagesInstance.handler(req, res, req.path, customPage)
        } else if (config.pages.includes(page)) {
          return res.render(page, {
            config, utils, versions: utils.versionStrings
          }, !utils.devmode)
        }
      }
      return next()
    })

    if (config.serveFilesWithNode) {
      const serveStaticInstance = new ServeStatic(paths.uploads, {
        contentDispositionOptions: config.contentDispositionOptions,
        ignorePatterns: [
          '/chunks/'
        ],
        overrideContentTypes: config.overrideContentTypes,
        setContentDisposition: config.setContentDisposition
      })

      safe.get('/*', serveStaticInstance.handler)
      safe.head('/*', serveStaticInstance.handler)

      utils.contentDispositionStore = serveStaticInstance.contentDispositionStore
    }

    safe.set_not_found_handler(errors.handleNotFound)
    safe.set_error_handler(errors.handleError)

    if (config.showGitHash) {
      utils.gitHash = await new Promise((resolve, reject) => {
        require('child_process').execFile('git', ['rev-parse', 'HEAD'], (error: Error | null, stdout: string) => {
          if (error) return reject(error)
          resolve(stdout.replace(/\n$/, ''))
        })
      })
      logger.log(`Git commit: ${utils.gitHash}`)
    }

    await Promise.all([
      serveStaticDistInstance.ready(),
      serveStaticPublicInstance.ready(),
      serveLiveDirectoryCustomPagesInstance.ready()
    ])

    await ScannerManager.init()

    await safe.listen(config.port)
    logger.log(`lolisafe started on port ${config.port}`)

    if (config.cacheControl && config.cacheControl !== 2) {
      if (config.cloudflare.purgeCache) {
        logger.log('Cache control enabled, purging Cloudflare\'s cache...')
        const results = await utils.purgeCloudflareCache(cdnRoutes)
        let errored = false
        let succeeded = 0
        for (const result of results) {
          if (result.errors.length) {
            if (!errored) errored = true
            result.errors.forEach((error: string) => logger.log(`[CF]: ${error}`))
            continue
          }
          succeeded += result.files.length
        }
        if (!errored) {
          logger.log(`Successfully purged ${succeeded} cache`)
        }
      } else {
        logger.log('Cache control enabled without Cloudflare\'s cache purging')
      }
    }

    if (utils.retentions && utils.retentions.enabled && config.uploads.temporaryUploadsInterval > 0) {
      let temporaryUploadsInProgress = false
      const temporaryUploadCheck = async () => {
        if (temporaryUploadsInProgress) return

        temporaryUploadsInProgress = true
        try {
          const result = await utils.bulkDeleteExpired(false, utils.devmode)

          if (result.expired.length || result.failed.length) {
            if (utils.devmode) {
              let logMessage = `Expired uploads (${result.expired.length}): ${result.expired.map((_file: any) => _file.name).join(', ')}`
              if (result.failed.length) {
                logMessage += `\nErrored (${result.failed.length}): ${result.failed.map((_file: any) => _file.name).join(', ')}`
              }
              logger.debug(logMessage)
            } else {
              let logMessage = `Expired uploads: ${result.expired.length} deleted`
              if (result.failed.length) {
                logMessage += `, ${result.failed.length} errored`
              }
              logger.log(logMessage)
            }
          }
        } catch (error) {
          logger.error(error)
        }

        temporaryUploadsInProgress = false
      }

      temporaryUploadCheck()
      setInterval(temporaryUploadCheck, config.uploads.temporaryUploadsInterval)
    }

    // Temp upload cleanup (runs every 5 minutes)
    if (config.tempUploads && config.tempUploads.enabled !== false) {
      const tempUploadController = require('./controllers/tempUploadController')
      const tempCleanupCheck = async () => {
        try {
          const result = await tempUploadController.cleanupExpired()
          if (result.deleted > 0) {
            logger.log(`Temp uploads: ${result.deleted} expired file(s) cleaned up`)
          }
        } catch (error) {
          logger.error(error)
        }
      }
      setInterval(tempCleanupCheck, 5 * 60 * 1000)
    }

    if (utils.devmode) {
      const { inspect } = require('util')
      require('readline').createInterface({
        input: process.stdin
      }).on('line', (line: string) => {
        try {
          if (line === 'rs') return
          if (line === '.exit') return process.exit(0)
          const evaled = eval(line)
          process.stdout.write(`${typeof evaled === 'string' ? evaled : inspect(evaled)}\n`)
        } catch (error: any) {
          process.stderr.write(`${error.stack}\n`)
        }
      })
      logger.log(utils.stripIndents(`!!! DEVELOPMENT MODE !!!
        [=] Nunjucks will auto rebuild (not live reload)
        [=] HTTP rate limits disabled
        [=] Readline interface enabled (eval arbitrary JS input)`))
    }
  } catch (error) {
    logger.error(error)
    process.exit(1)
  }
})()
