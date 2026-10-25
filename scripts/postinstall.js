#!/usr/bin/env node
'use strict';

const { downloadYtDlp, ensureFfmpeg } = require('../lib/binaries');

const log = (m) => console.log(`[video2mp4] ${m}`);

(async () => {
  let ok = true;
  try {
    await downloadYtDlp({ log });
  } catch (err) {
    ok = false;
    console.warn(`[video2mp4] Warning: could not download yt-dlp (${err.message}).`);
  }
  try {
    await ensureFfmpeg({ log });
  } catch (err) {
    ok = false;
    console.warn(`[video2mp4] Warning: could not download ffmpeg (${err.message}).`);
  }
  // Don't fail the npm install: missing pieces are fetched again on first run.
  if (!ok) console.warn('[video2mp4] Missing components will be downloaded automatically the first time you run video2mp4.');
})();
