'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const windows = process.platform === 'win32';
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";

function ps(script, options = {}) {
  return spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', ...options });
}

test('setup fails on missing dependencies instead of reporting success', () => {
  const binaries = path.join(root, 'lib', 'binaries.js');
  const script = path.join(root, 'scripts', 'postinstall.js');
  const result = spawnSync(process.execPath, ['-e', `
    require.cache[${JSON.stringify(binaries)}] = { exports: {
      downloadYtDlp: async () => { throw new Error('test download failure'); },
      ensureFfmpeg: async () => {}
    }};
    process.argv.push('--strict');
    require(${JSON.stringify(script)});
  `], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /test download failure/);
  assert.match(result.stderr, /Setup failed/);
  assert.doesNotMatch(result.stderr, /first time you run/);
});

test('Windows PATH registration persists even when the installer already inherited the directory', { skip: !windows }, () => {
  const result = ps(`
    . ${quote(path.join(root, 'setup.ps1'))}
    $env:CLI_TEST_ROOT = 'C:\\Users\\Example User'
    $value = Get-UpdatedPath 'C:\\Other;"%CLI_TEST_ROOT%\\App\\command\\";C:\\Keep' 'C:\\Users\\Example User\\App\\command'
    if ($value -cne 'C:\\Users\\Example User\\App\\command;C:\\Other;C:\\Keep') { throw $value }
    if ((Get-UpdatedPath '' 'C:\\App\\command') -cne 'C:\\App\\command') { throw 'Empty PATH failed' }
    if ((Get-UpdatedPath 'c:\\APP\\COMMAND;C:\\Other' 'C:\\App\\command') -cne 'C:\\App\\command;C:\\Other') { throw 'Case-insensitive deduplication failed' }
  `);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('Windows launchers work without Node or npm on PATH, under restricted policy, and preserve arguments and exit codes', { skip: !windows }, () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "cli space & \u00e9 ' test-"));
  try {
    const command = path.join(fixture, 'command');
    fs.mkdirSync(path.join(fixture, 'runtime'));
    fs.mkdirSync(path.join(fixture, 'bin'));
    fs.copyFileSync(process.execPath, path.join(fixture, 'runtime', 'node.exe'));
    fs.writeFileSync(path.join(fixture, 'bin', 'cli-test.js'),
      'console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = process.argv.includes("--fail") ? 7 : 0;\n');
    const setup = ps(`. ${quote(path.join(root, 'setup.ps1'))}; Write-Launchers ${quote(command)} 'cli-test'`);
    assert.equal(setup.status, 0, setup.stdout + setup.stderr);
    const env = { ...process.env, Path: `${command};${process.env.SystemRoot}\\System32` };
    // Windows environment keys are case-insensitive; do not pass two PATH variants.
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path' && key !== 'Path') delete env[key];
    const cmd = spawnSync(process.env.ComSpec, ['/d', '/c', 'cli-test "two words" --fail'], { env, encoding: 'utf8', cwd: os.tmpdir(), windowsVerbatimArguments: true });
    assert.equal(cmd.status, 7, cmd.stdout + cmd.stderr);
    assert.deepEqual(JSON.parse(cmd.stdout.trim()), ['two words', '--fail']);
    const shell = ps('Set-ExecutionPolicy Restricted -Scope Process -Force; & cli-test "two words"; exit $LASTEXITCODE', { env, cwd: os.tmpdir() });
    assert.equal(shell.status, 0, shell.stdout + shell.stderr);
    assert.deepEqual(JSON.parse(shell.stdout.trim()), ['two words']);
    const activation = spawnSync(process.env.ComSpec, ['/d', '/c', `call "${path.join(command, 'activate.cmd')}" & cli-test activated`],
      { env: { ...env, Path: `${process.env.SystemRoot}\\System32` }, encoding: 'utf8', cwd: os.tmpdir(), windowsVerbatimArguments: true });
    assert.equal(activation.status, 0, activation.stdout + activation.stderr);
    assert.deepEqual(JSON.parse(activation.stdout.trim()), ['activated']);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
