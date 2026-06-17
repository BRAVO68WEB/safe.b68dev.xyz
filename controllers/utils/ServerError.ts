interface ServerErrorOptions {
  statusCode?: number
  code?: number
  logStack?: boolean
}

class ServerError extends Error {
  statusCode: number
  code?: number
  logStack: boolean

  constructor (message: string, options: ServerErrorOptions = {}) {
    super(message)

    this.statusCode = options.statusCode ?? 500
    this.code = options.code
    this.logStack = options.logStack ?? false
  }
}

export = ServerError
