const config = require('./../../config')
const logger = require('./../../logger')

interface ConfigOverride {
  key: string
  type?: 'boolean' | 'number'
  default?: any
}

const overrides: Record<string, ConfigOverride | string> = {
  PRIVATE: {
    key: 'private',
    type: 'boolean'
  },
  ENABLE_USER_ACCOUNTS: {
    key: 'enableUserAccounts',
    type: 'boolean'
  },
  SERVE_FILES_WITH_NODE: {
    key: 'serveFilesWithNode',
    type: 'boolean'
  },
  PORT: {
    key: 'port',
    type: 'number'
  },
  DOMAIN: 'domain',
  HOME_DOMAIN: 'homeDomain',
  TRUST_PROXY: {
    key: 'trustProxy',
    type: 'boolean'
  },
  SERVE_STATIC_QUICK: {
    key: 'useServeStaticQuick',
    type: 'boolean',
    default: true
  }
}

const self: Record<string, any> = {}

// Load from config file
for (const key of Object.keys(config)) {
  self[key] = config[key]
}

// Parse environment variables overrides
for (const name of Object.keys(overrides)) {
  if (typeof overrides[name] === 'object') {
    const override = overrides[name] as ConfigOverride
    const key = override.key

    if (override.type === 'boolean') {
      switch (process.env[name]) {
        case '0':
        case 'false':
          self[key] = false
          break
        case '1':
        case 'true':
          self[key] = true
          break
      }
    } else if (override.type === 'number') {
      if (process.env[name] !== undefined) {
        self[key] = parseInt(process.env[name]!, 10)
      }
    } else {
      if (process.env[name] !== undefined) {
        self[key] = process.env[name]
      }
    }

    if (self[key] === undefined && override.default !== undefined) {
      self[key] = override.default
    }
  } else if (typeof overrides[name] === 'string') {
    const key = overrides[name] as string

    if (process.env[name] !== undefined) {
      self[key] = process.env[name]
    }
  } else {
    logger.debug(`Invalid config override key: ${name}`)
  }
}

logger.debug('ConfigManager initiated.')

export = self
