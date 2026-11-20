/**
 * Pack this repository into `destination` and return the tarball path and its
 * file list. The tarball name is read from npm's plain output (its last line)
 * and the contents from the tarball itself, because the shape of `--json`
 * output differs between npm versions.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function pack(destination) {
  const { stdout } = await exec('npm', ['pack', '--pack-destination', destination], { cwd: repo });
  const filename = stdout.trim().split('\n').at(-1).trim();
  const tarball = path.join(destination, filename);
  const listing = await exec('tar', ['-tzf', tarball]);
  const files = listing.stdout.trim().split('\n').map((entry) => entry.replace(/^package\//, ''));
  return { tarball, filename, files };
}
