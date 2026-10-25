'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseVideoUrl, resolvePreset, sanitizeFileName, targetFrameRate, planTranscode, PRESETS } = require('../lib/converter');

test('accepts YouTube URLs', () => {
  for (const u of [
    'https://youtu.be/T0LzBzTL16o?si=0C6GVQPlgcuNIYXg',
    'https://www.youtube.com/watch?v=T0LzBzTL16o&list=PL1',
    'youtube.com/shorts/T0LzBzTL16o',
    'https://m.youtube.com/watch?v=T0LzBzTL16o',
  ]) {
    assert.deepStrictEqual(parseVideoUrl(u), { platform: 'YouTube', id: 'T0LzBzTL16o', url: 'https://www.youtube.com/watch?v=T0LzBzTL16o' }, u);
  }
});

test('accepts TikTok URLs and strips tracking params', () => {
  assert.deepStrictEqual(
    parseVideoUrl('https://www.tiktok.com/@funnyanimals576/video/7689026282587278622?is_from_webapp=1&sender_device=pc'),
    { platform: 'TikTok', id: '7689026282587278622', url: 'https://www.tiktok.com/@funnyanimals576/video/7689026282587278622' }
  );
  assert.strictEqual(parseVideoUrl('https://vm.tiktok.com/ZMabc123/').url, 'https://vm.tiktok.com/ZMabc123/');
  assert.strictEqual(parseVideoUrl('https://www.tiktok.com/t/ZTabc123/').url, 'https://www.tiktok.com/t/ZTabc123/');
  assert.strictEqual(parseVideoUrl('m.tiktok.com/v/7689026282587278622.html').id, '7689026282587278622');
});

test('rejects invalid URLs', () => {
  for (const u of [
    '',
    'not a url',
    'https://vimeo.com/123',
    'https://youtu.be/abc',
    'https://www.tiktok.com/@user',
    'https://www.tiktok.com/@user/video/123',
    'https://evil-tiktok.com/@u/video/7689026282587278622',
    'ftp://youtu.be/T0LzBzTL16o',
  ]) {
    assert.throws(() => parseVideoUrl(u), Error, u);
  }
  assert.throws(() => parseVideoUrl('https://www.tiktok.com/@u/photo/7689026282587278622'), /slideshow/);
});

test('maps confirmation answers to presets', () => {
  assert.strictEqual(resolvePreset(''), PRESETS.default);
  assert.strictEqual(resolvePreset(' LOFI '), PRESETS.lofi);
  assert.strictEqual(resolvePreset('Insane'), PRESETS.insane);
  assert.strictEqual(resolvePreset('flac'), null);
});

test('sanitizes file names', () => {
  assert.strictEqual(sanitizeFileName('a/b: c?'), 'a⧸b： c？');
  assert.strictEqual(sanitizeFileName('  trailing dots... '), 'trailing dots');
  assert.strictEqual(sanitizeFileName('CON'), 'CON_');
  assert.strictEqual(sanitizeFileName('', 'TikTok 123'), 'TikTok 123');
  assert.ok([...sanitizeFileName('word '.repeat(100))].length <= 150);
});

test('picks constant standard frame rates', () => {
  assert.strictEqual(targetFrameRate(29.97, 60).expr, '30000/1001');
  assert.strictEqual(targetFrameRate(59.94, 30).expr, '30000/1001');
  assert.strictEqual(targetFrameRate(60, 60).expr, '60');
  assert.strictEqual(targetFrameRate(120, 60).expr, '60');
  assert.strictEqual(targetFrameRate(25, 30).expr, '25');
  assert.strictEqual(targetFrameRate(0, 30).expr, '30');
});

const h264 = (o = {}) => ({ codec_name: 'h264', profile: 'High', pix_fmt: 'yuv420p', width: 1920, height: 1080, avg_frame_rate: '30/1', r_frame_rate: '30/1', ...o });
const aac = (o = {}) => ({ codec_name: 'aac', profile: 'LC', channels: 2, sample_rate: '48000', bit_rate: '128000', ...o });

test('copies streams that already match the target', () => {
  const plan = planTranscode({ video: h264(), audio: aac() }, PRESETS.default);
  assert.ok(plan.copyVideo);
  assert.deepStrictEqual(plan.args, ['-map', '0:v:0', '-c:v', 'copy', '-map', '0:a:0', '-c:a', 'copy']);
});

test('re-encodes when the source does not fit the preset', () => {
  const vfr = planTranscode({ video: h264({ avg_frame_rate: '2900/100' }), audio: aac() }, PRESETS.default);
  assert.ok(!vfr.copyVideo, 'VFR must be re-encoded');

  const hevc = planTranscode({ video: h264({ codec_name: 'hevc', width: 1080, height: 1920, bit_rate: '1400000' }), audio: aac({ profile: 'HE-AAC' }) }, PRESETS.default);
  assert.ok(!hevc.copyVideo);
  assert.ok(hevc.args.includes('libx264'));
  assert.strictEqual(hevc.args[hevc.args.indexOf('-maxrate') + 1], '3500k');
  assert.ok(hevc.args.includes('aac'), 'HE-AAC must be re-encoded to AAC-LC');

  const uhd = planTranscode({ video: h264({ codec_name: 'vp9', width: 3840, height: 2160, avg_frame_rate: '60/1', r_frame_rate: '60/1' }) }, PRESETS.default);
  assert.match(uhd.args[uhd.args.indexOf('-vf') + 1], /^fps=60,scale=1920:1080:flags=lanczos/);

  const lofi = planTranscode({ video: h264({ width: 1080, height: 1920 }) }, PRESETS.lofi);
  assert.match(lofi.args[lofi.args.indexOf('-vf') + 1], /scale=480:854/);

  const insane = planTranscode({ video: h264({ codec_name: 'vp9', width: 7680, height: 4320 }), audio: aac({ channels: 6 }) }, PRESETS.insane);
  assert.doesNotMatch(insane.args[insane.args.indexOf('-vf') + 1], /scale=/);
  assert.ok(insane.args.includes('320k'));
});
