const config = require('./controllers/utils/ConfigManager')

module.exports = {
  client: config.database.client,
  connection: config.database.connection,
  useNullAsDefault: true,
  migrations: {
    directory: './migrations',
    tableName: 'knex_migrations'
  }
}
