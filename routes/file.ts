import { Router } from 'hyper-express'
const routes = new Router()
const utils = require('./../controllers/utilsController')
const config = require('./../controllers/utils/ConfigManager')

routes.get('/file/:identifier', async (req: any, res: any) => {
  return res.render('file', {
    config, utils, versions: utils.versionStrings
  }, !utils.devmode)
})

export = routes
