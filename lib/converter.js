'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ensureYtDlp, ensureFfmpeg, ffmpegDir } = require('./binaries');

const EXE = process.platform === 'win32' ? '.exe' : '';

/*
 * Every preset outputs MP4 (H.264 High/Main + AAC-LC, yuv420p, constant frame rate,
 * 2-second keyframes, +faststart) - the combination every editor, phone and upload
 * pipeline (YouTube, TikTok, Instagram) accepts without conversion.
 */
const PRESETS = {
  default: {
    key: 'default',
    label: 'MP4 up to 1080p - H.264 + AAC 192k',
    maxShort: 1080,
    maxFps: 60,
    crf: 18,
    x264Preset: 'medium',
    profile: 'high',
    audioKbps: 192,
    sort: 'res:1080,fps:60,vcodec:h264,acodec:aac',
  },
  lofi: {
    key: 'lofi',
    label: 'MP4 480p - H.264 + AAC 96k (small)',
    maxShort: 480,
    maxFps: 30,
    crf: 26,
    x264Preset: 'medium',
    profile: 'main',
    audioKbps: 96,
    sort: 'res:480,fps:30,vcodec:h264,acodec:aac',
  },
  insane: {
    key: 'insane',
    label: 'MP4 source resolution (4K/8K) - H.264 + AAC 320k',
    maxShort: Infinity,
    maxFps: Infinity,
    crf: 15,
    x264Preset: 'slow',
    profile: 'high',
    audioKbps: 320,
    sort: 'res,fps,vcodec:h264',
  },
};

// Prefer SDR streams: HDR -> 8-bit H.264 without tone mapping looks washed out.
const FORMAT_SELECTOR = 'bv*[dynamic_range=?SDR]+ba/b[dynamic_range=?SDR]/bv*+ba/b';

const YT_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);
const TT_HOSTS = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com']);
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const TT_ID_RE = /^\d{15,21}$/;
const TT_SHORT_RE = /^[A-Za-z0-9]{5,20}$/;

function parseYouTube(url) {
  const host = url.hostname.toLowerCase();
  const seg = url.pathname.split('/').filter(Boolean);
  let id = null;
  if (host.endsWith('youtu.be')) id = seg[0];
  else if (seg[0] === 'watch') id = url.searchParams.get('v');
  else if (['shorts', 'live', 'embed', 'v', 'e'].includes(seg[0])) id = seg[1];
  if (!id || !YT_ID_RE.test(id)) throw new Error('Could not find a valid YouTube video ID in that URL.');
  return { platform: 'YouTube', id, url: `https://www.youtube.com/watch?v=${id}` };
}

function parseTikTok(url) {
  const host = url.hostname.toLowerCase();
  const seg = url.pathname.split('/').filter(Boolean);

  // Short share links (vm./vt.tiktok.com/XXXX, tiktok.com/t/XXXX) are resolved by yt-dlp.
  if (host === 'vm.tiktok.com' || host === 'vt.tiktok.com') {
    if (seg.length === 1 && TT_SHORT_RE.test(seg[0])) {
      return { platform: 'TikTok', id: seg[0], url: `https://${host}/${seg[0]}/` };
    }
  } else if (seg[0] === 't' && seg[1] && TT_SHORT_RE.test(seg[1])) {
    return { platform: 'TikTok', id: seg[1], url: `https://www.tiktok.com/t/${seg[1]}/` };
  } else if (seg[0] && seg[0].startsWith('@') && seg.length >= 3) {
    if (seg[1] === 'photo') throw new Error('That TikTok is a photo slideshow, not a video.');
    if (seg[1] === 'video' && TT_ID_RE.test(seg[2])) {
      return { platform: 'TikTok', id: seg[2], url: `https://www.tiktok.com/${seg[0]}/video/${seg[2]}` };
    }
  } else if (seg[0] === 'embed') {
    const id = seg[1] === 'v2' ? seg[2] : seg[1];
    if (TT_ID_RE.test(id || '')) return { platform: 'TikTok', id, url: `https://www.tiktok.com/embed/v2/${id}` };
  } else if (seg[0] === 'v' && seg[1]) {
    const id = seg[1].replace(/\.html$/, '');
    if (TT_ID_RE.test(id)) return { platform: 'TikTok', id, url: `https://www.tiktok.com/embed/v2/${id}` };
  }
  throw new Error('Could not find a valid TikTok video in that URL.');
}

/** Validates a YouTube or TikTok URL; returns { platform, id, url } with tracking params removed. */
function parseVideoUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new Error('No URL entered.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('That is not a valid URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('URL must start with http:// or https://');
  const host = url.hostname.toLowerCase();
  if (YT_HOSTS.has(host)) return parseYouTube(url);
  if (TT_HOSTS.has(host)) return parseTikTok(url);
  throw new Error(`"${url.hostname}" is not a YouTube or TikTok address.`);
}

function resolvePreset(answer) {
  const a = String(answer || '').trim().toLowerCase();
  if (a === '') return PRESETS.default;
  if (a === 'lofi' || a === 'lo-fi') return PRESETS.lofi;
  if (a === 'insane') return PRESETS.insane;
  return null;
}

const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const FULLWIDTH = { '<': '＜', '>': '＞', ':': '：', '"': '＂', '/': '⧸', '\\': '⧹', '|': '｜', '?': '？', '*': '＊' };

/** Turns a video title into a safe cross-platform file name (without extension). */
function sanitizeFileName(title, fallback = 'video') {
  let s = String(title || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>:"/\\|?*]/g, (ch) => FULLWIDTH[ch])
    .replace(/\s+/g, ' ')
    .trim();
  const max = 150;
  if ([...s].length > max) {
    s = [...s].slice(0, max).join('');
    const cut = s.lastIndexOf(' ');
    if (cut > max * 0.6) s = s.slice(0, cut);
    s = s.trim();
  }
  s = s.replace(/[. ]+$/, '');
  if (!s) s = fallback;
  if (WIN_RESERVED.test(s)) s = `${s}_`;
  return s;
}

function uniquePath(dir, base, ext) {
  let p = path.join(dir, `${base}${ext}`);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

function parseRate(r) {
  if (!r || r === '0/0') return 0;
  const [n, d] = String(r).split('/').map(Number);
  return d ? n / d : n || 0;
}

const STANDARD_RATES = [
  ['24000/1001', 23.976], ['24', 24], ['25', 25], ['30000/1001', 29.97], ['30', 30],
  ['48', 48], ['50', 50], ['60000/1001', 59.94], ['60', 60], ['120', 120],
];

/** Picks the constant output frame rate: source rate, halved until it fits the cap, snapped to a standard rate. */
function targetFrameRate(sourceFps, maxFps) {
  let fps = sourceFps > 0 ? sourceFps : 30;
  while (fps > maxFps * 1.01) fps /= 2;
  let best = STANDARD_RATES[0];
  for (const r of STANDARD_RATES) if (Math.abs(r[1] - fps) < Math.abs(best[1] - fps)) best = r;
  if (best[1] > maxFps * 1.01 || Math.abs(best[1] - fps) / fps > 0.05) {
    return { expr: String(Math.round(fps * 1000) / 1000), value: fps };
  }
  return { expr: best[0], value: best[1] };
}

function run(bin, args, { onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      stdout += d;
      if (!onStdout) return;
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        onStdout(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 200000) stderr = stderr.slice(-100000);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function ytDlpError(stderr) {
  const last = String(stderr || '').split(/\r?\n/).filter((l) => /^ERROR:/.test(l)).pop();
  if (!last) return 'Unknown error.';
  return last.replace(/^ERROR:\s*(\[[^\]]+\]\s*[A-Za-z0-9_@.-]+:\s*)?/, '').trim();
}

function ytDlpBaseArgs() {
  return [
    '--ffmpeg-location', ffmpegDir(),
    // Recent YouTube extraction needs a JS runtime; reuse the Node binary running this CLI.
    '--js-runtimes', `node:${process.execPath}`,
    '--no-playlist',
    '--no-config',
    '--encoding', 'utf-8',
  ];
}

function isVideoFormat(f) {
  return (f.vcodec && f.vcodec !== 'none') || (f.vcodec == null && f.height > 0 && f.ext !== 'mhtml');
}

/** Best resolution/fps the source offers, e.g. { width: 3840, height: 2160, fps: 60 }. */
function sourceSummary(info) {
  const vids = (info.formats || []).filter(isVideoFormat).filter((f) => f.width && f.height);
  if (!vids.length) return info.width && info.height ? { width: info.width, height: info.height, fps: info.fps || 0 } : null;
  vids.sort((a, b) => Math.min(b.width, b.height) - Math.min(a.width, a.height) || (b.fps || 0) - (a.fps || 0));
  return { width: vids[0].width, height: vids[0].height, fps: vids[0].fps || 0 };
}

/** Confirms the video exists and has a downloadable video stream; returns yt-dlp metadata. */
async function fetchVideoInfo(url) {
  const ytDlp = await ensureYtDlp();
  const { code, stdout, stderr } = await run(ytDlp, [...ytDlpBaseArgs(), '--dump-single-json', '--skip-download', url]);
  if (code !== 0) throw new Error(`Video is not accessible: ${ytDlpError(stderr)}`);
  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new Error('Could not read video information.');
  }
  if (info._type === 'playlist') throw new Error('That link points to a playlist or profile, not a single video.');
  if (info.is_live) throw new Error('This is a live stream that is still in progress and cannot be converted yet.');
  const formats = info.formats || [];
  if (!formats.some(isVideoFormat) && !(info.url && info.vcodec !== 'none')) {
    throw new Error('No downloadable video stream was found.');
  }
  return info;
}

async function probe(file) {
  const ffprobe = path.join(ffmpegDir(), `ffprobe${EXE}`);
  const { code, stdout, stderr } = await run(ffprobe, [
    '-v', 'error', '-probesize', '100M', '-analyzeduration', '30M',
    '-print_format', 'json', '-show_streams', '-show_format', file,
  ]);
  if (code !== 0) throw new Error(`Could not analyse the downloaded video: ${stderr.trim().split('\n').pop()}`);
  const data = JSON.parse(stdout);
  const streams = data.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const audio = streams.find((s) => s.codec_type === 'audio');
  return {
    video,
    audio,
    duration: parseFloat(data.format && data.format.duration) || 0,
    bitRate: Number(data.format && data.format.bit_rate) || 0,
  };
}

// Re-encoding cannot add detail, so cap the bitrate relative to the source to avoid bloated files.
const EFFICIENT_CODECS = new Set(['hevc', 'vp9', 'av1']);
function bitrateCapKbps(src) {
  const v = src.video;
  let bps = Number(v.bit_rate) || 0;
  if (!bps && src.bitRate) bps = src.bitRate - (Number(src.audio && src.audio.bit_rate) || 128000);
  if (!bps || bps < 100000) return 0;
  const factor = EFFICIENT_CODECS.has(v.codec_name) ? 2.5 : 1.5;
  return Math.max(1500, Math.round((bps * factor) / 1000));
}

function rotationOf(v) {
  const side = (v.side_data_list || []).find((s) => s.rotation != null);
  const r = side ? Number(side.rotation) : Number((v.tags && v.tags.rotate) || 0);
  return Math.abs(r) % 180 === 90;
}

/** Decides copy vs. encode for each stream and builds the ffmpeg arguments. */
function planTranscode(src, preset, { smartCopy = true } = {}) {
  const v = src.video;
  if (!v) throw new Error('The downloaded file contains no video stream.');
  const rotated = rotationOf(v);
  const w = rotated ? v.height : v.width;
  const h = rotated ? v.width : v.height;
  const short = Math.min(w, h);
  const avg = parseFloat(parseRate(v.avg_frame_rate).toFixed(3));
  const real = parseFloat(parseRate(v.r_frame_rate).toFixed(3));
  const fps = avg || real;
  const vfr = avg > 0 && real > 0 && Math.abs(avg - real) / real > 0.01;
  const profileOk = /^(constrained baseline|baseline|main|high)$/i.test(v.profile || '');

  const copyVideo =
    smartCopy &&
    v.codec_name === 'h264' &&
    v.pix_fmt === 'yuv420p' &&
    profileOk &&
    short <= preset.maxShort &&
    fps <= preset.maxFps * 1.01 &&
    !vfr &&
    w % 2 === 0 &&
    h % 2 === 0 &&
    (!v.field_order || v.field_order === 'progressive');

  const args = ['-map', '0:v:0'];
  let videoDesc;
  if (copyVideo) {
    args.push('-c:v', 'copy');
    videoDesc = `copy (already H.264 ${w}x${h} @ ${fps.toFixed(fps % 1 ? 2 : 0)} fps)`;
  } else {
    const rate = targetFrameRate(fps, preset.maxFps);
    let outW = w;
    let outH = h;
    if (short > preset.maxShort) {
      const k = preset.maxShort / short;
      outW = w <= h ? preset.maxShort : Math.round((w * k) / 2) * 2;
      outH = w <= h ? Math.round((h * k) / 2) * 2 : preset.maxShort;
    }
    outW -= outW % 2;
    outH -= outH % 2;
    const filters = [`fps=${rate.expr}`];
    if (outW !== w || outH !== h) filters.push(`scale=${outW}:${outH}:flags=lanczos`);
    filters.push('setsar=1', 'format=yuv420p');
    args.push(
      '-vf', filters.join(','),
      '-fps_mode', 'cfr',
      '-c:v', 'libx264',
      '-preset', preset.x264Preset,
      '-crf', String(preset.crf),
      '-profile:v', preset.profile,
      '-g', String(Math.max(1, Math.round(rate.value * 2))),
      '-bf', '2'
    );
    const cap = bitrateCapKbps(src);
    if (cap) args.push('-maxrate', `${cap}k`, '-bufsize', `${cap * 2}k`);
    videoDesc = `H.264 ${outW}x${outH} @ ${rate.value.toFixed(rate.value % 1 ? 2 : 0)} fps (CRF ${preset.crf}, ${preset.x264Preset}${cap ? `, max ${(cap / 1000).toFixed(1)} Mbps` : ''})`;
    if (vfr) videoDesc += ', variable frame rate fixed to constant';
  }

  let audioDesc = 'none';
  const a = src.audio;
  if (a) {
    args.push('-map', '0:a:0');
    const br = Number(a.bit_rate) || 0;
    const copyAudio =
      smartCopy &&
      a.codec_name === 'aac' &&
      a.profile === 'LC' &&
      (a.channels || 2) <= 2 &&
      ['44100', '48000'].includes(String(a.sample_rate)) &&
      (br ? br <= preset.audioKbps * 1000 * 1.15 : preset.key !== 'lofi');
    if (copyAudio) {
      args.push('-c:a', 'copy');
      audioDesc = `copy (already AAC${br ? ` ${Math.round(br / 1000)}k` : ''})`;
    } else {
      args.push('-c:a', 'aac', '-b:a', `${preset.audioKbps}k`, '-ar', '48000', '-ac', '2');
      audioDesc = `AAC ${preset.audioKbps}k 48 kHz stereo`;
    }
  }
  return { args, copyVideo, videoDesc, audioDesc };
}

async function download(info, preset, tmpDir, onProgress) {
  const ytDlp = await ensureYtDlp();
  const infoFile = path.join(tmpDir, 'info.json');
  fs.writeFileSync(infoFile, JSON.stringify(info));
  let filePath = null;
  const { code, stderr } = await run(
    ytDlp,
    [
      ...ytDlpBaseArgs(),
      '--load-info-json', infoFile,
      '-f', FORMAT_SELECTOR,
      '-S', preset.sort,
      '--merge-output-format', 'mp4/mkv',
      '--paths', tmpDir,
      '--output', 'source.%(ext)s',
      '--newline',
      '--progress',
      '--progress-template',
      'download:PROGRESS %(info.vcodec)s %(progress._percent_str)s %(progress._speed_str)s %(progress._eta_str)s',
      '--print', 'after_move:FILEPATH %(filepath)s',
      '--no-simulate',
      '--no-warnings',
    ],
    {
      onStdout(line) {
        if (line.startsWith('PROGRESS ')) {
          const [vcodec, percent, speed, eta] = line.slice(9).trim().split(/\s+/);
          onProgress({ phase: vcodec === 'none' ? 'audio' : 'video', percent: parseFloat(percent) || 0, speed, eta });
        } else if (line.startsWith('FILEPATH ')) {
          filePath = line.slice(9).trim();
        }
      },
    }
  );
  if (code !== 0) throw new Error(`Download failed: ${ytDlpError(stderr)}`);
  if (!filePath || !fs.existsSync(filePath)) throw new Error('Download finished but the file could not be found.');
  return filePath;
}

async function transcode(input, output, plan, meta, duration, onProgress) {
  const ffmpeg = path.join(ffmpegDir(), `ffmpeg${EXE}`);
  const tmpOut = `${output}.part`;
  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-i', input,
    ...plan.args,
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    '-metadata', `title=${meta.title || ''}`,
    '-metadata', `artist=${meta.artist || ''}`,
    '-metadata', `comment=${meta.url || ''}`,
    '-movflags', '+faststart',
    '-f', 'mp4',
    '-progress', 'pipe:1',
    '-nostats',
    tmpOut,
  ];
  const { code, stderr } = await run(ffmpeg, args, {
    onStdout(line) {
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (m && duration > 0) onProgress({ phase: 'convert', percent: Math.min(100, (Number(m[1]) / 1e6 / duration) * 100) });
      const s = /^speed=\s*([\d.]+)x/.exec(line);
      if (s) onProgress({ phase: 'convert', speed: `${s[1]}x` });
    },
  });
  if (code !== 0) {
    fs.rmSync(tmpOut, { force: true });
    const msg = stderr.trim().split(/\r?\n/).slice(-3).join(' ');
    throw new Error(`Conversion failed: ${msg}`);
  }
  fs.renameSync(tmpOut, output);
}

/**
 * Downloads the video and writes "<title>.mp4" into outDir.
 * Emits progress events { phase: 'video'|'audio'|'convert', percent, speed, eta } and a 'plan' event.
 */
async function convert(info, preset, { outDir = process.cwd(), smartCopy = true, onProgress = () => {}, onPlan = () => {} } = {}) {
  await ensureYtDlp();
  await ensureFfmpeg();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video2mp4-'));
  try {
    const source = await download(info, preset, tmpDir, onProgress);
    const src = await probe(source);
    const plan = planTranscode(src, preset, { smartCopy });
    onPlan(plan);
    const base = sanitizeFileName(info.title, `${info.extractor_key || 'video'} ${info.id}`);
    const output = uniquePath(outDir, base, '.mp4');
    const duration = src.duration || info.duration || 0;
    await transcode(
      source,
      output,
      plan,
      { title: info.title, artist: info.uploader || info.channel || info.creator, url: info.webpage_url },
      duration,
      onProgress
    );
    return output;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = {
  PRESETS,
  parseVideoUrl,
  resolvePreset,
  sanitizeFileName,
  targetFrameRate,
  planTranscode,
  probe,
  sourceSummary,
  fetchVideoInfo,
  convert,
};
