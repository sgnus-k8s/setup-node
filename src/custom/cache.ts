// https://github.com/actions/toolkit/blob/main/packages/cache/src/cache.ts

import * as core from '@actions/core';
import * as path from 'path';
import * as utils from './utils.js';
import * as backend from './backend.js';

// from https://github.com/actions/toolkit/blob/main/packages/cache/src/options.ts
//
/**
 * Options to control cache upload
 */
export interface UploadOptions {
  /**
   * Indicates whether to use the Azure Blob SDK to download caches
   * that are stored on Azure Blob Storage to improve reliability and
   * performance
   *
   * @default false
   */
  useAzureSdk?: boolean
  /**
   * Number of parallel cache upload
   *
   * @default 4
   */
  uploadConcurrency?: number
  /**
   * Maximum chunk size in bytes for cache upload
   *
   * @default 32MB
   */
  uploadChunkSize?: number
  /**
   * Archive size in bytes
   */
  archiveSizeBytes?: number
}

/**
 * Options to control cache download
 */
export interface DownloadOptions {
  /**
   * Indicates whether to use the Azure Blob SDK to download caches
   * that are stored on Azure Blob Storage to improve reliability and
   * performance
   *
   * @default true
   */
  useAzureSdk?: boolean

  /**
   * Number of parallel downloads (this option only applies when using
   * the Azure SDK)
   *
   * @default 8
   */
  downloadConcurrency?: number

  /**
   * Indicates whether to use Actions HttpClient with concurrency
   * for Azure Blob Storage
   */
  concurrentBlobDownloads?: boolean

  /**
   * Maximum time for each download request, in milliseconds (this
   * option only applies when using the Azure SDK)
   *
   * @default 30000
   */
  timeoutInMs?: number

  /**
   * Time after which a segment download should be aborted if stuck
   *
   * @default 3600000
   */
  segmentTimeoutInMs?: number

  /**
   * Weather to skip downloading the cache entry.
   * If lookupOnly is set to true, the restore function will only check if
   * a matching cache entry exists and return the cache key if it does.
   *
   * @default false
   */
  lookupOnly?: boolean
}


export const CacheFileSizeLimit = 10 * Math.pow(1024, 3) // 10GiB

/**
 * isFeatureAvailable to check the presence of Actions cache service
 *
 * @returns boolean return true if Actions cache service feature is available, otherwise false
 */
export function isFeatureAvailable(): boolean {
  return !!process.env['GHRUNNER_CACHE']
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

function checkPaths(paths: string[]): void {
  if (!paths || paths.length === 0) {
    throw new ValidationError(
      `Path Validation Error: At least one directory or file path is required`
    );
  }
}

function checkKey(key: string): void {
  if (key.length > 512) {
    throw new ValidationError(
      `Key Validation Error: ${key} cannot be larger than 512 characters.`
    );
  }
  const regex = /^[^,]*$/;
  if (!regex.test(key)) {
    throw new ValidationError(
      `Key Validation Error: ${key} cannot contain commas.`
    );
  }
}

/**
 * Restores cache from keys
 *
 * @param paths a list of file paths to restore from the cache
 * @param primaryKey an explicit key for restoring the cache
 * @param restoreKeys an optional ordered list of keys to use for restoring the cache if no cache hit occurred for key
 * @param downloadOptions cache download options
 * @param enableCrossOsArchive an optional boolean enabled to restore on windows any cache created on any platform
 * @returns string returns the key for the cache hit, otherwise returns undefined
 */
export async function restoreCache(
  paths: string[],
  primaryKey: string,
  restoreKeys?: string[],
  options?: DownloadOptions,
  enableCrossOsArchive = false
): Promise<string | undefined> {
  checkPaths(paths);
  restoreKeys = restoreKeys || [];
  const keys = [primaryKey, ...restoreKeys];
  core.debug('Resolved Keys:');
  core.debug(JSON.stringify(keys));
  if (keys.length > 10) {
    throw new ValidationError(
      `Key Validation Error: Keys are limited to a maximum of 10.`
    );
  }
  for (const key of keys) {
    checkKey(key);
  }

  let archivePath = '';
  const cacheFile = await backend.getCacheFile(primaryKey);
  if (!cacheFile) {
    core.debug(
      `Cache not found for key: ${primaryKey}`
    )
    return undefined;
  }

  core.info(`Cache hit for: ${primaryKey}`);
  if (options?.lookupOnly) {
    core.info('Lookup only - skipping download');
    return primaryKey;
  }

  const compressionMethod = await utils.getCompressionMethod();
  archivePath = path.join(
    await utils.createTempDirectory(),
    utils.getCacheFileName(compressionMethod)
  );
  core.debug(`Archive Path: ${archivePath}`);

  // Download the cache from the cache entry
  try {
    await backend.downloadCache(
      cacheFile,
      archivePath
    );
    const archiveFileSize = utils.getArchiveFileSizeInBytes(archivePath);
    core.info(
      `Cache Size: ~${Math.round(
          archiveFileSize / (1024 * 1024)
      )} MB (${archiveFileSize} B)`
    );

    if (core.isDebug()) {
      await utils.listTar(archivePath, compressionMethod);
    }

    await utils.extractTar(archivePath, compressionMethod);
    core.info('Cache restored successfully');
    return primaryKey;
  } catch (error) {
    core.warning(`Failed to restore: ${(error as Error).message}`);
    return undefined;
  } finally {
    // Try to delete the archive to save space
    try {
      await utils.unlinkFile(archivePath);
    } catch (error) {
      core.debug(`Failed to delete archive: ${error}`);
    }
  }

  return undefined;
}


/**
 * Saves a list of files with the specified key
 *
 * @param paths a list of file paths to be cached
 * @param key an explicit key for restoring the cache
 * @param options cache upload options
 * @param enableCrossOsArchive an optional boolean enabled to save cache on windows which could be restored on any platform
 * @returns number returns cacheId if the cache was saved successfully and throws an error if save fails
 */
export async function saveCache(
  paths: string[],
  key: string,
  options?: UploadOptions,
  enableCrossOsArchive = false
): Promise<number> {
  checkPaths(paths);
  checkKey(key);
  const compressionMethod = await utils.getCompressionMethod();
  let cacheId = -1;

  const cachePaths = await utils.resolvePaths(paths);
  core.debug('Cache Paths:');
  core.debug(`${JSON.stringify(cachePaths)}`);
  if (cachePaths.length === 0) {
    throw new Error(
      `Path Validation Error: Path(s) specified in the action for caching do(es) not exist, hence no cache is being saved.`
    );
  }

  const archiveFolder = await utils.createTempDirectory();
  const archivePath = path.join(
    archiveFolder,
    utils.getCacheFileName(compressionMethod)
  );
  core.debug(`Archive Path: ${archivePath}`);

  try {
    await utils.createTar(archiveFolder, cachePaths, compressionMethod);
    if (core.isDebug()) {
      await utils.listTar(archivePath, compressionMethod);
    }

    // check file size
    const archiveFileSize = utils.getArchiveFileSizeInBytes(archivePath);
    core.debug(`File Size: ${archiveFileSize}`);
    if (archiveFileSize > CacheFileSizeLimit) {
      throw new Error(
        `Cache size of ~${Math.round(
          archiveFileSize / (1024 * 1024)
        )} MB (${archiveFileSize} B) is over the ${Math.round(
          CacheFileSizeLimit / (1024 * 1024)
        )} MB (${CacheFileSizeLimit} B) limit, not saving cache.`
      )
    }

    await backend.saveCache(key, archivePath);
    // dummy cacheId, if we get there without raising, it means the cache has been saved
    cacheId = 1;
  } catch (error) {
    const typedError = error as Error;
    if (typedError.name === ValidationError.name) {
      throw error;
    } else {
      core.warning(`Failed to save: ${typedError.message}`);
    }
  } finally {
    // Try to delete the archive to save space
    try {
      await utils.unlinkFile(archivePath);
    } catch (error) {
      core.debug(`Failed to delete archive: ${error}`);
    }
  }

  return cacheId;
}

