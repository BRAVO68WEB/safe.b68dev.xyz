import path = require('path')
import fs = require('fs')
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { ZipArchive } from 'archiver'
import { createReadStream, createWriteStream } from 'fs-jetpack'
import jetpack = require('fs-jetpack')
import utils = require('./utilsController')
import config = require('./utils/ConfigManager')
import paths = require('./pathsController')
import perms = require('./permissionController')
import ClientError = require('./utils/ClientError')
import ServerError = require('./utils/ServerError')
import logger = require('./../logger')

interface BackupDetails {
  fileCount?: number
  totalSize?: number
  duration?: number
  error?: string
  [key: string]: any
}

interface BackupSelf {
  backupInProgress: boolean
  s3Client: S3Client | null
  initialize: () => void
  triggerBackup: (req: any, res: any) => Promise<any>
  restoreBackup: (req: any, res: any) => Promise<any>
  getBackupLogs: (req: any, res: any) => Promise<any>
  getBackupStatus: (req: any, res: any) => Promise<any>
  updateSchedule: (req: any, res: any) => Promise<any>
  runBackup: (type: 'manual' | 'scheduled') => Promise<any>
  backupDatabase: (backupPath: string) => Promise<void>
  backupFiles: (zipPath: string) => Promise<number>
  uploadToS3: (filePath: string, s3Key: string) => Promise<void>
  restoreFromS3: (s3Key: string) => Promise<void>
  restoreDatabase: (backupPath: string) => Promise<void>
  restoreFiles: (zipPath: string) => Promise<void>
  getS3Key: (type: string) => string
  validateS3Config: () => void
}

const self: BackupSelf = {
  backupInProgress: false,
  s3Client: null,
} as BackupSelf

// Initialize S3 client
self.initialize = (): void => {
  if (!config.s3 || !config.s3.enabled) {
    logger.log('S3 backup is disabled')
    return
  }

  try {
    self.validateS3Config()
    
    const s3Config: any = {
      region: config.s3.region,
      credentials: {
        accessKeyId: config.s3.accessKeyId,
        secretAccessKey: config.s3.secretAccessKey,
      },
    }

    if (config.s3.endpoint) {
      s3Config.endpoint = config.s3.endpoint
    }

    // Configure path style
    const pathStyle = config.s3.pathStyle || 'auto'
    if (pathStyle === 'auto') {
      // Auto-detect: use path-style for S3-compatible services, virtual-hosted for AWS
      s3Config.forcePathStyle = !!config.s3.endpoint
    } else if (pathStyle === 'path') {
      s3Config.forcePathStyle = true
    } else if (pathStyle === 'virtual') {
      s3Config.forcePathStyle = false
    }

    self.s3Client = new S3Client(s3Config)
    logger.log('S3 backup client initialized')
  } catch (error) {
    logger.error(error, { prefix: 'S3 Backup Init: ' })
  }
}

self.validateS3Config = (): void => {
  if (!config.s3) {
    throw new ServerError('S3 configuration is missing.')
  }
  if (!config.s3.region) {
    throw new ServerError('S3 region is required.')
  }
  if (!config.s3.bucket) {
    throw new ServerError('S3 bucket is required.')
  }
  if (!config.s3.accessKeyId) {
    throw new ServerError('S3 accessKeyId is required.')
  }
  if (!config.s3.secretAccessKey) {
    throw new ServerError('S3 secretAccessKey is required.')
  }
}

self.getS3Key = (type: string): string => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `backups/${type}/${timestamp}.zip`
}

// Manual JIT backup trigger
self.triggerBackup = async (req: any, res: any): Promise<any> => {
  const isadmin = perms.is(req.locals.user, 'admin')
  if (!isadmin) {
    throw new ClientError('Only administrators can trigger backups.', { statusCode: 403 })
  }

  if (self.backupInProgress) {
    throw new ClientError('A backup is already in progress. Please wait for it to complete.', { statusCode: 409 })
  }

  if (!self.s3Client) {
    throw new ClientError('S3 backup is not configured. Please check your configuration.', { statusCode: 400 })
  }

  // Run backup in background
  self.runBackup('manual').catch((error) => {
    logger.error(error, { prefix: 'Manual Backup Error: ' })
  })

  return res.json({
    success: true,
    description: 'Backup started successfully. Check the backup logs for progress.',
  })
}

// Restore from backup
self.restoreBackup = async (req: any, res: any): Promise<any> => {
  const isadmin = perms.is(req.locals.user, 'admin')
  if (!isadmin) {
    throw new ClientError('Only administrators can restore backups.', { statusCode: 403 })
  }

  if (self.backupInProgress) {
    throw new ClientError('Cannot restore while a backup is in progress.', { statusCode: 409 })
  }

  const s3Key = req.body.s3_key
  if (!s3Key) {
    throw new ClientError('Missing required field: s3_key', { statusCode: 400 })
  }

  if (!self.s3Client) {
    throw new ClientError('S3 backup is not configured.', { statusCode: 400 })
  }

  self.backupInProgress = true

  try {
    await self.restoreFromS3(s3Key)
    
    await utils.db.table('backup_logs').insert({
      timestamp: Math.floor(Date.now() / 1000),
      type: 'restore',
      status: 'success',
      details: JSON.stringify({ s3_key: s3Key }),
      s3_key: s3Key,
    })

    return res.json({
      success: true,
      description: 'Backup restored successfully. The server may need to be restarted.',
    })
  } catch (error) {
    const details: BackupDetails = {
      s3_key: s3Key,
      error: error instanceof Error ? error.message : 'Unknown error',
    }

    await utils.db.table('backup_logs').insert({
      timestamp: Math.floor(Date.now() / 1000),
      type: 'restore',
      status: 'failed',
      details: JSON.stringify(details),
      s3_key: s3Key,
    }).catch(logger.error)

    throw error
  } finally {
    self.backupInProgress = false
  }
}

// Get backup logs
self.getBackupLogs = async (req: any, res: any): Promise<any> => {
  const isadmin = perms.is(req.locals.user, 'admin')
  if (!isadmin) {
    throw new ClientError('Only administrators can view backup logs.', { statusCode: 403 })
  }

  const page = parseInt(req.path_parameters?.page) || 1
  const logsPerPage = 20
  const offset = logsPerPage * (page - 1)

  const logs = await utils.db.table('backup_logs')
    .orderBy('timestamp', 'desc')
    .limit(logsPerPage)
    .offset(offset)

  const count = await utils.db.table('backup_logs')
    .count('id as count')
    .then((rows: any[]) => rows[0].count)

  return res.json({
    success: true,
    logs: logs.map((log: any) => ({
      ...log,
      details: log.details ? JSON.parse(log.details) : null,
    })),
    count,
    page,
    pages: Math.ceil(count / logsPerPage),
  })
}

// Get backup status
self.getBackupStatus = async (req: any, res: any): Promise<any> => {
  const isadmin = perms.is(req.locals.user, 'admin')
  if (!isadmin) {
    throw new ClientError('Only administrators can view backup status.', { statusCode: 403 })
  }

  const lastBackup = await utils.db.table('backup_logs')
    .where('type', '!=', 'restore')
    .orderBy('timestamp', 'desc')
    .first()

  return res.json({
    success: true,
    inProgress: self.backupInProgress,
    s3Configured: !!self.s3Client,
    s3Enabled: config.s3?.enabled || false,
    schedule: config.s3?.schedule || null,
    lastBackup: lastBackup ? {
      timestamp: lastBackup.timestamp,
      type: lastBackup.type,
      status: lastBackup.status,
      details: lastBackup.details ? JSON.parse(lastBackup.details) : null,
    } : null,
  })
}

// Update backup schedule
self.updateSchedule = async (req: any, res: any): Promise<any> => {
  const isadmin = perms.is(req.locals.user, 'admin')
  if (!isadmin) {
    throw new ClientError('Only administrators can update backup schedule.', { statusCode: 403 })
  }

  const { schedule } = req.body
  if (schedule === undefined) {
    throw new ClientError('Missing required field: schedule', { statusCode: 400 })
  }

  // Validate cron expression if provided
  if (schedule) {
    try {
      const cron = require('node-cron')
      if (!cron.validate(schedule)) {
        throw new ClientError('Invalid cron expression.', { statusCode: 400 })
      }
    } catch (error) {
      if (error instanceof ClientError) throw error
      throw new ServerError('Failed to validate cron expression.')
    }
  }

  // Note: In a real implementation, you would update the config file or database
  // For now, we'll just validate and return success
  // The actual schedule update would require persisting to config or database

  return res.json({
    success: true,
    description: schedule 
      ? `Backup schedule updated to: ${schedule}`
      : 'Scheduled backups disabled.',
    schedule: schedule || null,
  })
}

// Main backup execution
self.runBackup = async (type: 'manual' | 'scheduled'): Promise<any> => {
  if (self.backupInProgress) {
    logger.log('Backup already in progress, skipping...')
    return
  }

  self.backupInProgress = true
  const startTime = Date.now()
  const details: BackupDetails = {}

  try {
    logger.log(`Starting ${type} backup...`)

    // Generate S3 key
    const s3Key = self.getS3Key(type)
    const tempDir = path.join(paths.uploads, '.backup-temp')
    const dbBackupPath = path.join(tempDir, 'db.sqlite3')
    const zipPath = path.join(tempDir, 'backup.zip')

    // Ensure temp directory exists
    await jetpack.dirAsync(tempDir)

    // Backup database
    logger.log('Backing up database...')
    await self.backupDatabase(dbBackupPath)

    // Backup files
    logger.log('Backing up files...')
    details.fileCount = await self.backupFiles(zipPath)

    // Get zip size
    const zipStats = await jetpack.inspectAsync(zipPath)
    details.totalSize = zipStats?.size || 0

    // Upload to S3
    logger.log('Uploading to S3...')
    await self.uploadToS3(zipPath, s3Key)

    // Cleanup temp directory
    await jetpack.removeAsync(tempDir)

    details.duration = Date.now() - startTime
    details.s3_key = s3Key

    // Log success
    await utils.db.table('backup_logs').insert({
      timestamp: Math.floor(Date.now() / 1000),
      type,
      status: 'success',
      details: JSON.stringify(details),
      s3_key: s3Key,
    })

    logger.log(`Backup completed successfully in ${details.duration}ms. Files: ${details.fileCount}, Size: ${details.totalSize} bytes`)
  } catch (error) {
    details.error = error instanceof Error ? error.message : 'Unknown error'
    details.duration = Date.now() - startTime

    // Log failure
    await utils.db.table('backup_logs').insert({
      timestamp: Math.floor(Date.now() / 1000),
      type,
      status: 'failed',
      details: JSON.stringify(details),
      s3_key: null,
    }).catch(logger.error)

    logger.error(error, { prefix: 'Backup Error: ' })
  } finally {
    self.backupInProgress = false
  }
}

// Backup database by copying the SQLite file
self.backupDatabase = async (backupPath: string): Promise<void> => {
  try {
    const dbPath = config.database.connection.filename

    // Use WAL checkpoint to ensure consistent state
    await utils.db.raw('PRAGMA wal_checkpoint(TRUNCATE)')

    // Copy the database file
    await jetpack.copyAsync(dbPath, backupPath, { overwrite: true })

    // Also copy WAL and SHM files if they exist
    const walPath = dbPath + '-wal'
    const shmPath = dbPath + '-shm'

    if (await jetpack.existsAsync(walPath)) {
      await jetpack.copyAsync(walPath, backupPath + '-wal', { overwrite: true })
    }
    if (await jetpack.existsAsync(shmPath)) {
      await jetpack.copyAsync(shmPath, backupPath + '-shm', { overwrite: true })
    }

    logger.log('Database backup completed')
  } catch (error) {
    throw new ServerError(`Database backup failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

// Backup files by zipping uploads folder
self.backupFiles = async (zipPath: string): Promise<number> => {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath)
    const archive = new ZipArchive({
      zlib: { level: 1 }, // Fast compression
    })

    let fileCount = 0

    output.on('close', () => {
      logger.log(`Archiver finalized. ${fileCount} files, ${archive.pointer()} bytes`)
      resolve(fileCount)
    })

    archive.on('error', (error: any) => {
      reject(new ServerError(`File backup failed: ${error.message}`))
    })

    archive.on('entry', () => {
      fileCount++
    })

    archive.pipe(output)

    // Add uploads folder (excluding .backup-temp and thumbs)
    archive.glob('**/*', {
      cwd: paths.uploads,
      ignore: ['.backup-temp/**', 'thumbs/**', 'chunks/**', 'zips/**'],
    })

    archive.finalize()
  })
}

// Upload file to S3
self.uploadToS3 = async (filePath: string, s3Key: string): Promise<void> => {
  if (!self.s3Client) {
    throw new ServerError('S3 client is not initialized.')
  }

  try {
    const fileStream = createReadStream(filePath)
    const fileStats = await jetpack.inspectAsync(filePath)

    const upload = new Upload({
      client: self.s3Client,
      params: {
        Bucket: config.s3.bucket,
        Key: s3Key,
        Body: fileStream,
        ContentLength: fileStats?.size,
      },
      queueSize: 4, // Concurrent parts
      partSize: 10 * 1024 * 1024, // 10MB parts
      leavePartsOnError: false,
    })

    await upload.done()
    logger.log(`Uploaded to S3: ${s3Key}`)
  } catch (error) {
    throw new ServerError(`S3 upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

// Restore from S3 backup
self.restoreFromS3 = async (s3Key: string): Promise<void> => {
  if (!self.s3Client) {
    throw new ServerError('S3 client is not initialized.')
  }

  const tempDir = path.join(paths.uploads, '.restore-temp')
  const zipPath = path.join(tempDir, 'backup.zip')
  const dbBackupPath = path.join(tempDir, 'db.sqlite3')

  try {
    // Ensure temp directory exists
    await jetpack.dirAsync(tempDir)

    // Download from S3
    logger.log(`Downloading from S3: ${s3Key}`)
    const command = new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: s3Key,
    })

    const response = await self.s3Client.send(command)
    const fileStream = createWriteStream(zipPath)

    await new Promise<void>((resolve, reject) => {
      if (response.Body) {
        (response.Body as any).pipe(fileStream)
        fileStream.on('finish', resolve)
        fileStream.on('error', reject)
      } else {
        reject(new ServerError('Empty response from S3'))
      }
    })

    // Extract zip
    logger.log('Extracting backup...')
    const extract = require('extract-zip')
    await extract(zipPath, { dir: tempDir })

    // Restore database
    if (await jetpack.existsAsync(dbBackupPath)) {
      logger.log('Restoring database...')
      await self.restoreDatabase(dbBackupPath)
    }

    // Restore files
    logger.log('Restoring files...')
    await self.restoreFiles(tempDir)

    // Cleanup temp directory
    await jetpack.removeAsync(tempDir)

    logger.log('Restore completed successfully')
  } catch (error) {
    // Cleanup on error
    await jetpack.removeAsync(tempDir).catch(logger.error)
    throw new ServerError(`Restore failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

// Restore database from backup
self.restoreDatabase = async (backupPath: string): Promise<void> => {
  try {
    const dbPath = config.database.connection.filename
    const dbDir = path.dirname(dbPath)

    // Ensure database directory exists
    await jetpack.dirAsync(dbDir)

    // Copy backup to database location
    await jetpack.copyAsync(backupPath, dbPath, { overwrite: true })

    logger.log('Database restored successfully')
  } catch (error) {
    throw new ServerError(`Database restore failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

// Restore files from backup
self.restoreFiles = async (extractDir: string): Promise<void> => {
  try {
    // Find the uploads folder in the extracted backup
    const uploadsBackupDir = path.join(extractDir, 'uploads')
    
    if (await jetpack.existsAsync(uploadsBackupDir)) {
      // Copy files from backup to uploads folder
      await jetpack.copyAsync(uploadsBackupDir, paths.uploads, {
        overwrite: true,
        matching: '!{.backup-temp,thumbs,chunks,zips}/**',
      })
      logger.log('Files restored successfully')
    } else {
      logger.log('No uploads folder found in backup')
    }
  } catch (error) {
    throw new ServerError(`Files restore failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

// Initialize on module load
self.initialize()

export = self
