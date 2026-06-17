import { Router } from 'hyper-express'
const routes = new Router()
const utils = require('./../controllers/utilsController')
const config = require('./../controllers/utils/ConfigManager')

const playerHandler = async (req: any, res: any) => {
  return res.render('player', {
    config, utils, versions: utils.versionStrings
  }, !utils.devmode)
}

routes.get('/player/:identifier', playerHandler)
routes.get('/v/:identifier', playerHandler)

export = routes
