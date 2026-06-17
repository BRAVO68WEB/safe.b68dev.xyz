const logger = require('./../../logger')

class DebugLogging {
  constructor () {
    logger.log('Initiated DebugLogging middleware.')
  }

  #middleware (req: any, res: any, next: () => void) {
    req.locals.debug = {
      ip: req.ip,
      method: req.method,
      path: req.path,
      path_parameters: req.path_parameters
    }
    logger.log(`Incoming from ${req.locals.debug.ip} -> ${req.locals.debug.method} ${req.locals.debug.path}`)
    return next()
  }

  get middleware () {
    return this.#middleware.bind(this)
  }
}

export = DebugLogging
