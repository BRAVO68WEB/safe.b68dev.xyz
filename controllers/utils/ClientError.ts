interface ClientErrorOptions {
  statusCode?: number
  code?: number
}

class ClientError extends Error {
  statusCode: number
  code?: number

  constructor (message: string, options: ClientErrorOptions = {}) {
    super(message)

    this.statusCode = options.statusCode ?? 400
    this.code = options.code
  }
}

export = ClientError
