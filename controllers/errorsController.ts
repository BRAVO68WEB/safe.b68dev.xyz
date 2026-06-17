import path = require('path')
import paths = require('./pathsController')
import ClientError = require('./utils/ClientError')
import ServerError = require('./utils/ServerError')
import config = require('./utils/ConfigManager')
import logger = require('./../logger')

interface ErrorsSelf {
  errorPagesCodes: number[]
  handleError: (req: any, res: any, error: any) => any
  handleNotFound: (req: any, res: any) => any
}

const self: ErrorsSelf = {
  errorPagesCodes: Object.keys(config.errorPages)
    .filter(key => /^\d+$/.test(key))
    .map(key => Number(key))
} as ErrorsSelf

self.handleError = (req: any, res: any, error: any): any => {
  if (!res || res.headersSent) {
    logger.error(error)
    return
  }

  res.header('Cache-Control', 'no-store')

  const isClientError = error instanceof ClientError
  const isServerError = error instanceof ServerError

  let statusCode = res.statusCode

  if (isClientError || isServerError) {
    if (isServerError && error.logStack) {
      logger.error(error)
    }

    const json: any = {
      success: false,
      description: error.message || 'An unexpected error occurred. Try again?',
      code: error.code
    }

    if (statusCode === undefined) {
      res.status(error.statusCode || 500)
    }

    return res.json(json)
  } else {
    logger.error(error)

    if (statusCode === undefined) {
      statusCode = 500
    }

    if (self.errorPagesCodes.includes(statusCode)) {
      return res
        .status(statusCode)
        .sendFile(path.join(paths.errorRoot, config.errorPages[statusCode]))
    } else {
      return res
        .status(statusCode)
        .end()
    }
  }
}

self.handleNotFound = (req: any, res: any): any => {
  if (!res || res.headersSent) return

  res.header('Cache-Control', 'no-store')
  return res
    .status(404)
    .sendFile(path.join(paths.errorRoot, config.errorPages[404]))
}

export = self
