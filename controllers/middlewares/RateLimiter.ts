import ClientError from './../utils/ClientError'

const { RateLimiterMemory } = require('rate-limiter-flexible')

class RateLimiter {
  rateLimiterMemory: any

  #requestKey: string | undefined
  #whitelistedKeys: Set<string>

  constructor (requestKey: string | undefined, options: any = {}, whitelistedKeys?: string[] | Set<string>) {
    if (typeof options.points !== 'number' || typeof options.duration !== 'number') {
      throw new Error('Points and Duration must be set with numbers in options')
    }

    this.#requestKey = requestKey
    this.#whitelistedKeys = new Set(whitelistedKeys)

    this.rateLimiterMemory = new RateLimiterMemory(options)
  }

  #middleware (req: any, res: any, next: (err?: Error) => void) {
    if (res.locals.rateLimit) {
      return next()
    }

    const key = this.#requestKey ? req[this.#requestKey] : req.path

    if (this.#whitelistedKeys.has(key)) {
      res.locals.rateLimit = 'BYPASS'
      return next()
    }

    this.rateLimiterMemory.consume(key, 1)
      .then((result: any) => {
        res.locals.rateLimit = result
        res.header('Retry-After', String(result.msBeforeNext / 1000))
        res.header('X-RateLimit-Limit', String(this.rateLimiterMemory._points))
        res.header('X-RateLimit-Remaining', String(result.remainingPoints))
        res.header('X-RateLimit-Reset', String(new Date(Date.now() + result.msBeforeNext)))
        return next()
      })
      .catch(() => {
        return next(new ClientError('Rate limit reached, please try again in a while.', { statusCode: 429 }))
      })
  }

  get middleware () {
    return this.#middleware.bind(this)
  }
}

export = RateLimiter
