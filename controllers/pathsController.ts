import jetpack = require('fs-jetpack')
import path = require('path')
import config = require('./utils/ConfigManager')

interface VerifyEntry {
  path: string
  criteria?: { empty: boolean }
}

interface PathsSelf {
  uploads: string
  chunks: string
  thumbs: string
  zips: string
  thumbPlaceholder: string
  logs: string
  customPages: string
  dist: string
  public: string
  errorRoot: string
  initSync: () => void
}

const self: PathsSelf = {} as PathsSelf

self.uploads = path.resolve(config.uploads.folder)
self.chunks = config.uploads.chunksFolder
  ? path.resolve(config.uploads.chunksFolder)
  : path.join(self.uploads, 'chunks')
self.thumbs = path.join(self.uploads, 'thumbs')
self.zips = path.join(self.uploads, 'zips')

self.thumbPlaceholder = path.resolve(config.uploads.generateThumbs.placeholder || 'public/images/unavailable.png')

self.logs = path.resolve(config.logsFolder)

self.customPages = path.resolve('pages/custom')
self.dist = process.env.NODE_ENV === 'development'
  ? path.resolve('dist-dev')
  : path.resolve('dist')
self.public = path.resolve('public')

self.errorRoot = path.resolve(config.errorPages.rootDir)

const verify: (string | VerifyEntry)[] = [
  self.uploads,
  {
    path: self.chunks,
    criteria: { empty: true }
  },
  self.thumbs,
  self.zips,
  self.logs,
  self.customPages
]

if (['better-sqlite3', 'sqlite3'].includes(config.database.client)) {
  verify.unshift(path.resolve('database'))
}

self.initSync = (): void => {
  for (const obj of verify) {
    if (typeof obj === 'object') {
      jetpack.dir(obj.path, obj.criteria)
    } else {
      jetpack.dir(obj)
    }
  }
}

export = self
