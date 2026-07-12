// Try to load compiled config first, fall back to direct config file
let config
try {
  config = require('./controllers/utils/ConfigManager')
} catch (e) {
  // If compiled version not found, load config.js directly
  try {
    config = require('./config')
  } catch (e2) {
    console.error('Could not load configuration. Please ensure config.js exists or build the project first.')
    process.exit(1)
  }
}

module.exports = {
  client: config.database.client,
  connection: config.database.connection,
  useNullAsDefault: true,
  migrations: {
    directory: './migrations',
    tableName: 'knex_migrations'
  }
}
