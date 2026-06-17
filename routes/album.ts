import { Router } from 'hyper-express'
const routes = new Router()
const path = require('path')
const errors = require('./../controllers/errorsController')
const utils = require('./../controllers/utilsController')
const config = require('./../controllers/utils/ConfigManager')

routes.get('/a/:identifier', async (req: any, res: any) => {
  const identifier = req.path_parameters && req.path_parameters.identifier
  if (identifier === undefined) {
    return errors.handleNotFound(req, res)
  }

  const album = await utils.db.table('albums')
    .where({
      identifier,
      enabled: 1
    })
    .select('id', 'name', 'identifier', 'editedAt', 'download', 'public', 'description')
    .first()

  if (!album || album.public === 0) {
    return errors.handleNotFound(req, res)
  }

  album.name = utils.unescape(album.name)
  const nojs = req.query_parameters.nojs !== undefined

  let cacheid: string | undefined
  if (process.env.NODE_ENV !== 'development') {
    cacheid = `${album.id}${nojs ? '-nojs' : ''}`

    const cache = utils.albumRenderStore.get(cacheid)
    if (cache) {
      res.header('Content-Type', 'text/html; charset=utf-8')
      return res.send(cache)
    } else if (cache === null) {
      return res.render('album-notice', {
        config,
        utils,
        versions: utils.versionStrings,
        album,
        notice: 'This album\'s public page is still being generated. Please try again later.'
      })
    }

    utils.albumRenderStore.hold(cacheid)
  }

  const files = await utils.db.table('files')
    .select('name', 'size', 'timestamp')
    .where('albumid', album.id)
    .orderBy('id', 'desc')

  album.thumb = ''
  album.totalSize = 0

  for (const file of files) {
    album.totalSize += parseInt(file.size)

    file.extname = path.extname(file.name)
    if (utils.mayGenerateThumb(file.extname)) {
      let thumbext = '.png'
      if (utils.isAnimatedThumb(file.extname)) thumbext = '.gif'
      file.thumb = `thumbs/${file.name.slice(0, -file.extname.length)}${thumbext}`
      if (!album.thumb) album.thumb = file.name
    }
  }

  album.downloadLink = album.download === 0
    ? null
    : `api/album/zip/${album.identifier}?v=${album.editedAt}`

  album.url = `a/${album.identifier}`
  album.description = album.description
    ? utils.md.instance.render(album.description)
    : null

  const html = await res.render('album', {
    config,
    utils,
    versions: utils.versionStrings,
    album,
    files,
    nojs
  })

  if (cacheid) {
    if (html && files.length) {
      utils.albumRenderStore.set(cacheid, html)
    } else {
      utils.albumRenderStore.delete(cacheid)
    }
  }
})

export = routes
