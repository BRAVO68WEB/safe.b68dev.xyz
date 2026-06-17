import { Router } from 'hyper-express'
const routes = new Router()
const tempUpload = require('./../controllers/tempUploadController')
const utils = require('./../controllers/utilsController')

// Upload page
routes.get('/temp', tempUpload.renderPage)

// Upload endpoint
routes.post('/api/temp/upload', {
  max_body_length: tempUpload.maxSizeBytes,
  middlewares: []
}, tempUpload.upload)

// Get file info (JSON)
routes.get('/api/temp/:identifier', tempUpload.get)

// Serve/Download file
routes.get('/temp/:identifier', tempUpload.serve)

export = routes
