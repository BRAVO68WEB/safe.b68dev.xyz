class ExpressCompat {
  #getHeader (res: any, name: string) {
    const values = res._getHeader(name)
    if (Array.isArray(values) && values.length === 1) {
      return values[0]
    } else {
      return values
    }
  }

  #middleware (req: any, res: any, next: () => void) {
    res._get = res.get
    res._getHeader = res.getHeader
    res.get = res.getHeader = (name: string) => this.#getHeader(res, name)

    return next()
  }

  get middleware () {
    return this.#middleware.bind(this)
  }
}

export = ExpressCompat
