const fresh = require('fresh')
const parseRange = require('range-parser')

const BYTES_RANGE_REGEXP = /^ *bytes=/

const self: Record<string, any> = {
  BYTES_RANGE_REGEXP
}

self.isFresh = (req: any, res: any) => {
  return fresh(req.headers, {
    etag: res.get('ETag'),
    'last-modified': res.get('Last-Modified')
  })
}

self.forwardSlashes = (path: string) => {
  return path.split('\\').join('/')
}

self.relativePath = (root: string, path: string) => {
  return self.forwardSlashes(path).replace(root, '')
}

self.isRangeFresh = (req: any, res: any) => {
  const ifRange = req.headers['if-range']

  if (!ifRange) {
    return true
  }

  if (ifRange.indexOf('"') !== -1) {
    const etag = res.get('ETag')
    return Boolean(etag && ifRange.indexOf(etag) !== -1)
  }

  const lastModified = res.get('Last-Modified')
  return self.parseHttpDate(lastModified) <= self.parseHttpDate(ifRange)
}

self.isConditionalGET = (req: any) => {
  return req.headers['if-match'] ||
    req.headers['if-unmodified-since'] ||
    req.headers['if-none-match'] ||
    req.headers['if-modified-since']
}

self.isPreconditionFailure = (req: any, res: any) => {
  const match = req.headers['if-match']
  if (match) {
    const etag = res.get('ETag')
    return !etag || (match !== '*' && self.parseTokenList(match).every((m: string) => {
      return m !== etag && m !== 'W/' + etag && 'W/' + m !== etag
    }))
  }

  const unmodifiedSince = self.parseHttpDate(req.headers['if-unmodified-since'])
  if (!isNaN(unmodifiedSince)) {
    const lastModified = self.parseHttpDate(res.get('Last-Modified'))
    return isNaN(lastModified) || lastModified > unmodifiedSince
  }

  return false
}

self.contentRange = (type: string, size: number, range?: { start: number; end: number }) => {
  return type + ' ' + (range ? range.start + '-' + range.end : '*') + '/' + size
}

self.parseHttpDate = (date: string) => {
  const timestamp = date && Date.parse(date)

  return typeof timestamp === 'number'
    ? timestamp
    : NaN
}

self.parseTokenList = (str: string) => {
  let end = 0
  const list: string[] = []
  let start = 0

  for (let i = 0, len = str.length; i < len; i++) {
    switch (str.charCodeAt(i)) {
      case 0x20:
        if (start === end) {
          start = end = i + 1
        }
        break
      case 0x2c:
        if (start !== end) {
          list.push(str.substring(start, end))
        }
        start = end = i + 1
        break
      default:
        end = i + 1
        break
    }
  }

  if (start !== end) {
    list.push(str.substring(start, end))
  }

  return list
}

self.assertConditionalGET = (req: any, res: any) => {
  if (self.isConditionalGET(req)) {
    if (self.isPreconditionFailure(req, res)) {
      res.status(412)
      return true
    }

    if (self.isFresh(req, res)) {
      res.status(304)
      return true
    }
  }
}

self.buildReadStreamOptions = (req: any, res: any, stat: { size: number }, acceptRanges: boolean) => {
  let length = stat.size
  const options: Record<string, any> = {}
  let ranges: any = req.headers.range
  let offset = 0

  length = Math.max(0, length - offset)
  if (options.end !== undefined) {
    const bytes = options.end - offset + 1
    if (length > bytes) {
      length = bytes
    }
  }

  if (acceptRanges && BYTES_RANGE_REGEXP.test(ranges)) {
    ranges = parseRange(length, ranges, {
      combine: true
    })

    if (!self.isRangeFresh(req, res)) {
      ranges = -2
    }

    if (ranges === -1) {
      res.header('Content-Range', self.contentRange('bytes', length))
      res.status(416)
      return false
    }

    if (ranges !== -2 && ranges.length === 1) {
      res.status(206)
      res.header('Content-Range', self.contentRange('bytes', length, ranges[0]))
      offset += ranges[0].start
      length = ranges[0].end - ranges[0].start + 1
    }
  }

  options.start = offset
  options.end = Math.max(offset, offset + length - 1)

  return { options, length }
}

export = self
