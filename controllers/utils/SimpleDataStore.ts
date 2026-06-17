const STRATEGIES = [
  'LAST_GET_TIME',
  'GETS_COUNT'
] as const

type Strategy = typeof STRATEGIES[number]

interface StoreEntry {
  value: any
  stratval: number
}

interface SimpleDataStoreOptions {
  limit: number
  strategy: Strategy
}

class SimpleDataStore {
  #store: Map<string, StoreEntry>
  #held: Set<string>
  #limit: number
  #strategy: Strategy

  static STRATEGIES = STRATEGIES

  constructor (options: SimpleDataStoreOptions) {
    if (typeof options !== 'object') {
      throw new TypeError('Missing options object.')
    }

    if (!Number.isFinite(options.limit) || options.limit <= 1) {
      throw new TypeError('Limit must be a finite number that is at least 2.')
    }

    if (!(STRATEGIES as readonly string[]).includes(options.strategy)) {
      throw new TypeError(`Strategy must be one of these: ${STRATEGIES.map(s => `"${s}"`).join(', ')}.`)
    }

    this.#store = new Map()
    this.#held = new Set()
    this.#limit = options.limit
    this.#strategy = options.strategy
  }

  clear (): void {
    this.#store.clear()
    this.#held.clear()
  }

  delete (key: string): boolean {
    return this.#held.delete(key) || this.#store.delete(key)
  }

  deleteStalest (): boolean | undefined {
    const stalest = this.getStalest()
    if (stalest) {
      return this.#store.delete(stalest)
    }
  }

  get (key: string): any {
    if (this.#held.has(key)) {
      return null
    }

    const entry = this.#store.get(key)
    if (!entry) return entry

    switch (this.#strategy) {
      case STRATEGIES[0]:
        entry.stratval = Date.now()
        break
      case STRATEGIES[1]:
        entry.stratval++
        break
    }

    this.#store.set(key, entry)
    return entry.value
  }

  getStalest (): string | null {
    let stalest: [string | null, StoreEntry] = [null, { stratval: Infinity, value: undefined }]
    switch (this.#strategy) {
      case STRATEGIES[0]:
      case STRATEGIES[1]:
        for (const entry of this.#store) {
          if (entry[1].stratval < stalest[1].stratval) {
            stalest = entry
          }
        }
        break
    }

    return stalest[0]
  }

  hold (key: string): boolean {
    this.#held.add(key)
    return true
  }

  set (key: string, value: any): boolean {
    if (!this.#store.has(key) && this.#store.size >= this.#limit) {
      this.deleteStalest()
    }

    let stratval: number
    switch (this.#strategy) {
      case STRATEGIES[0]:
        stratval = Date.now()
        break
      case STRATEGIES[1]:
        stratval = 0
        break
    }

    if (this.#store.set(key, { value, stratval })) {
      this.#held.delete(key)
      return true
    }
    return false
  }

  get limit (): number {
    return this.#limit
  }

  set limit (_) {
    throw Error('This property is read-only.')
  }

  get size (): number {
    return this.#store.size
  }

  set size (_) {
    throw Error('This property is read-only.')
  }

  get strategy (): Strategy {
    return this.#strategy
  }

  set strategy (_) {
    throw Error('This property is read-only.')
  }

  get store (): Map<string, StoreEntry> {
    return new Map(this.#store)
  }

  get held (): Set<string> {
    return new Set(this.#held)
  }
}

export = SimpleDataStore
module.exports.STRATEGIES = STRATEGIES
