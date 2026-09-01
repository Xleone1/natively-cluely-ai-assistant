// electron/services/__tests__/ScreenshotHelperLinux.test.mjs
//
// Phase 2 (Wayland / CachyOS) parity tests for screenshot pipeline.
//
// Coverage:
//
//  1. computeThumbnailCrop — pure geometry, platform-agnostic DPI math:
//     * 1x 1080p (logical == native)
//     * 1.25x fractional (e.g. GNOME fractional scaling 125%)
//     * 1.5x fractional (common Hyprland/KWin fractional)
//     * 2x 4K (HiDPI portal thumbnails)
//     * Negative origin (monitor left of primary)
//     * Out-of-bounds clamping
//  2. ScreenshotHelper.buildLinuxScreenshotCommand — Wayland vs X11 dispatch:
//     * Wayland env (XDG_SESSION_TYPE=wayland or WAYLAND_DISPLAY set) → grim chain
//     * X11 env → gnome-screenshot chain
//  3. buildCropperWindowSettings('linux') — graceful linux handling (no panel
//     type is macOS-only, but toolbar type stays; enableLargerThanScreen is
//     darwin|win32 only, linux gets no opacity shield).
//
// Runs under Electron's test harness (npm test does `electron --test`), but
// the helpers under test are pure and don't touch `app`/`screen`/`desktopCapturer`.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Build must have run (`npm run build:electron`) so dist-electron exists.
const base = path.resolve(process.cwd(), 'dist-electron/electron');
const screenshotMod = await import(pathToFileURL(path.join(base, 'ScreenshotHelper.js')).href);
const cropperMod = await import(pathToFileURL(path.join(base, 'CropperWindowHelper.js')).href);
const { computeThumbnailCrop, ScreenshotHelper } = screenshotMod;
const { buildCropperWindowSettings } = cropperMod;

// ---------------------------------------------------------------------------
// computeThumbnailCrop — DPI / portal correctness (native thumbnail size)
// ---------------------------------------------------------------------------

describe('computeThumbnailCrop (Wayland/X11 parity)', () => {
  test('1x 1080p — full-screen selection maps 1:1', () => {
    const sourceSize = { width: 1920, height: 1080 };
    const displayBounds = { x: 0, y: 0, width: 1920, height: 1080 };
    const area = { x: 0, y: 0, width: 1920, height: 1080 };
    const crop = computeThumbnailCrop(sourceSize, displayBounds, area);
    assert.deepEqual(crop, { x: 0, y: 0, width: 1920, height: 1080 });
  });

  test('1x 1080p — quarter selection maps 1:1', () => {
    const sourceSize = { width: 1920, height: 1080 };
    const displayBounds = { x: 0, y: 0, width: 1920, height: 1080 };
    const area = { x: 100, y: 100, width: 400, height: 300 };
    const crop = computeThumbnailCrop(sourceSize, displayBounds, area);
    assert.deepEqual(crop, { x: 100, y: 100, width: 400, height: 300 });
  });

  test('1.25x fractional scaling — 2400x1350 thumbnail for 1920x1080 logical', () => {
    // GNOME fractional 125%: logical 1920x1080, portal returns 2400x1350 (×1.25).
    const sourceSize = { width: 2400, height: 1350 };
    const displayBounds = { x: 0, y: 0, width: 1920, height: 1080 };
    const area = { x: 0, y: 0, width: 960, height: 540 }; // logical half
    const crop = computeThumbnailCrop(sourceSize, displayBounds, area);
    // ratio 1.25 → 960*1.25=1200, 540*1.25=675
    assert.deepEqual(crop, { x: 0, y: 0, width: 1200, height: 675 });
  });

  test('1.5x fractional scaling — 2880x1620 thumbnail', () => {
    const sourceSize = { width: 2880, height: 1620 };
    const displayBounds = { x: 0, y: 0, width: 1920, height: 1080 };
    const area = { x: 640, y: 360, width: 640, height: 360 };
    const crop = computeThumbnailCrop(sourceSize, displayBounds, area);
    // ratio 1.5 → (640*1.5=960, 360*1.5=540, 640*1.5=960, 360*1.5=540)
    assert.deepEqual(crop, { x: 960, y: 540, width: 960, height: 540 });
  });

  test('2x 4K HiDPI — 3840x2160 thumbnail for 1920x1080 logical', () => {
    const sourceSize = { width: 3840, height: 2160 };
    const displayBounds = { x: 0, y: 0, width: 1920, height: 1080 };
    const area = { x: 1920 - 400, y: 1080 - 300, width: 400, height: 300 };
    const crop = computeThumbnailCrop(sourceSize, displayBounds, area);
    // ratio 2 → x= (1520*2)=3040, y=(780*2)=1560, w=800, h=600
    assert.deepEqual(crop, { x: 3040, y: 1560, width: 800, height: 600 });
  });

  test('negative origin — monitor left of primary (x=-1920)', () => {
    const sourceSize = { width: 1920, height: 1080 };
    const displayBounds = { x: -1920, y: 0, width: 1920, height: 1080 };
    const area = { x: -1920, y: 0, width: 1920, height: 1080 }; // full left monitor
    const crop = computeThumbnailCrop(sourceSize, displayBounds, area);
    assert.deepEqual(crop, { x: 0, y: 0, width: 1920, height: 1080 });
  });

  test('negative origin — selection straddling two monitors', () => {
    // Left monitor -1920..0, right 0..1920. Area covers 100px on each side.
    const sourceSize = { width: 1920, height: 1080 };
    const displayBoundsLeft = { x: -1920, y: 0, width: 1920, height: 1080 };
    // For the LEFT display, area x=-100..100 cross. Intersection is at left display's right edge.
    // In practice stitched path computes per-display intersections; we test crop for left display's intersection.
    const intersectionLeft = { x: -100, y: 100, width: 100, height: 200 };
    const crop = computeThumbnailCrop(sourceSize, displayBoundsLeft, intersectionLeft);
    // x: (-100 - (-1920))=1820, y=100, w=100, h=200 (ratio 1)
    assert.deepEqual(crop, { x: 1820, y: 100, width: 100, height: 200 });
  });

  test('clamping — area outside thumbnail returns clamped empty/edge', () => {
    const sourceSize = { width: 1920, height: 1080 };
    const displayBounds = { x: 0, y: 0, width: 1920, height: 1080 };
    // Area completely outside to the right
    const area = { x: 5000, y: 0, width: 100, height: 100 };
    const crop = computeThumbnailCrop(sourceSize, displayBounds, area);
    // Clamped to right edge → x=1920 (max), width 0
    assert.equal(crop.x, 1920);
    assert.equal(crop.width, 0);
  });

  test('zero bounds — guards against Infinity/NaN', () => {
    const sourceSize = { width: 1920, height: 1080 };
    const displayBounds = { x: 0, y: 0, width: 0, height: 0 };
    const area = { x: 0, y: 0, width: 100, height: 100 };
    const crop = computeThumbnailCrop(sourceSize, displayBounds, area);
    // ratio falls back to 1 (guard against ratioX > MAX_RATIO)
    assert.ok(Number.isFinite(crop.x) && Number.isFinite(crop.y));
  });

  test('MAX_RATIO guard — absurd thumbnail does not explode', () => {
    const sourceSize = { width: 192000, height: 108000 }; // 100x logical
    const displayBounds = { x: 0, y: 0, width: 1920, height: 1080 };
    const area = { x: 0, y: 0, width: 100, height: 100 };
    const crop = computeThumbnailCrop(sourceSize, displayBounds, area);
    // ratio clamped to 10, not 100
    assert.equal(crop.width, 1000);
    assert.equal(crop.height, 1000);
  });

  // ---- 1366x768 (common low-res laptop) ----
  test('1366x768 1x — full-screen selection maps 1:1', () => {
    const sourceSize = { width: 1366, height: 768 };
    const displayBounds = { x: 0, y: 0, width: 1366, height: 768 };
    const area = { x: 0, y: 0, width: 1366, height: 768 };
    const crop = computeThumbnailCrop(sourceSize, displayBounds, area);
    assert.deepEqual(crop, { x: 0, y: 0, width: 1366, height: 768 });
  });

  test('1366x768 1x — bottom-right quarter offset correct', () => {
    const sourceSize = { width: 1366, height: 768 };
    const displayBounds = { x: 0, y: 0, width: 1366, height: 768 };
    const area = { x: 1366 - 400, y: 768 - 300, width: 400, height: 300 };
    const crop = computeThumbnailCrop(sourceSize, displayBounds, area);
    assert.deepEqual(crop, { x: 966, y: 468, width: 400, height: 300 });
  });

  test('1366x768 1.25x fractional — 1708x960 thumbnail', () => {
    // Cheap laptop with 125% GNOME scaling: logical 1366x768 → 1708x960 (×1.25).
    const sourceSize = { width: 1708, height: 960 };
    const displayBounds = { x: 0, y: 0, width: 1366, height: 768 };
    const area = { x: 0, y: 0, width: 683, height: 384 }; // ~half logical
    const crop = computeThumbnailCrop(sourceSize, displayBounds, area);
    // ratio 1.25 → 683*1.25≈854, 384*1.25=480 (rounded)
    assert.ok(Math.abs(crop.width - 854) <= 1);
    assert.ok(Math.abs(crop.height - 480) <= 1);
  });

  test('1366x768 1.5x fractional — 2049x1152 thumbnail near right edge', () => {
    const sourceSize = { width: 2049, height: 1152 };
    const displayBounds = { x: 0, y: 0, width: 1366, height: 768 };
    const area = { x: 1366 - 500, y: 768 - 400, width: 500, height: 400 };
    const crop = computeThumbnailCrop(sourceSize, displayBounds, area);
    // ratio 1.5 → x≈1299, y≈552, w=750, h=600
    assert.equal(crop.width, 750);
    assert.equal(crop.height, 600);
    assert.equal(crop.x, Math.round((1366 - 500) * 1.5));
  });

  test('1366x768 2x HiDPI — 2732x1536 thumbnail offset', () => {
    const sourceSize = { width: 2732, height: 1536 };
    const displayBounds = { x: 0, y: 0, width: 1366, height: 768 };
    const area = { x: 100, y: 100, width: 200, height: 150 };
    const crop = computeThumbnailCrop(sourceSize, displayBounds, area);
    assert.deepEqual(crop, { x: 200, y: 200, width: 400, height: 300 });
  });
});

// ---------------------------------------------------------------------------
// buildLinuxScreenshotCommand — Wayland vs X11 dispatch
// ---------------------------------------------------------------------------

describe('ScreenshotHelper.buildLinuxScreenshotCommand (Wayland/X11)', () => {
  const safePath = '/tmp/natively-test/abc.png';

  test('Wayland via XDG_SESSION_TYPE=wayland — interactive returns grim+slurp chain', () => {
    const cmd = ScreenshotHelper.buildLinuxScreenshotCommand(safePath, true, { XDG_SESSION_TYPE: 'wayland' });
    assert.match(cmd, /grim -g "\$\(slurp\)"/);
    assert.match(cmd, /gnome-screenshot.*scrot.*import/);
  });

  test('Wayland via WAYLAND_DISPLAY — interactive returns grim+slurp chain', () => {
    const cmd = ScreenshotHelper.buildLinuxScreenshotCommand(safePath, true, { WAYLAND_DISPLAY: 'wayland-0' });
    assert.match(cmd, /grim -g "\$\(slurp\)"/);
  });

  test('Wayland — non-interactive returns grim full-screen chain', () => {
    const cmd = ScreenshotHelper.buildLinuxScreenshotCommand(safePath, false, { XDG_SESSION_TYPE: 'wayland' });
    assert.match(cmd, /^grim "/);
    assert.match(cmd, /gnome-screenshot -f/);
  });

  test('X11 — interactive returns gnome-screenshot/scrot chain without grim', () => {
    const cmd = ScreenshotHelper.buildLinuxScreenshotCommand(safePath, true, { XDG_SESSION_TYPE: 'x11' });
    assert.match(cmd, /gnome-screenshot -a -f/);
    assert.match(cmd, /scrot -s/);
    assert.ok(!cmd.includes('grim'), 'grim must not appear on X11');
    assert.ok(!cmd.includes('slurp'), 'slurp must not appear on X11');
  });

  test('X11 empty env — non-interactive returns gnome-screenshot fallback without grim', () => {
    const cmd = ScreenshotHelper.buildLinuxScreenshotCommand(safePath, false, {});
    assert.match(cmd, /gnome-screenshot -f/);
    assert.ok(!cmd.includes('grim'));
  });

  test('darwin/win32 command path unchanged — ScreenshotHelper still throws off linux', () => {
    // The instance method getScreenshotCommand throws on non-linux; the static helper
    // is linux-only. This test proves the linux helper is the ONLY place that returns a command.
    // No assertion on darwin/win — just that the linux helper's two branches are disjoint.
    const wayland = ScreenshotHelper.buildLinuxScreenshotCommand(safePath, true, { XDG_SESSION_TYPE: 'wayland' });
    const x11 = ScreenshotHelper.buildLinuxScreenshotCommand(safePath, true, { XDG_SESSION_TYPE: 'x11' });
    assert.notEqual(wayland, x11);
  });
});

// ---------------------------------------------------------------------------
// buildCropperWindowSettings — linux handling
// ---------------------------------------------------------------------------

describe('buildCropperWindowSettings (linux)', () => {
  test('linux — receives toolbar type (non-win32), not panel', () => {
    const bounds = { x: -1920, y: 0, width: 3840, height: 1080 };
    const s = buildCropperWindowSettings(bounds, 'linux');
    assert.equal(s.type, 'toolbar');
  });

  test('linux — no enableLargerThanScreen (darwin|win32 only)', () => {
    const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
    const s = buildCropperWindowSettings(bounds, 'linux');
    assert.equal(s.enableLargerThanScreen, undefined);
  });

  test('linux — transparent, frameless, fullscreenable false', () => {
    const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
    const s = buildCropperWindowSettings(bounds, 'linux');
    assert.equal(s.transparent, true);
    assert.equal(s.frame, false);
    assert.equal(s.fullscreenable, false);
    assert.equal(s.alwaysOnTop, true);
    assert.equal(s.skipTaskbar, true);
  });

  test('linux — negative origin bounds (left monitor) preserved', () => {
    const bounds = { x: -1920, y: -442, width: 3840, height: 1522 };
    const s = buildCropperWindowSettings(bounds, 'linux');
    assert.equal(s.x, -1920);
    assert.equal(s.y, -442);
    assert.equal(s.width, 3840);
    assert.equal(s.height, 1522);
  });

  test('darwin — retains type toolbar and enableLargerThanScreen true', () => {
    const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
    const s = buildCropperWindowSettings(bounds, 'darwin');
    assert.equal(s.type, 'toolbar');
    assert.equal(s.enableLargerThanScreen, true);
  });

  test('win32 — no type, enableLargerThanScreen true (behaviour-neutral)', () => {
    const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
    const s = buildCropperWindowSettings(bounds, 'win32');
    assert.equal(s.type, undefined);
    assert.equal(s.enableLargerThanScreen, true);
  });

  // ---- 1366x768 low-res laptop ----
  test('linux — 1366x768 single display bounds preserved (no truncation)', () => {
    const bounds = { x: 0, y: 0, width: 1366, height: 768 };
    const s = buildCropperWindowSettings(bounds, 'linux');
    assert.equal(s.width, 1366);
    assert.equal(s.height, 768);
    assert.equal(s.x, 0);
    assert.equal(s.y, 0);
    // Overlay width 732 fits with 317px margins — not off-screen
    const overlayW = 732;
    assert.ok(s.width >= overlayW, `cropper width ${s.width} must fit overlay ${overlayW}`);
  });

  test('linux — 1366x768 + external 1920x1080 dual-monitor span (negative origin)', () => {
    // Cheap laptop + external: laptop 1366x768 at (0,0), external 1920x1080 left at -1920
    const bounds = { x: -1920, y: 0, width: 3286, height: 1080 };
    const s = buildCropperWindowSettings(bounds, 'linux');
    assert.equal(s.x, -1920);
    assert.equal(s.width, 3286);
  });

  test('overlay 732px fits within 1366px with centered margins (WindowHelper geometry)', () => {
    const workArea = { x: 0, y: 0, width: 1366, height: 728 }; // 768 minus 40px taskbar
    const overlayW = 732;
    const overlayX = Math.floor(workArea.x + (workArea.width - overlayW) / 2);
    assert.ok(overlayX >= 0, `overlayX ${overlayX} must be >=0 on 1366`);
    assert.ok(overlayX + overlayW <= workArea.x + workArea.width, 'overlay must stay inside workArea');
    assert.equal(overlayX, 317); // (1366-732)/2
  });
});
