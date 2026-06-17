import { Router } from 'hyper-express'
const routes = new Router()
const upload = require('./../controllers/uploadController')
const utils = require('./../controllers/utilsController')
const config = require('./../controllers/utils/ConfigManager')

routes.get('/nojs', async (req: any, res: any) => {
  return res.render('nojs', {
    config, utils, versions: utils.versionStrings
  }, !utils.devmode)
})

routes.post('/nojs', {
  max_body_length: parseInt(config.uploads.maxSize) * 1e6,
  middlewares: [
    async (req: any, res: any) => {
      utils.assertRequestType(req, 'multipart/form-data')

      const origin = req.headers.origin || req.headers.referer
      if (origin) {
        const expectedOrigin = config.homeDomain || config.domain
        if (expectedOrigin && !origin.startsWith(expectedOrigin)) {
          throw new utils.ClientError('Invalid origin.', { statusCode: 403 })
        }
      }
    }
  ]
}, async (req: any, res: any) => {
  res._json = res.json
  res.json = (...args: any[]) => {
    const result = args[0]
    return res.render('nojs', {
      config,
      utils,
      versions: utils.versionStrings,
      errorMessage: result.success ? '' : (result.description || 'An unexpected error occurred.'),
      files: result.files || [{}]
    })
  }

  req.locals.nojs = true

  return upload.upload(req, res)
})

export = routes
