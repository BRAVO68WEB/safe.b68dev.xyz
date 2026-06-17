import { inspect } from 'util'

interface LogOptions {
  error?: boolean
  prefix?: string
}

const short = process.env.NODE_ENV === 'development'

const now = (): string => {
  const time = new Date()
  const parsed: Record<string, number> = {
    hours: time.getHours(),
    minutes: time.getMinutes(),
    seconds: time.getSeconds(),
    milliseconds: time.getMilliseconds()
  }

  if (!short) {
    parsed.month = time.getMonth() + 1
    parsed.date = time.getDate()
  }

  Object.keys(parsed).forEach(key => {
    parsed[key] = Number(('0' + parsed[key]).slice(-2))
  })

  return (!short ? `${time.getFullYear()}-${parsed.month}-${parsed.date} ` : '') +
    `${parsed.hours}:${parsed.minutes}:${parsed.seconds}` +
    (short ? `.${String(parsed.milliseconds).padStart(3, '0')}` : '')
}

const clean = (item: any): string => {
  if (typeof item === 'string') return item
  return inspect(item, { depth: 0 })
}

const write = (content: any, options: LogOptions = {}) => {
  const stream = options.error ? process.stderr : process.stdout
  stream.write(`[${now()}] ${options.prefix || ''}${clean(content)}\n`)
}

const self: Record<string, any> = {
  log: write,
  error: (content: any, options: LogOptions = {}) => {
    options.error = true
    write(content, options)
  },
  debug: (content: any, options: LogOptions = {}) => {
    if (process.env.NODE_ENV !== 'development') return
    write(content, options)
  },
  inspect: (...args: any[]) => {
    const options: Record<string, any> = {
      colors: true,
      depth: Infinity
    }
    if (args.length > 1 && typeof args[args.length - 1] === 'object') {
      Object.assign(options, args[args.length - 1])
      args.splice(args.length - 1, 1)
    }
    for (const arg of args) {
      console.log(inspect(arg, options))
    }
  }
}

export = self
