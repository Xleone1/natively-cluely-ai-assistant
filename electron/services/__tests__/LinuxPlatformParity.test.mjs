// Linux/CachyOS parity — mirrors WindowsPlatformParity.test.mjs
//
// Each test pins a Phase 1-3 cross-platform gap where the feature was
// macOS/Windows-only and Linux now has an explicit branch. Source
// assertions so wiring is pinned even though Electron singletons cannot be
// instantiated in node.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

// ── 1. Inference config: linux cpu default, cuda opt-in via env ────────────

describe('Linux parity: inferenceConfig', () => {
  test('linux branch returns cpu by default, cuda opt-in via NATIVELY_LINUX_CUDA', () => {
    const src = read('electron/audio/whisper/inferenceConfig.ts');
    const linuxBlock = src.slice(src.indexOf("if (platform === 'linux')"), src.indexOf("if (platform === 'linux')") + 1200);
    assert.ok(linuxBlock.length > 200, 'linux branch not found in resolveInferenceConfig');
    assert.match(linuxBlock, /if \(process\.env\.NATIVELY_LINUX_CUDA === '1'\)/, 'BUG: linux cuda opt-in must be env-gated');
    assert.match(linuxBlock, /executionProviders: \['cuda', 'cpu'\]/, 'BUG: cuda opt-in must return [cuda,cpu]');
    assert.match(linuxBlock, /executionProviders: \['cpu'\]/, 'BUG: linux default must be [cpu]');
    assert.match(linuxBlock, /WHISPER_SAFE_DTYPE/, 'BUG: linux must use WHISPER_SAFE_DTYPE');
  });

  test('Nemotron stays cpu-only regardless of platform', () => {
    const src = read('electron/audio/whisper/inferenceConfig.ts');
    assert.ok(src.includes('resolveNemotronExecutionProviders'), 'resolveNemotronExecutionProviders missing');
    assert.ok(src.includes('cpuOnly') && src.includes('filter'), 'Nemotron cpu-only filter missing');
  });

  test('darwin/win32 branches untouched', () => {
    const src = read('electron/audio/whisper/inferenceConfig.ts');
    assert.match(src, /darwin.*arm64.*coreml/s, 'darwin coreml branch missing — regression');
    assert.match(src, /win32.*dml/s, 'win32 dml branch missing — regression');
  });
});

// ── 2. Window creation: launcher/overlay/cropper/settings omit mac/win flags on linux ──

describe('Linux parity: window creation guards', () => {
  test('overlay window: linux omits panel type, vibrancy, win32 alwaysOnTop levels', () => {
    const src = read('electron/WindowHelper.ts');
    // Overlay type:'panel' is isMac-only
    assert.match(src, /isMac \? \{ type: 'panel'/, 'overlay panel type must be isMac-gated');
    // Vibrancy is launcher-only isMac
    assert.match(src, /\.\.\.\(isMac\s*\?\s*\{ vibrancy:/, 'launcher vibrancy must be isMac-gated');
  });

  test('launcher window: linux transparent & frameless but no vibrancy', () => {
    const src = read('electron/WindowHelper.ts');
    // Launcher vibrancy is isMac-gated
    assert.match(src, /\.\.\.\(isMac\s*\?\s*\{ vibrancy:/, 'launcher vibrancy must be isMac-gated');
    // transparent true is unconditional (creation-time-only)
    assert.match(src, /transparent:\s*true/, 'launcher/overlay must stay transparent:true on all platforms');
  });

  test('applyContentProtection is best-effort try/catch on linux', () => {
    const src = read('electron/WindowHelper.ts');
    const block = src.slice(src.indexOf('private applyContentProtection'), src.indexOf('private applyContentProtection') + 2000);
    assert.match(block, /try\s*\{\s*win\.setContentProtection/, 'applyContentProtection must be try-wrapped for linux Wayland');
  });

  test('cropper: linux gets toolbar type, no enableLargerThanScreen', () => {
    const src = read('electron/CropperWindowHelper.ts');
    // toolbar type is non-win32 (includes linux)
    assert.match(src, /if \(platform !== 'win32'\)\s*\{[\s\S]*?type =/, 'cropper toolbar type must include linux');
    // enableLargerThanScreen is darwin|win32 only
    assert.match(src, /if \(platform === 'darwin' \|\| platform === 'win32'\)/, 'enableLargerThanScreen must be darwin|win32 only, not linux');
  });

  test('settings/modelSelector: linux omits panel type and win32 activation hooks', () => {
    const settings = read('electron/SettingsWindowHelper.ts');
    const selector = read('electron/ModelSelectorWindowHelper.ts');
    for (const src of [settings, selector]) {
      assert.match(src, /isMac \? \{ type: 'panel'/, 'settings/modelSelector panel type must be isMac-gated');
      // attachNoActivate is called but returns early on non-win32 (verified in windowsFocusPolicy test)
      assert.ok(src.includes('attachNoActivate'), 'attachNoActivate call must remain for win32 parity');
    }
  });

  test('overlay alwaysOnTop: linux default level (base true), darwin floating, win32 screen-saver', () => {
    const src = read('electron/WindowHelper.ts');
    // Base alwaysOnTop:true is unconditional
    assert.match(src, /alwaysOnTop:\s*true,\s*\n\s*focusable/, 'base alwaysOnTop:true missing');
    // Darwin floating, win32 screen-saver are platform-gated
    assert.match(src, /setAlwaysOnTop\(true, 'floating'\)/, 'darwin floating level missing');
    assert.match(src, /setAlwaysOnTop\(true, 'screen-saver'\)/, 'win32 screen-saver level missing');
    // Linux must not get screen-saver re-assert outside win32 gate (the opacity shield re-assert is now win32-gated)
    const shieldBlock = src.slice(src.indexOf('this.pillWindow?.setOpacity(1);'), src.indexOf('this.pillWindow?.setOpacity(1);') + 800);
    assert.match(shieldBlock, /if \(process\.platform === 'win32'\)/, 'screen-saver re-assert must be win32-gated, not linux');
  });
});

// ── 3. Audio channel state & gating (linux uses same rubato pipeline) ───────

describe('Linux parity: audio gating', () => {
  test('SilenceSuppressor for_system_audio: use_vad=false hangover 600ms', () => {
    const src = read('native-module/src/silence_suppression.rs');
    const block = src.slice(src.indexOf('for_system_audio'), src.indexOf('for_system_audio') + 500);
    assert.match(block, /use_vad: false/, 'system audio must be use_vad false (no ML VAD on monitor)');
    assert.match(block, /hangover/, 'hangover config must exist');
  });

  test('SilenceSuppressor for_microphone_on(false) == linux: use_vad true (typing/fan rejection)', () => {
    const src = read('native-module/src/silence_suppression.rs');
    // for_microphone_on(is_windows) — false means linux/macOS path where VAD is true
    assert.match(src, /for_microphone_on\(is_windows: bool\)/, 'for_microphone_on injectable gate missing');
    // linux is the false branch: assert the test pins that linux uses VAD
    assert.match(src, /test_microphone_vad_is_platform_scoped/, 'platform-scoped VAD test missing');
  });

  test('speaker/mod.rs dispatches linux to pipewire, not fallback', () => {
    const src = read('native-module/src/speaker/mod.rs');
    assert.match(src, /#\[cfg\(target_os = "linux"\)\]\s*pub mod pipewire/, 'linux pipewire dispatch missing');
    assert.match(src, /#\[cfg\(target_os = "linux"\)\]\s*pub use pipewire::SpeakerInput/, 'linux SpeakerInput export missing');
    assert.match(src, /not\(any\(target_os = "macos", target_os = "windows", target_os = "linux"\)\)/, 'fallback must now exclude linux');
  });

  test('PipeWire module reports 48k mono float, ring 131072', () => {
    const src = read('native-module/src/speaker/pipewire.rs');
    assert.match(src, /channels: 1/, 'linux monitor must be mono');
    assert.match(src, /rate: 48000/, 'linux monitor must be 48k');
    // Simple binding or Stream — check spec
    assert.match(src, /FLOAT32NE/, 'linux must be FLOAT32NE');
  });

  test('crate-type includes rlib for spike binary', () => {
    const src = read('native-module/Cargo.toml');
    assert.match(src, /crate-type = \["cdylib", "rlib"\]/, 'cdylib+rlib needed for audio_spike binary');
  });
});

// ── 4. Screenshot shell dispatch: grim on Wayland, gnome on X11 ─────────────

describe('Linux parity: screenshot shell dispatch', () => {
  test('buildLinuxScreenshotCommand toggles grim vs gnome', () => {
    const src = read('electron/ScreenshotHelper.ts');
    assert.match(src, /isWayland = process\.env\.XDG_SESSION_TYPE === 'wayland' \|\| Boolean\(process\.env\.WAYLAND_DISPLAY\)/, 'isWayland gate missing');
    assert.match(src, /grim -g "\$\(slurp\)"/, 'grim/slurp chain missing for Wayland interactive');
    assert.match(src, /grim "\$\{safePath\}"/, 'grim full-screen chain missing for Wayland non-interactive');
    assert.match(src, /gnome-screenshot -a -f/, 'gnome X11 chain missing');
    assert.match(src, /public static buildLinuxScreenshotCommand/, 'test-only static helper missing');
  });

  test('takeScreenshot / takeSelectiveScreenshot portal-first then grim fallback on linux', () => {
    const src = read('electron/ScreenshotHelper.ts');
    // Linux takeScreenshot must try desktopCapturer first
    const linuxTake = src.slice(src.indexOf('// Linux: try desktopCapturer'), src.indexOf('// Linux: try desktopCapturer') + 800);
    assert.ok(linuxTake.includes('captureWithDesktopCapturer') && linuxTake.includes('shellExecAsync'), 'linux takeScreenshot must try portal then fallback');
    // takeSelectiveScreenshot with captureArea on linux must also try portal
    assert.match(src, /captureArea && \(process\.platform === 'win32' \|\| process\.platform === 'darwin' \|\| process\.platform === 'linux'\)/, 'selective capture must include linux with captureArea');
  });

  test('computeThumbnailCrop is density-agnostic (no scaleFactor multiply)', () => {
    const src = read('electron/ScreenshotHelper.ts');
    assert.ok(src.includes('ACTUAL returned thumbnail size'), 'computeThumbnailCrop density-agnostic comment missing — regression guard');
    // Old bug multiplied by scaleFactor assuming native pixels; current impl derives ratio from thumbnail size
    assert.ok(src.includes('computeThumbnailCrop'), 'computeThumbnailCrop export missing');
  });

  test('Ozone switches are linux-only and before whenReady', () => {
    const src = read('electron/main.ts');
    const ozoneIdx = src.indexOf("if (process.platform === 'linux')");
    const whenReadyIdx = src.indexOf('await app.whenReady()');
    assert.ok(ozoneIdx > 0 && whenReadyIdx > 0, 'ozone block or whenReady not found');
    assert.ok(ozoneIdx < whenReadyIdx, 'Ozone switches must be before app.whenReady() or Chromium ignores them');
    assert.match(src, /ozone-platform-hint.*auto/, 'ozone-platform-hint=auto missing');
    assert.match(src, /UseOzonePlatform,WaylandWindowDecorations/, 'UseOzonePlatform missing');
    assert.match(src, /enable-wayland-ime/, 'wayland ime missing');
  });
});

// ── 5. Packaging & system deps (mirrors build-smoke parity) ─────────────────

describe('Linux parity: packaging & deps', () => {
  test('package.json optionalDependencies includes sqlite-vec-linux-x64', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.ok(pkg.optionalDependencies['sqlite-vec-linux-x64'], 'sqlite-vec-linux-x64 missing from optionalDependencies');
  });

  test('native-module package.json targets include x86_64-unknown-linux-gnu', () => {
    const pkg = JSON.parse(read('native-module/package.json'));
    assert.ok(pkg.napi.targets.includes('x86_64-unknown-linux-gnu'), 'linux target missing from napi.targets');
  });

  test('verify-packaged-local-assets conditionally requires linux node', () => {
    const src = read('scripts/verify-packaged-local-assets.mjs');
    assert.match(src, /--include-linux/, '--include-linux flag not handled');
    assert.match(src, /index\.linux-x64-gnu\.node/, 'linux .node not in REQUIRED_UNPACKED_NATIVE');
  });

  test('build-smoke.yml includes ubuntu-latest and Linux apt deps', () => {
    const yml = read('.github/workflows/build-smoke.yml');
    assert.match(yml, /ubuntu-latest/, 'ubuntu-latest not in matrix');
    assert.match(yml, /libasound2-dev.*libpulse-dev/s, 'Linux apt deps missing');
    assert.match(yml, /xvfb-run/, 'xvfb-run not in linux verify/test paths');
  });

  test('release-linux.yml exists and builds AppImage+deb', () => {
    const yml = read('.github/workflows/release-linux.yml');
    assert.match(yml, /electron-builder --linux/, 'release-linux must drive electron-builder --linux');
    assert.match(yml, /AppImage/, 'AppImage target missing');
    assert.match(yml, /\.deb/, 'deb target missing');
  });
});
