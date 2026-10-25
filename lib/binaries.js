'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { execFileSync } = require('child_process');

const VENDOR_DIR = path.join(__dirname, '..', 'vendor');
const FFMPEG_DIR = path.join(VENDOR_DIR, 'ffmpeg');
const EXE = process.platform === 'win32' ? '.exe' : '';

const YTDLP_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const FFMPEG_STATIC_BASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1';
const FFMPEG_BUILDS_BASE = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest';

function isMusl() {
  try {
    return fs.readdirSync('/lib').some((f) => f.startsWith('ld-musl'));
  } catch {
    return false;
  }
}

function ytDlpAssetName() {
  const { platform, arch } = process;
  if (platform === 'win32') {
    if (arch === 'arm64') return 'yt-dlp_arm64.exe';
    if (arch === 'ia32') return 'yt-dlp_x86.exe';
    return 'yt-dlp.exe';
  }
  if (platform === 'darwin') return 'yt-dlp_macos';
  if (platform === 'linux') {
    const musl = isMusl();
    if (arch === 'arm64') return musl ? 'yt-dlp_musllinux_aarch64' : 'yt-dlp_linux_aarch64';
    if (arch === 'x64') return musl ? 'yt-dlp_musllinux' : 'yt-dlp_linux';
  }
  // Fallback: the zipapp needs a system Python 3 but works everywhere else.
  return 'yt-dlp';
}

function ytDlpPath() {
  return path.join(VENDOR_DIR, `yt-dlp${EXE}`);
}

function ffmpegDir() {
  return FFMPEG_DIR;
}

function hasFfmpeg() {
  return fs.existsSync(path.join(FFMPEG_DIR, `ffmpeg${EXE}`)) && fs.existsSync(path.join(FFMPEG_DIR, `ffprobe${EXE}`));
}

async function fetchOk(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'video2mp4-installer' } });
  if (!res.ok) throw new Error(`Download failed (${res.status} ${res.statusText}): ${url}`);
  return res;
}

async function fetchText(url) {
  return (await fetchOk(url)).text();
}

function progressStream(label, total, log) {
  let done = 0;
  let lastPct = -1;
  const tty = process.stdout.isTTY;
  return new Transform({
    transform(chunk, _enc, cb) {
      done += chunk.length;
      if (total) {
        const pct = Math.floor((done / total) * 100);
        if (pct !== lastPct && (tty || pct % 25 === 0)) {
          lastPct = pct;
          const msg = `${label} ${pct}% (${(done / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB)`;
          if (tty) process.stdout.write(`\r\x1b[K${msg}`);
          else log(msg);
        }
      }
      cb(null, chunk);
    },
    flush(cb) {
      if (tty) process.stdout.write('\r\x1b[K');
      cb();
    },
  });
}

/** Streams url -> dest (optionally gunzipping) and returns the sha256 of the downloaded bytes. */
async function downloadTo(url, dest, { gunzip = false, label, log = console.log } = {}) {
  const res = await fetchOk(url);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  const hasher = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  const tmp = `${dest}.${process.pid}.part`;
  const stages = [Readable.fromWeb(res.body), progressStream(label || path.basename(dest), total, log), hasher];
  if (gunzip) stages.push(zlib.createGunzip());
  stages.push(fs.createWriteStream(tmp, { mode: 0o755 }));
  try {
    await pipeline(stages);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return { tmp, sha256: hash.digest('hex') };
}

function lookupChecksum(sums, name) {
  const row = sums
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file && file.replace(/^\*/, '') === name);
  return row ? row[0].toLowerCase() : null;
}

function finalize(tmp, dest) {
  fs.renameSync(tmp, dest);
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
}

async function downloadYtDlp({ log = console.log } = {}) {
  const asset = ytDlpAssetName();
  log(`Downloading yt-dlp (${asset}) ...`);
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  const sums = await fetchText(`${YTDLP_BASE}/SHA2-256SUMS`);
  const dest = ytDlpPath();
  const { tmp, sha256 } = await downloadTo(`${YTDLP_BASE}/${asset}`, dest, { label: 'yt-dlp', log });
  if (lookupChecksum(sums, asset) !== sha256) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`Checksum verification failed for ${asset}.`);
  }
  finalize(tmp, dest);
  log(`yt-dlp installed: ${dest}`);
  return dest;
}

function ffmpegSource() {
  const { platform, arch } = process;
  if (platform === 'win32' && (arch === 'arm64' || arch === 'ia32')) {
    const name = arch === 'arm64' ? 'winarm64' : 'win32';
    return { kind: 'zip', asset: `ffmpeg-master-latest-${name}-gpl-shared.zip` };
  }
  const supported = {
    darwin: ['x64', 'arm64'],
    linux: ['x64', 'arm64', 'arm', 'ia32'],
    win32: ['x64'],
  };
  if (supported[platform] && supported[platform].includes(arch)) {
    return { kind: 'gz', suffix: `${platform}-${arch}` };
  }
  throw new Error(`No bundled ffmpeg build is available for ${platform}-${arch}.`);
}

async function downloadFfmpeg({ log = console.log } = {}) {
  const src = ffmpegSource();
  fs.mkdirSync(FFMPEG_DIR, { recursive: true });

  if (src.kind === 'gz') {
    for (const tool of ['ffmpeg', 'ffprobe']) {
      log(`Downloading ${tool} (${src.suffix}) ...`);
      const dest = path.join(FFMPEG_DIR, `${tool}${EXE}`);
      const { tmp } = await downloadTo(`${FFMPEG_STATIC_BASE}/${tool}-${src.suffix}.gz`, dest, {
        gunzip: true,
        label: tool,
        log,
      });
      finalize(tmp, dest);
    }
  } else {
    log(`Downloading ffmpeg (${src.asset}) ...`);
    const sums = await fetchText(`${FFMPEG_BUILDS_BASE}/checksums.sha256`);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'video2mp4-ffmpeg-'));
    try {
      const zipPath = path.join(work, src.asset);
      const { tmp, sha256 } = await downloadTo(`${FFMPEG_BUILDS_BASE}/${src.asset}`, zipPath, { label: 'ffmpeg', log });
      if (lookupChecksum(sums, src.asset) !== sha256) throw new Error(`Checksum verification failed for ${src.asset}.`);
      fs.renameSync(tmp, zipPath);
      // Windows 10+ ships bsdtar, which can extract zip archives.
      execFileSync('tar', ['-xf', zipPath, '-C', work], { stdio: 'ignore' });
      const root = fs.readdirSync(work).find((d) => fs.statSync(path.join(work, d)).isDirectory());
      const binDir = path.join(work, root, 'bin');
      for (const f of fs.readdirSync(binDir)) {
        if (f.startsWith('ffplay')) continue;
        fs.copyFileSync(path.join(binDir, f), path.join(FFMPEG_DIR, f));
      }
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  if (!hasFfmpeg()) throw new Error('ffmpeg installation did not complete.');
  log(`ffmpeg installed: ${FFMPEG_DIR}`);
  return FFMPEG_DIR;
}

async function ensureYtDlp(opts) {
  return fs.existsSync(ytDlpPath()) ? ytDlpPath() : downloadYtDlp(opts);
}

async function ensureFfmpeg(opts) {
  return hasFfmpeg() ? FFMPEG_DIR : downloadFfmpeg(opts);
}

module.exports = {
  VENDOR_DIR,
  ytDlpPath,
  ffmpegDir,
  hasFfmpeg,
  downloadYtDlp,
  downloadFfmpeg,
  ensureYtDlp,
  ensureFfmpeg,
  ytDlpAssetName,
};
