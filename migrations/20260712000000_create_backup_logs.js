/**
 * Create backup_logs table for tracking S3 backup operations.
 */
exports.up = async function (knex) {
  const hasBackupLogs = await knex.schema.hasTable('backup_logs')
  if (!hasBackupLogs) {
    await knex.schema.createTable('backup_logs', table => {
      table.increments()
      table.integer('timestamp').notNullable()
      table.string('type').notNullable() // 'manual' or 'scheduled'
      table.string('status').notNullable() // 'success' or 'failed'
      table.text('details') // JSON string with file count, size, duration, error message
      table.string('s3_key') // Path to backup in S3
    })
  }
}

exports.down = async function (knex) {
  const hasBackupLogs = await knex.schema.hasTable('backup_logs')
  if (hasBackupLogs) {
    await knex.schema.dropTable('backup_logs')
  }
}
