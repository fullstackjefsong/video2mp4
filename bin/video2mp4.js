#!/usr/bin/env node
'use strict';

const readline = require('readline');
const { spawnSync } = require('child_process');
const pkg = require('../package.json');
const { PRESETS, parseVideoUrl, resolvePreset, sourceSummary, fetchVideoInfo, convert } = require('../lib/converter');
const { downloadYtDlp, ytDlpPath } = require('../lib/binaries');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c('1');
const dim = c('2');
const red = c('31');
const green = c('32');
const yellow = c('33');
const magenta = c('35');
const cyan = c('36');

const APP_ART = [
  "        _     _           ____                  _  _",
  " __   _(_) __| | ___  ___|___ \\ _ __ ___  _ __ | || |",
  " \\ \\ / / |/ _` |/ _ \\/ _ \\ __) | '_ ` _ \\| '_ \\| || |_",
  "  \\ V /| | (_| |  __/ (_) / __/| | | | | | |_) |__   _|",
  "   \\_/ |_|\\__,_|\\___|\\___/_____|_| |_| |_| .__/   |_|",
  "                                         |_|",
];
const USER_ART = [
  "   __      _ _    _           _    _      __",
  "  / _|_  _| | |__| |_ __ _ __| |__(_)___ / _|___ ___ _ _  __ _",
  " |  _| || | | (_-<  _/ _` / _| / /| / -_)  _(_-</ _ \\ ' \\/ _` |",
  " |_|  \\_,_|_|_/__/\\__\\__,_\\__|_\\_\\/ \\___|_| /__/\\___/_||_\\__, |",
  "                                |__/                     |___/",
];
// Tape window: full supply reel on the left, nearly empty take-up reel on the right.
const REELS = [
  "     .-''''''''-.                                   ",
  "   .'   .----.   '.                     .-''''-.    ",
  "  |    |  ()  |    |=====================|  ()  |   ",
  "   '.   '----'   .'                     '-....-'    ",
  "     '-........-'                                   ",
];

// Draws a VHS cassette: spine label with the names, tape window with reels, transport controls.
function banner() {
  const artWidth = Math.max(...APP_ART.map((l) => l.length), ...USER_ART.map((l) => l.length));
  const inner = artWidth + 8;
  const center = (s, w) => {
    const pad = Math.max(0, w - s.length);
    return ' '.repeat(Math.floor(pad / 2)) + s + ' '.repeat(Math.ceil(pad / 2));
  };
  const shell = (s) => `${dim('|')}${s}${dim('|')}`;
  const labelW = inner - 4;
  const label = (s, color = (x) => x) => shell(` ${dim('|')}${color(center(s, labelW))}${dim('|')} `);

  const ver = `v${pkg.version}`;
  const left = ' VHS | T-120 | SP ';
  const right = ` HI-FI STEREO  ${ver} `;
  const stripe = left + '='.repeat(labelW - left.length - right.length) + right;

  const reelW = Math.max(...REELS.map((l) => l.length));
  const winLine = (s) => shell(dim(center(s, inner)));
  const controls = '<< REW    [] STOP    > PLAY    >> FF    (o) REC';
  const tagline = 'YouTube / TikTok  ->  MP4  *  H.264 + AAC  *  1080p';
  const padWin = Math.floor((inner - reelW - 2) / 2);
  const winRow = (s) => shell(`${' '.repeat(padWin)}${dim('|')}${yellow(s.padEnd(reelW))}${dim('|')}${' '.repeat(inner - reelW - 2 - padWin)}`);

  return [
    dim(` ${'_'.repeat(inner)} `),
    shell(dim(`  ${'_'.repeat(labelW)}  `)),
    shell(` ${dim('|')}${bold(magenta(stripe))}${dim('|')} `),
    ...APP_ART.map((l) => label(l.padEnd(artWidth), (x) => bold(red(x)))),
    label(''),
    label('-- by --', dim),
    ...USER_ART.map((l) => label(l.padEnd(artWidth), cyan)),
    shell(dim(` |${'_'.repeat(labelW)}| `)),
    shell(' '.repeat(inner)),
    winLine(` ${'_'.repeat(reelW)} `),
    ...REELS.map(winRow),
    winLine(`|${'_'.repeat(reelW)}|`),
    shell(' '.repeat(inner)),
    shell(cyan(center(controls, inner))),
    shell(yellow(center(tagline, inner))),
    dim(`|${'_'.repeat(inner)}|`),
  ].join('\n');
}

const HELP = `
${bold('video2mp4')} v${pkg.version} - convert YouTube & TikTok videos to MP4 (H.264 + AAC)

Usage:
  video2mp4              Interactive mode (prompts for URL and quality)
  video2mp4 <url>        Skip the URL prompt
  video2mp4 --update     Update the bundled yt-dlp engine to the latest release
  video2mp4 --version    Show version
  video2mp4 --help       Show this help

Quality options (typed at the confirmation prompt):
  ${bold('<Enter>')}   ${PRESETS.default.label}  ${dim('(default)')}
  ${bold('lofi')}      ${PRESETS.lofi.label}
  ${bold('insane')}    ${PRESETS.insane.label}

Files are saved to the current directory, named after the video title.
`;

// Line queue so prompts work for both interactive terminals and piped input.
function createPrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const lines = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (line) => {
    if (!waiters.length) return lines.push(line);
    if (!process.stdin.isTTY) process.stdout.write(`${line}\n`);
    waiters.shift()(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()(null);
  });
  rl.on('SIGINT', () => {
    process.stdout.write('\n');
    console.log(dim('Cancelled.'));
    process.exit(130);
  });
  return {
    ask(question) {
      process.stdout.write(question);
      if (lines.length) {
        const l = lines.shift();
        if (!process.stdin.isTTY) process.stdout.write(`${l}\n`);
        return Promise.resolve(l);
      }
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    },
    close: () => rl.close(),
  };
}

function formatDuration(sec) {
  if (!sec && sec !== 0) return 'unknown';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`;
}

function describeSource(src) {
  if (!src) return 'unknown';
  const short = Math.min(src.width, src.height);
  const names = { 4320: '8K', 2160: '4K', 1440: '1440p', 1080: '1080p', 720: '720p', 480: '480p', 360: '360p' };
  const name = names[short] || `${short}p`;
  const orient = src.height > src.width ? ', vertical' : '';
  return `${src.width}x${src.height} (${name}${src.fps ? ` @ ${Math.round(src.fps)} fps` : ''}${orient})`;
}

async function promptForVideo(prompter, initialUrl) {
  let candidate = initialUrl;
  for (;;) {
    if (candidate == null) {
      candidate = await prompter.ask(`${cyan('?')} ${bold('YouTube or TikTok URL:')} `);
      if (candidate == null) return null;
    }
    try {
      const parsed = parseVideoUrl(candidate);
      process.stdout.write(dim(`  Checking ${parsed.platform} video... `));
      const info = await fetchVideoInfo(parsed.url);
      process.stdout.write(`${green('OK')}\n`);
      return { parsed, info };
    } catch (err) {
      if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
      else process.stdout.write('\n');
      console.log(`  ${red('x')} ${err.message}`);
    }
    candidate = null;
  }
}

async function promptForPreset(prompter) {
  for (;;) {
    const answer = await prompter.ask(
      `${cyan('?')} ${bold('Press Enter to convert')} ${dim(`[${PRESETS.default.label}]`)}, or type ${bold('lofi')} / ${bold('insane')} ${dim('(n to cancel)')}: `
    );
    if (answer == null) return null;
    if (/^(n|no|q|quit|cancel)$/i.test(answer.trim())) return null;
    const preset = resolvePreset(answer);
    if (preset) return preset;
    console.log(`  ${red('x')} Unknown option "${answer.trim()}". Choose Enter, lofi, or insane.`);
  }
}

const PHASE_LABEL = { video: 'Downloading video', audio: 'Downloading audio', convert: 'Converting       ' };

function createProgress() {
  let phase = null;
  let speed = '';
  let lastLogged = -1;
  return (p) => {
    if (p.phase !== phase) {
      if (phase && process.stdout.isTTY) process.stdout.write('\r\x1b[K');
      phase = p.phase;
      speed = '';
      lastLogged = -1;
    }
    if (p.speed) speed = p.speed;
    if (p.percent == null) return;
    const pct = Math.max(0, Math.min(100, p.percent));
    if (process.stdout.isTTY) {
      const width = 30;
      const filled = Math.round((pct / 100) * width);
      const bar = '#'.repeat(filled) + '-'.repeat(width - filled);
      const eta = p.eta && p.eta !== 'NA' ? `  ETA ${p.eta}` : '';
      process.stdout.write(`\r\x1b[K  ${PHASE_LABEL[phase]} [${bar}] ${pct.toFixed(1).padStart(5)}%  ${speed}${eta}`);
    } else if (Math.floor(pct / 25) > lastLogged) {
      lastLogged = Math.floor(pct / 25);
      console.log(`  ${PHASE_LABEL[phase].trim()} ${Math.floor(pct)}%`);
    }
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return 0;
  }
  if (args.includes('--version') || args.includes('-v')) {
    console.log(pkg.version);
    return 0;
  }
  if (args.includes('--update')) {
    await downloadYtDlp();
    spawnSync(ytDlpPath(), ['--version'], { stdio: 'inherit' });
    return 0;
  }
  const unknown = args.filter((a) => a.startsWith('-'));
  if (unknown.length) {
    console.error(`Unknown option: ${unknown[0]}\n${HELP}`);
    return 2;
  }

  console.log(`\n${banner()}\n`);
  const prompter = createPrompter();
  try {
    const picked = await promptForVideo(prompter, args[0]);
    if (!picked) {
      console.log(dim('Cancelled.'));
      return 1;
    }
    const { info } = picked;
    const src = sourceSummary(info);
    console.log(`  ${bold('Title:')}    ${info.title || info.id}`);
    if (info.uploader || info.channel) console.log(`  ${bold('Channel:')}  ${info.uploader || info.channel}`);
    console.log(`  ${bold('Duration:')} ${formatDuration(info.duration)}`);
    console.log(`  ${bold('Source:')}   ${describeSource(src)}\n`);

    const preset = await promptForPreset(prompter);
    if (!preset) {
      console.log(dim('Cancelled.'));
      return 1;
    }
    prompter.close();

    if (preset.key === 'insane' && src && Math.min(src.width, src.height) <= 1080) {
      console.log(dim('  Note: source is 1080p or lower, so "insane" keeps the full source resolution with 320k audio.'));
    } else if (preset.key === 'insane' && src && Math.min(src.width, src.height) >= 2160) {
      console.log(dim('  Note: encoding 4K+ in software is CPU-heavy and can take longer than the video itself.'));
    }

    console.log(`\n  Converting to ${bold(preset.label)} ...`);
    const progress = createProgress();
    const file = await convert(info, preset, {
      outDir: process.cwd(),
      onProgress: progress,
      onPlan(plan) {
        if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
        console.log(`  ${dim('Video:')} ${plan.videoDesc}`);
        console.log(`  ${dim('Audio:')} ${plan.audioDesc}`);
      },
    });
    if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
    console.log(`  ${green('Done!')} Saved: ${bold(file)}\n`);
    return 0;
  } finally {
    prompter.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
    console.error(`\n  ${red('Error:')} ${err.message}\n`);
    process.exit(1);
  });
