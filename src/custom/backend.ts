import * as core from '@actions/core';
import * as path from 'path';
import { promises as fs } from 'fs';

export async function getArchiveLocation(): Promise<string | undefined> {
  const cacheTopDir = process.env["GHRUNNER_CACHE"] as string;
  if (!cacheTopDir) {
    core.warning('getArchiveLocation: cache not available');
    return undefined;
  }
  const repo = process.env["GITHUB_REPOSITORY"] as string;
  const ref = process.env["GITHUB_REF_NAME"] as string;
  const cacheDir = path.join(cacheTopDir, repo, ref);
  core.debug(`getArchiveLocation: ${cacheDir}`);
  return cacheDir;
}

export async function getCacheFile(
  key: string,
): Promise<string | undefined> {
  const archiveLocation = await getArchiveLocation();
  //core.info(`getCacheFile: archiveLocation = ${archiveLocation}`);
  if (!archiveLocation) {
    return undefined;
  }
  const cacheFile = path.join(archiveLocation, key);
  try {
    const fileStat = await fs.stat(cacheFile);
    if (fileStat.isFile() && fileStat.size > 0) {
      core.debug(`getCacheFile: found ${cacheFile}`);
      return cacheFile;
    } else {
      core.debug(`getCacheFile: ${cacheFile} not found`);
      return undefined;
    }
  } catch (error) {
    core.debug(`getCacheFile: ${error}`);
    core.debug(`getCacheFile: ${cacheFile} not found`);
    return undefined;
  }
}

export async function downloadCache(
  cacheFile: string,
  archivePath: string,
): Promise<void> {
  await fs.copyFile(cacheFile, archivePath);
}

export async function saveCache(
  key: string,
  archivePath: string
): Promise<void> {
  const archiveLocation = await getArchiveLocation();
  //core.info(`saveCache: archiveLocation = ${archiveLocation}`);
  if (archiveLocation) {
    const cacheFile = path.join(archiveLocation, key);
    try {
      const dir = await fs.mkdir(path.dirname(cacheFile), {recursive:true,mode:'0775'});
      core.debug(`saveCache: dir created: ${dir}`);
      await fs.copyFile(archivePath, cacheFile);
      core.debug(`saveCache: saved ${archivePath} to ${cacheFile}`);
    } catch (error) {
      core.warning(`saveCache: failed to save archive: ${error}`);
    }
  }
}
