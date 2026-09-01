#!/usr/bin/env node
/**
 * ensure-sharp-linux-deps.js — guarantee linux x64 sharp (and its libvips
 * side-package) are installed before a Linux pack.
 *
 * npm installs only the HOST arch's optional dependency, so building a linux
 * artifact on the same host is usually fine — but CI caches or partial installs
 * can leave them missing, and the app's screenshot/OCR pipeline (`ScreenshotHelper`
 * stitchImages via sharp) dies with "Cannot find module '@img/sharp-linux-x64'".
 *
 * Mirrors ensure-sharp-mac-deps.js but for linux-x64. Only runs on linux.
 * Safe no-op on darwin/win32 (logs Skipping).
 */

const path = require('node:path');
const fs = require('node:fs');

function packageDir(nodeModulesDir, packageName) {
  return path.join(nodeModulesDir, ...packageName.split('/'));
}
function isInstalled(nodeModulesDir, packageName) {
  return fs.existsSync(path.join(packageDir(nodeModulesDir, packageName), 'package.json'));
}

function resolveVersions(lockfile, lockKey, required) {
  const optional = lockfile?.packages?.[lockKey]?.optionalDependencies;
  if (!optional) throw new Error(`Could not find optionalDependencies for "${lockKey}" in package-lock.json.`);
  const versions = {};
  const missing = [];
  for (const name of required) {
    if (!optional[name]) missing.push(name);
    else versions[name] = optional[name];
  }
  if (missing.length) throw new Error(`Missing ${missing.join(', ')} in "${lockKey}" optionalDependencies`);
  return versions;
}

function installPackage({ rootDir, nodeModulesDir, packageName, version }) {
  const { execFileSync } = require('node:child_process');
  const os = require('node:os');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharp-linux-dep-'));
  try {
    const tarball = execFileSync('npm', ['pack', `${packageName}@${version}`, '--silent', '--pack-destination', tempDir], { cwd: rootDir, encoding: 'utf8' }).trim().split('\n').pop();
    const dest = packageDir(nodeModulesDir, packageName);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    execFileSync('tar', ['-xzf', path.join(tempDir, tarball), '-C', dest, '--strip-components=1'], { cwd: rootDir, stdio: 'inherit' });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function ensureLinuxSharpDeps({ platform = process.platform } = {}) {
  const label = 'ensure-sharp-linux-deps';
  const log = (msg) => console.log(`[${label}] ${msg}`);
  if (platform !== 'linux') {
    log('Skipping; linux packages are only needed on linux builds.');
    return { skipped: true };
  }
  const rootDir = path.resolve(__dirname, '..');
  const nodeModulesDir = path.join(rootDir, 'node_modules');
  const lockfile = JSON.parse(fs.readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'));
  const lockKey = 'node_modules/sharp';
  const required = ['@img/sharp-linux-x64', '@img/sharp-libvips-linux-x64'];
  let versions;
  try {
    versions = resolveVersions(lockfile, lockKey, required);
  } catch (e) {
    log(`Skipping — ${e.message} (sharp may not be installed yet)`);
    return { skipped: true };
  }
  const missing = required.filter((n) => !isInstalled(nodeModulesDir, n));
  if (missing.length === 0) {
    log('linux-x64 sharp packages are installed.');
    return { skipped: false, installed: [] };
  }
  log(`Installing missing packages: ${missing.join(', ')}`);
  for (const name of missing) {
    installPackage({ rootDir, nodeModulesDir, packageName: name, version: versions[name] });
  }
  const stillMissing = required.filter((n) => !isInstalled(nodeModulesDir, n));
  if (stillMissing.length) throw new Error(`[${label}] Failed to install: ${stillMissing.join(', ')}`);
  log('linux-x64 sharp packages are installed.');
  return { skipped: false, installed: missing };
}

if (require.main === module) {
  ensureLinuxSharpDeps();
}

module.exports = { ensureLinuxSharpDeps };
