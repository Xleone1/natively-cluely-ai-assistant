# Natively — Linux Support Engineering Plan (CachyOS / Wayland / PipeWire)

> **Scope:** Add full Linux support targeting **CachyOS (Arch) / Wayland / PipeWire** without breaking existing Windows/macOS behavior.  
> **Date:** 2026-09-01 · **Version:** 2.8.8 · **Mode:** Plan — no code changes required to read this document.  
> **Principle:** Every phase preserves both `darwin` and `win32` paths (CLAUDE.md cross-platform contract). A changed shared contract must be validated against all three platforms.

---

## Table of Contents

1. [Codebase Audit & Mapping](#1-codebase-audit--mapping)
2. [Architecture Delta](#2-architecture-delta)
3. [Linux Implementation Strategy](#3-linux-implementation-strategy-cachyos--wayland--pipewire)
4. [Required System Dependencies](#4-required-system-dependencies)
5. [Phased Execution Roadmap](#5-phased-execution-roadmap)
6. [Testing & Verification Matrix](#6-testing--verification-matrix)
7. [Risks & Mitigations](#7-risks--mitigations)
8. [Open Questions](#8-open-questions-for-owner)
9. [Appendix — Absolute File Map](#9-appendix--absolute-file-map)

---

## 1. Codebase Audit & Mapping

### 1.1 Method

Three parallel sub-agents plus manual source reads. Search surface:

- `process.platform`, `darwin`, `win32`, `isMac`, `isWindows`, `#[cfg(...)]`, `platform-utils`
- `wasapi`, `coreaudio`, `cpal`, `pipewire`, `pulse`, `audio`, `mix`, `vad`, `ring`, `16k`, `f32`
- `BrowserWindow`, `desktopCapturer`, `getSources`, `screen`, `capture`, `overlay`, `alwaysOnTop`, `transparent`, `setContentProtection`, `SetWindowDisplayAffinity`, `NSWindow`, `wayland`, `portal`
- `ort`, `onnx`, `whisper`, `moonshine`, `CoreML`, `DirectML`, `CUDA`, `execution.*provider`
- Globs: `**/*.rs`, `**/*.cpp`, `**/*audio*`, `**/*capture*`, `native-module/**`, `electron/**`, `**/Cargo.toml`, `**/build.rs`, `**/vite.config*`, `.github/**`, `scripts/**`, `patches/**`

---

### 1.2 Audio Capture Pipeline

#### Dual-channel, no mixing

Two independent pipelines — never mixed — each a separate `LocalWhisperSTT` / cloud STT instance labeled `mic` vs `system`. Free diarization from hardware-derived channel attribution.

- `electron/audio/LocalWhisperSTT.ts:4-6` — "Dual-channel architecture: Mic and System Audio as two completely separate native streams"
- `electron/main.ts:startCaptureChannels()` / `createSTTProvider()` instantiates twice
- No audio mixing node; only joint logic is `channel_state.rs:262` folding per-channel `SpeechEdge` into `JointState::{Neither, InterviewerSpeaking, UserSpeaking, Both}` for Auto-Answer gating

#### Native Rust module (`native-module`: `natively-audio` v0.1.0, `cdylib`)

| Dependency | Version | Role |
|------------|---------|------|
| `cpal` | 0.15.2 | Cross-platform mic input (all platforms) — `Cargo.toml:14` |
| `wasapi` | 0.13.0 | Windows system loopback — `Cargo.toml:48`, `speaker/windows.rs:13` |
| `cidre 0.11.10` (`ca`,`sc`,`cm`) + `core-graphics`/`core-foundation` | 0.11+ | macOS CoreAudio Tap + ScreenCaptureKit — `Cargo.toml:30-45` |
| `ringbuf` | 0.4 | SPSC lock-free ring buffers — both pipelines |
| `rubato` | 0.16 | Polyphase FIR sinc resampler to 16 kHz |
| `webrtc-vad` | 0.4 | ML VAD (mic only on macOS) |
| `napi`/`napi-derive` | 3.8.3 / 3.5.2 | Zero-copy Buffer ABI to Node |
| `windows` | 0.52 | Win32 WASAPI + `WH_KEYBOARD_LL` |

No `*.cpp` files. `pipewire`/`pulse` grep in `native-module` returns only CSS — no PipeWire/Pulse backend exists.

**Entry:** `native-module/src/lib.rs:186-779` — exports `SystemAudioCapture` (186-455) and `MicrophoneCapture` (465-727) via `napi`; `BatchEmitter` (74-133) coalesces 3×20 ms frames; `i16_slice_to_le_bytes` (70-72) via `bytemuck::cast_slice`.

**Loader:** `electron/audio/nativeModuleLoader.ts:185-272` — `getNativeBinaryName()` → `npx napi build` artifacts: `index.darwin-{arm64,x64}.node`, `index.win32-{x64,ia32,arm64}-msvc.node`, `index.linux-{x64-gnu,arm64-gnu}.node`; tries `process.resourcesPath/app.asar.unpacked/native-module/<binary>` in packaged, then dev paths.

#### Microphone pipeline (`cpal`, cross-platform with Windows tuning)

- `native-module/src/microphone.rs:22-438` — `list_input_devices()`, 3-tier fuzzy `resolve_input_device()` (WASAPI `"(2- USB Audio Device)"` prefix, unicode dash), `pick_supported_config()` `F32>I16>I32` @ ≤48 kHz, `MicrophoneStream` (SPSC `HeapRb<f32>`, `err_signal` for USB-unplug), `build_input_stream()` real-time-safe `try_push` with mono downmix.
- `electron/audio/MicrophoneCapture.ts:138-343` — lazy init (avoids macOS orange mic indicator pre-`whenReady`), deferred `setImmediate` teardown, `preWarmEnabled`, `retargetDevice()` with `_orphanTeardown` to avoid WASAPI exclusive-mode race.

#### System / speaker pipeline — platform split

**Dispatch:** `native-module/src/speaker/mod.rs:3-88`

- `#[cfg(target_os="macos")]` → `macos.rs` + `core_audio.rs` + `sck.rs`
- `#[cfg(target_os="windows")]` → `windows.rs`
- `#[cfg(not(any(macos,windows)))]` → Linux fallback stub (issue #219) — `new()` always `Err("Unsupported platform")`, exists only so `lib.rs` type-checks on Linux.

**macOS — two backends, automatic fallback** (`speaker/macos.rs:18-44` tries CoreAudio → SCK; `deviceId=="sck"` forces SCK):

- **CoreAudio Process Tap** (preferred, macOS 14.4+, `speaker/core_audio.rs:33-360`): gate `ProcessInfo.is_os_at_least_version(14.4.0)`, `TapDesc::init_excluding_processes_and_device` `set_mono/mixdown/mute_behavior(Unmuted)`, aggregate device `"NativelySystemAudioTap"` (UUID private, `tap_auto_start=true`), ring `HeapRb<f32>(131072)` ~2.7 s @48k mono, IO proc reports ASBD rate (AirPods HFP 24 k demonic-voice fix).
- **ScreenCaptureKit fallback** (macOS 13.0+, `speaker/sck.rs:58-405`): gate `13.0.0`, global system audio `excludesCurrentProcessAudio=true`, `SCStreamCfg` 48 kHz mono queue_depth 8.

**Windows — WASAPI Loopback** (`speaker/windows.rs:120-320`): `ShareMode::Shared` `SampleType::Float` event-driven `h_event.wait_for_event(3000)`, `WaveFormat F32 mono @ mix rate`, stale device-ID fallback; limitation: only `eMultimedia`/`eConsole` (VoIP `eCommunications` separate device).

#### Audio formats downstream — canonical contract

**STT input is always `i16 LE mono @ 16000 Hz`** unless resampler unavailable (passthrough at native rate with matching declared rate to avoid chipmunk).

- `native-module/src/lib.rs:48` `CANONICAL_STT_RATE=16000`; `audio_config.rs:5 SAMPLE_RATE 16_000`, `FRAME_MS 20 → 320 samples`, `RING_BUFFER_SAMPLES 32768` (mic/WASAPI) / `131072` (CoreAudio/SCK), `CHUNK_BATCH_COUNT 3` → 60 ms per JS callback, `DSP_POLL_MS 5`
- Rust: `HeapRb<f32>` → drain `Vec<f32>` → `rubato FftFixedIn( input_rate, 16000, 1024, 2, 1)` → `i16` → `bytemuck cast` → `napi Buffer` → `BatchEmitter` coalesces 3 chunks (≈1920 bytes)
- Cloud: `Buffer` → `audioResampler.ts:resampleToF32` (linear interp if not 16 k) → `VadProcessor` → whisper worker `transcribe`; REST upload `addWavHeader(...,16000, mono)`
- Local Whisper: `Float32Array` @16k, window 480 (30 ms), streaming intervals 280-1500 ms (Whisper 1500/800, Moonshine 750/400, Nemotron 280/560), min audio 400-800 ms, max segment 14 s soft-commit / 15 s hard flush, `vadProcessor.ts:14-18` `RMS 0.008 hangover 10 frames`

#### Mixing / VAD / ring buffers — three distinct VADs, no mixing

| VAD | Location | Purpose | Gates audio? |
|-----|----------|---------|--------------|
| UI-only `VadIndicator` | `native-module/src/vad.rs:140` `RMS 185→100 hangover 500ms` | "Speaking" dot | No |
| `SilenceSuppressor` (RMS + webrtc-vad) | `native-module/src/silence_suppression.rs:580` `EMA α0.02 mult 3.0`; `for_system_audio: use_vad=false hangover 600ms` vs `for_microphone: !use_vad` on Windows, `use_vad=true` on macOS | **Real audio gating** → `FrameAction::Send/SendSilence/Suppress` + `SpeechEdge` | **Yes** — `lib.rs:390/666` drives `tsfn` + `speech_ended` |
| `VadProcessor` | `electron/audio/whisper/vadProcessor.ts:214` `30ms RMS 0.008 hangover 10` | Whisper chunking | Gates Whisper worker only |

**Rings:** one `ringbuf::HeapRb<f32>` SPSC per channel, real-time-safe `try_push`/`push_slice` + `Condvar`, `while let Some(sample)=consumer.try_pop()` drain in DSP thread.

#### Platform conditionals in audio

- `#[cfg]` — `speaker/mod.rs:13 hits`, `lib.rs:3 hits` (`stealth_window`, `keyboard_*`), plus `#[cfg(test)]` elsewhere
- `cfg!(target_os="windows")` — `silence_suppression.rs:113 for_microphone_on(is_windows)` injectable, `channel_state.rs:109 for_platform(cfg!(windows)) user_edges_vad_backed = !is_windows`
- `process.platform` in audio JS wrappers: **zero** in `MicrophoneCapture.ts`/`SystemAudioCapture.ts` — variance encapsulated in Rust; only `native-module/index.js:106,176` loader and `main.ts` health logging branch on platform

### 1.3 Screen Capture & OCR / Multimodal

#### Capture is `desktopCapturer` only — no native pixel bindings

46 hits for `desktopCapturer|getSources`:

- `electron/main.ts:11,955,8863` — import + TCC probe `getSources raced 5s`
- `electron/ScreenshotHelper.ts:212` `sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{maxWidth,maxHeight}})` (multi-display) + `523` single-display `captureWithDesktopCapturer` — **single source of truth, 922 lines**
- Never invokes `Win32 GDI` (`BitBlt`/`DXGI`), `Quartz` (`CGWindowListCreateImage`), or `ScreenCaptureKit` pixels in Rust; `screenshot-desktop@1.15.0` present in `package.json:350` but never called at runtime
- **Linux fallback — X11 shell only:** `ScreenshotHelper.ts:648 getScreenshotCommand() → gnome-screenshot -a -f || scrot -s || import` (interactive) / `-f` non-interactive `L:648-663`, via `util.promisify(execShell)`

#### Screenshot pipeline — two layers, density-agnostic math

- Permission gate `assertScreenRecordingPermission():31-60` — no-op off `darwin`, dev bypass `!app.isPackaged`, switch on `systemPreferences.getMediaAccessStatus('screen')`
- `computeThumbnailCrop(sourceSize, displayBounds, areaAbs):131` — ratio derived from **actual** `thumbnail.getSize()` vs `displayBounds` (not `scaleFactor` assumption), clamps into `[0,sourceSize]`, shared by both paths (`L:297` + `605`); `MAX_THUMBNAIL_RATIO=10` guards absurd DPI
- Single-display `captureWithDesktopCapturer(outputPath, area?, preferredDisplay?):476-632` — resolves `preferredDisplay ?? getDisplayContainingRect(area) ?? primary`, `thumbnailSize` = logical size as latency hint (avoids 2-3× decode), builds `display_id` map `L:558-570` with index fallback
- Multi-display `getDisplaysIntersectingSelection:185` → per-display `computeThumbnailCrop` → `cropped.toPNG()` push `DisplayCapture`; `stitchImages:345` via `sharp` composite `channels:4 transparent` (33 MB×N note), per-capture `resize` to normalize DPI
- Queue: `MAX_SCREENSHOTS=5`, `userData/{screenshots,extra_screenshots}`, atomic rotation, `getImagePreview:858` downscale 480 px JPEG 70%
- Public API: `takeScreenshot(preferredDisplay?)` → `captureWithDesktopCapturer` on `darwin||win32`, else shell; `takeSelectiveScreenshot(captureArea?)` → stitched vs single-display vs linux `getScreenshotCommand(...,true)`

#### Active-window / display tracking

No `GetForegroundWindow`/`CGWindowList` native call. Logical tracking via `screen` (`electron/main.ts:7151-7313`):

- `createScreenshotCaptureSession(captureKind, restoreFocus):7151` snapshots `overlayBounds:getLastOverlayBounds()`, `overlayDisplayId:getLastOverlayDisplayId()`, `restoreWithoutFocus`
- `getTargetDisplayForFullScreenshot(session):7207` priority: `overlayBounds → screen.getDisplayMatching` else `getDisplayById(overlayDisplayId)` else `getCursorScreenPoint`
- Focus choreography `withScreenshotCaptureSession:7279` — `hideWindowsForScreenshot` → wait `80ms darwin / 40ms other` (one v-sync) → `await capture` → `restoreWindowsAfterScreenshot` (ordering: stealth re-engages last for `WH_KEYBOARD_LL` ordering)
- Cropper `CropperWindowHelper.ts:196` reports window-local `e.clientX` → global via `cropperBounds`, validates `validateBounds:257` against `getCombinedDisplayBounds()`

### 1.4 Window Management & Overlay Display

#### Technology: Electron `BrowserWindow` exclusively

`electron/WindowHelper.ts:1` owns 5 windows; `SettingsWindowHelper.ts`, `ModelSelectorWindowHelper.ts`, `CropperWindowHelper.ts` wrap one each. No Tauri, no webview. Single renderer entry `startUrl = isDev ? http://localhost:5180 : file://dist/index.html` with `?window=launcher|overlay|cropper|settings|modelSelector`.

#### Overlay construction (`WindowHelper.createWindow():500-918`)

Constants: `OVERLAY_DEFAULT_WIDTH 732`, `OVERLAY_MIN_HEIGHT 216`, `PILL_STACK_OFFSET 52`, etc.

- **Launcher:** `frame: isMac?hiddenInset:false`, `vibrancy:'under-window'` (mac), `transparent:true` (ALL platforms — required even on Windows for opacity-preview), `backgroundColor:'#000000'`
- **Overlay:** `{width:732,height:1, frame:false, transparent:true, backgroundColor:'#00000000', alwaysOnTop:true, focusable:true, resizable:false, movable:true, skipTaskbar:true, hasShadow:false, ...(isMac?{type:'panel'}:{})}` + win32 `attachNoActivate L:817-822`, unconditional `setContentProtection(true) L:828`, `syncOverlayInteractionPolicy() L:832`, mac batch `setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true}) L:851`, `setHiddenInMissionControl L:852`, `setAlwaysOnTop(true,'floating') L:853`; win32 `setAlwaysOnTop(true,'screen-saver') L:899`
- **Pill/toggle aux windows:** tiny `BrowserWindow`s (hug-at-rest), welding `setParentWindow` macOS-only child-window group `L:104-129`, managed drag `overlayGroupDragManaged L:130-148` bypasses `WM_SYSCOMMAND/SC_MOVE` modal loop

#### Transparency / alwaysOnTop / click-through / layer

| Concern | Code | Wayland gap |
|---------|------|-------------|
| `transparent` | `WindowHelper:550,794`, `Cropper:109`, `Settings:211`, `ModelSelector:162` | Needs Ozone Wayland; works as floating, not layer-shell |
| `frameless` | `WindowHelper:793 frame:false` | OK |
| `alwaysOnTop` level | `796 base true; 853 mac floating; 899 win screen-saver` | Wayland has no `screen-saver` — normalized to compositor floating |
| `visibleOnAllWorkspaces` | `851 + visibleOnFullScreen` | No-op on Wayland |
| `setIgnoreMouseEvents` | `1354 syncOverlayInteractionPolicy → setIgnoreMouseEvents(true,{forward:true})` when `overlayHoverInteractive===false` | Needs hit-test forwarding via compositor |
| `capture-exclusion` | `setContentProtection(true)` → macOS `NSWindowSharingNone` / Windows `WDA_EXCLUDEFROMCAPTURE` | **No Wayland equivalent** — portal-controlled |

#### Capture-exclusion defense-in-depth

1. **JS unconditional:** `WindowHelper.applyContentProtection:271` forces `setContentProtection(true)` on `overlay+pill+toggle` even when undetectable OFF (ghosts independent of feature flag)
2. **Native ObjC (macOS 15 harden):** `stealth_window.rs:51 apply_stealth_to_window` → `NSView→NSWindow` `setBecomesKeyOnlyIfNeeded:HidesOnDeactivate:collectionBehavior(CanJoinAllSpaces|FULL_SCREEN_AUXILIARY|IGNORES_CYCLE)`, `NSWindowSharingNone`, private SPI `_setPreventsActivation:YES` (`kCGSPreventsActivationTagBit`), called from `WindowHelper:881`, `Cropper:647`, `Settings:282`, `ModelSelector:240`
3. **Windows no-activate:** `windowsFocusPolicy.ts:74 attachNoActivate → setFocusable(false)` + `blur/hide` re-arm, gated `hookAvailabilityProvider` (skip if hook missing)
4. **Dock/taskbar:** `main.ts:7534 setUndetectable`, `WindowHelper.syncLauncherTaskbarForStealth:315 → setSkipTaskbar`

Wayland: none of the above translate; portal is the only exclusion.

### 1.5 Local Model Acceleration (ONNX Runtime / ML)

#### Provider resolution — `electron/audio/whisper/inferenceConfig.ts:206-233` single source of truth

```ts
if (platform==='darwin' && arch==='arm64') return { executionProviders:['coreml','cpu'], dtype: WHISPER_SAFE_DTYPE }
if (platform==='win32') return { executionProviders:['dml','cpu'], dtype: WHISPER_SAFE_DTYPE }
return { executionProviders:['cpu'], dtype: WHISPER_SAFE_DTYPE } // Intel Mac / Linux / unknown
```
- No `cuda` string anywhere. `WHISPER_SAFE_DTYPE = {encoder_model:'fp32', decoder_model:'q8', decoder_model_merged:'q8', decoder_with_past_model:'q8', model:'q8'}` — fp32 encoder for WER, q8 decoder for speed.
- `resolveNemotronExecutionProviders():176` forces `['cpu']` — measured (M-series 10c): `coreml+cpu` load 6436 ms infer 1158 ms RTF 0.47 vs `cpu` load 363 ms infer 936 ms RTF 0.38 — CoreML fragments 369 → copies per RNNT symbol.
- `resolveAppleSiliconDtype():188` reads `SettingsManager.get('whisperAppleSiliconDtype')`.

#### Worker execution

- `electron/audio/whisper/whisperWorker.ts:276-280` — `env.backends.onnx.executionProviders = providers`; `getBoundedOnnxSessionOptions()` from `onnxThreadConfig.ts`; supports Whisper/Distil-Whisper + Moonshine + Nemotron (dual-channel shared sessions + `nemotronChains` serialize per channel)
- `electron/audio/whisper/nemotron/nemotronEngine.ts:2,89-173` — `import {InferenceSession,Tensor} from 'onnxruntime-node'`, `createSessionWithFallback()` → `['cpu']` on failure, `new Tensor('float32', mel, [1,N,N_MELS])`

#### Thread / memory hardening — `electron/utils/onnxThreadConfig.ts:129-432`

- `getBoundedOnnxSessionOptions(workload)` — `intraOpNumThreads: rnnt-decode? capped/2 : 1`, `interOpNumThreads:1`, `executionMode:'sequential'`, `enableCpuMemArena:false`, `enableMemPattern:false` (post-mortem: 9 crashes `BFCArena::Extend posix_memalign` with 16-17 ORT threads)
- Global semaphore `globalThis.__nativelyOnnxSemaphoreV1__ cap 2` (not per-bundle), high-priority for Whisper; exclusive mode for `weight>cap` (Nemotron weight 3)
- `getAvailableMemoryGB()` — **not** `os.freemem()` on macOS (returns 100-400 MB would block); instead `darwin: vm_stat (free+inactive+speculative)`, `linux: /proc/meminfo MemAvailable`, fallback `os.freemem()`; floor `NATIVELY_ONNX_MIN_FREE_GB=2.0`

#### Model catalog — `electron/audio/whisper/modelManager.ts`

~18 entries: Moonshine Tiny 26 MB / Base 60 MB; Parakeet CTC 0.6B 583 MB `single` `externalDataFormat`; Nemotron int4 793 MB `nemotron-rnnt` (6 onnx + 3 tokenizer); Distil-Whisper small/medium/large-v3, Whisper Large v3 Turbo 1031 MB, whisper tiny/base/small/medium; `getModelsDir() → app.getPath('userData')/whisper-models`, `isModelCached()` checks `encoder_model{q8|fp32}.onnx` companions.

Other ONNX consumers share same gate: `LocalEmbeddingProvider` (`Xenova/all-MiniLM-L6-v2` 384d), `LocalReranker` (`Xenova/bge-reranker-base` q8 280 MB), `IntentClassifier` (`Xenova/mobilebert-uncased-mnli`), Smart Turn v3.1 (`resources/models/pipecat-ai/smart-turn-v3/` raw `InferenceSession.create`).

### 1.6 Build System & Dependencies

#### Rust — `native-module/Cargo.toml:74`

- `[lib] crate-type=["cdylib"]`, `napi 3.8.3 (napi4)`, platform conditionals: `[target.'cfg(macos)'.dependencies] cidre/objc2/core-graphics/core-foundation` vs `[target.'cfg(windows)'.dependencies] wasapi+windows 0.52`; **no `[target.cfg(linux)]` block** — Linux falls to unconditional `cpal+generic DSP`, compiles but no system-audio backend
- `native-module/package.json:7 napi.binaryName index targets defaults` → `napi build --platform --target <triple>`
- No `build.rs`, no `binding.gyp`; `native-module/.cargo/config.toml` exists

#### `package.json:113-255` build

- Engines `node>=22.6.0`, `electron 43.1.0`, `electron-builder 26.8.1`, `napi-rs/cli 3.5.1`, `sharp 0.34.5`; `onnxruntime-common/node 1.22.0` pinned
- `optionalDependencies:361` `sqlite-vec-darwin-arm64/x64`, `sqlite-vec-windows-x64` — **missing** `sqlite-vec-linux-*`
- `build.files` + `asarUnpack` includes `*.node, *.dylib, whisperWorker.js, @huggingface/transformers, onnxruntime-*`; `extraResources` copies `assets/ → assets/`, `resources/models/ → models/`
- `build.mac:175 zip+dmg x64+arm64 identity:null hardenedRuntime:false` (signed.cjs flips), `build.win:202 nsis+portable x64 only`, `build.linux:220 AppImage+deb x64 only` vs `build-native.js:152 linux arm64/arm` — **arch mismatch**, README "Linux limited" is known gap
- Scripts `postinstall:22 patch-package && npm rebuild sharp && rebuild-native-electron && download-models && ensure-sqlite-vec && ensure-napi-canvas-mac-deps && patch-electron-plist && verify-native-arch` — `ensure-*` are mac-only (`skipped` off darwin)

#### `scripts/build-native.js:284`

- `darwin`: `rustup target add`, `npx napi build --platform --target x86_64/aarch64-apple-darwin`, `LIBRARY_PATH` from `clang -print-resource-dir`, `fixMacOSDylibPaths` via `otool -L` + `install_name_tool @loader_path`
- `win32/linux`: `artifactMap win32 {x64,ia32,arm64} linux {x64:linux-x64-gnu, arm64:linux-arm64-gnu, arm:linux-arm-gnueabihf}` but only `os.arch()` emitted; win32 DLL-lock `rename→stale` mitigation; Linux is passthrough — no `ldd` verification

#### `scripts/build-electron.js:175`

esbuild bundle `electron+premium .ts → dist-electron`, `platform:node target:node20 format:cjs`, externals include `electron, better-sqlite3, keytar, sqlite-vec, onnxruntime-node`; copies `riva_asr.proto`.

#### `electron-builder.signed.cjs:100` / CI

- Production signing reuses `package.json` build, `identity: auto BJM29W3UQ6`, `hardenedRuntime:true`, `entitlements.mac.plist`, `afterSign: ./scripts/notarize.js` (staple-retry for Error 65), `afterAllArtifactBuild` rebuilds DMGs via `create-dmg`
- No linux builder config — single config handles `darwin|win32|linux` via `package.json build.linux`

#### `.github/workflows/build-smoke.yml:426` — matrix `os: [macos-latest, windows-latest]` `fail-fast:false`; no `ubuntu-latest`; smoke scope fork vs full, premium submodule, `setup-node 22`, `npm ci`, `Verify native module arch` macOS-only, `Verify sqlite-vec` both, typecheck TS7/TS5, `build`, `Verify packaged local fallback assets`, `npm test` `continue-on-error: win32` (41 fails), `test:intelligence` enforcing both

#### `.github/workflows/release-macos.yml:243` — `on: push tags v*` `runs-on: macos-14 (Apple Silicon)` 180 min, `rust targets x86_64+aarch64-apple-darwin`; no `release-linux.yml`/`release-windows.yml` discovered

---

### 1.7 Summary — What Blocks Linux

| # | Gap | Impact | File(s) |
|---|-----|--------|---------|
| 1 | `speaker/mod.rs` stub always `Err` | System-audio capture broken | `speaker/mod.rs:29-88` |
| 2 | No `[cfg(linux)]` deps (`pipewire-rs`, `libpulse`, `zbus`) | Can't capture PipeWire monitor | `native-module/Cargo.toml` |
| 3 | Screenshot Wayland path missing | `desktopCapturer` may work via portal, but no portal CLI/D-Bus fallback; current shell is X11 only | `ScreenshotHelper.ts:648-765` |
| 4 | Window Wayland semantics missing | `alwaysOnTop:'screen-saver'`, `setVisibleOnAllWorkspaces`, `setContentProtection` don't map | `WindowHelper.ts:779-899`, `stealth_window.rs` |
| 5 | ONNX EP matrix no Linux GPU | Only `cpu` for Linux | `inferenceConfig.ts:230` |
| 6 | No Linux CI / release | Linux never built/tested | `.github/workflows/build-smoke.yml`, `release-macos.yml` |
| 7 | Missing `sqlite-vec-linux-*`, linux `sharp` | Vector search + image pipeline broken on Linux | `package.json:361`, `scripts/ensure-sharp-mac-deps.js` |
| 8 | `onnxThreadConfig` Linux mem probe untested | May mis-report | `onnxThreadConfig.ts:371` |

---

## 2. Architecture Delta

| Module | Verdict | Action | Risk to `darwin`/`win32` |
|--------|---------|--------|--------------------------|
| `microphone.rs` + `lib.rs` mic DSP (`resampler.rs`, `channel_state.rs`, `silence_suppression.rs`, `vad.rs`) | **Pure Rust — OS-agnostic** | No rewrite. Tune `for_microphone_on(false)` to keep `webrtc-vad=true` on Linux (like macOS, not Windows `false`); single knob. | None — injectable bool already. |
| `speaker/` | **Rewrite** | Add `speaker/pipewire.rs` (primary) + optional `speaker/pulse.rs` compat shim; extend `mod.rs` dispatch for `#[cfg(target_os="linux")]`. | None — `#[cfg]` isolates; shared `lib.rs` DSP unchanged. |
| `stealth_window.rs`, `keyboard_tap.rs`, `keyboard_hook_windows.rs` | **Polyfill / stub** | Linux: `stealth_window` no-op (Wayland has no `NSWindowSharingNone`); keyboard stealth needs `libei`/portal RemoteDesktop — defer to Phase 3. | None — `#[cfg(macos)]` / `#[cfg(windows)]` already gated. |
| `ScreenshotHelper.ts` | **Adapter** | Keep `desktopCapturer` primary (works on Wayland via PipeWire portal when permission granted); add Wayland interactive path `grim+slurp`/`wayfreeze` CLI; optional `ashpd`/`zbus` portal helper. Reuse `computeThumbnailCrop`. | Low — adds `XDG_SESSION_TYPE` branch; `darwin|win32` early-returns unchanged. |
| `WindowHelper.ts`, `CropperWindowHelper.ts`, `SettingsWindowHelper.ts` | **Adapter** | Gate Wayland flags: keep `transparent:true`, normalize `alwaysOnTop` level, guard `setVisibleOnAllWorkspaces`/`setHiddenInMissionControl`/`type:'panel'` as no-ops on Linux, keep `setContentProtection` best-effort (not Wayland-excluded). | Low — `if (process.platform!=='linux')` guards; existing tests inject `platform` param (`windowsFocusPolicy`, `CropperHelper.buildCropperWindowSettings(platform)`). |
| `inferenceConfig.ts` + `onnxThreadConfig.ts` | **Adapter** | Extend `resolveInferenceConfig()` for `linux` to probe `cuda`/`tensorrt`/`openvino`/`cpu`; keep Nemotron `cpu`; Linux mem probe already at `371` — add test. | None — new branch, existing `darwin`/`win32` branches untouched. |
| `native-module/Cargo.toml` | **Adapter** | Add `[target.'cfg(target_os="linux")'.dependencies]` (`pipewire 0.8`, `libpulse-binding 2` fallback, optional `zbus 5`/`ashpd`). | None — target-conditional. |
| `package.json` + `electron-builder` | **Adapter** | Add `optionalDependencies` `sqlite-vec-linux-x64/arm64`, Linux `sharp` ensure, expand `build.linux` arch matrix note, confirm `asarUnpack` `*.node`. | None — additive. |
| `scripts/*` + `.github/workflows` | **Adapter** | Add `ubuntu-latest` matrix, `apt` deps, `xvfb-run` xvfb, `npm ci --include=optional` linux verification, `release-linux.yml`. | None — matrix additive, `fail-fast:false` preserves `darwin`/`win32` signal. |

**Principle:** Shared business logic stays platform-independent. OS integrations behind explicit adapters (`feature/{shared,macos,windows,linux}.ts` or `feature.{darwin,win32,linux}.rs`). Exhaustive `switch (process.platform)` with `default: throw Unsupported`.

---

## 3. Linux Implementation Strategy (CachyOS / Wayland / PipeWire)

### 3.1 Audio — PipeWire Dual-Stream Capture

**Goal:** Two independent `f32` ring-buffer streams (mic + system monitor) → existing `lib.rs` DSP → 16 kHz `i16 LE` → `LocalWhisperSTT` dual instances. Same contract as Windows/macOS.

#### Library choice (ranked)

1. **`pipewire-rs 0.8` (preferred, native)** — `pw_stream` async API, creates `SPA_TYPE_OBJECT_ParamPortConfig` monitor stream without Pulse shim. Smallest latency, matches CachyOS default (`pipewire` + `wireplumber`). Requires `pipewire` system running; error bubbles to JS if not.
2. **`libpulse-binding 2 + libpulse-simple` (fallback)** — connect to `pipewire-pulse` compat as `PULSE_SOURCE = <default_sink>.monitor`. Covers most Arch/CachyOS desktops; easy `pa_context_connect` + `pa_stream_new` + `pa_stream_readable_size`. Latency slightly higher.
3. **`cpal` loopback (not sufficient)** — `cpal` on Linux enumerates `ALSA: pulse` devices but has no WASAPI-style `loopback` flag — keep `cpal` only for mic.

**Recommendation:** Ship `pipewire-rs` primary with `libpulse-binding` fallback behind a `DeviceId` probe (if `pipewire` connect fails, retry Pulse monitor). Both fit the same `SpeakerInput`/`SpeakerStream` trait.

#### Implementation sketch — `native-module/src/speaker/pipewire.rs`

Mirror `speaker/windows.rs` and `speaker/core_audio.rs` contracts so `lib.rs` is unchanged:

```rust
// native-module/src/speaker/pipewire.rs
pub struct SpeakerInput { device_id: Option<String> }
impl SpeakerInput {
    pub fn new(device_id: Option<String>) -> Result<Self> {
        // Resolve PipeWire node: default sink if None, else Node by name
        // Verify pw_main_loop + context available; Err("PipeWire not available") if not
    }
    pub fn stream(self) -> Result<SpeakerStream> {
        // Spawn capture thread, wait mpsc 5s for real sample_rate
        // (same timeout pattern as windows.rs:130-184 to avoid fake 44100 with zero samples)
    }
}
pub struct SpeakerStream { sample_rate: u32, consumer: HeapCons<f32> }
impl SpeakerStream {
    pub fn take_consumer(&mut self) -> Option<HeapCons<f32>> { ... }
    pub fn pause(&mut self) { ... }
    pub fn resume(&mut self) -> Result<()> { ... }
}
// Thread: pw_main_loop + pw_stream SPA_AUDIO_FORMAT F32LE mono 48k
// callback: f32 slice → mono downmix (avg stereo) → producer.push_slice + Condvar notify_all
```

- **Sample rate:** honor PipeWire graph rate (typically `48000`); push `f32` mono downmix into `HeapRb<f32>(131072)` (2.7 s) matching CoreAudio sizing; `lib.rs` DSP `rubato` handles resample to 16 k.
- **Device selection:** `default_output_device_uid()` = PipeWire default sink name (`@DEFAULT_SINK@` via `pw-cli` / `pactl get-default-sink`); `list_output_devices()` = `pw-cli ls Node` or `pactl list sinks short`.
- **Downstream:** reuse existing `lib.rs:300-430` DSP unchanged; `SilenceSuppressor::for_system_audio()` with `use_vad=false`, hangover 600 ms — keep Windows tuning (closer to PipeWire than macOS CoreAudio).
- **Error surfacing:** if PipeWire not running, `Err(anyhow!("PipeWire not available — install pipewire pipewire-pulse wireplumber"))` bubbles to `SystemAudioCapture.ts` → user-facing "System audio unavailable".

#### Mic interaction

Keep `microphone.rs` as-is. CachyOS mic is `alsa_input.*` → PipeWire graph → `cpal` host `pulse`. Verify `pick_supported_config()` `F32>I16>I32 @ ≤48k` still picks 48 k. No `cpal` change needed.

#### JS surface

`SystemAudioCapture.ts` / `MicrophoneCapture.ts` unchanged; `nativeModuleLoader.ts:259` already probes `index.linux-x64-gnu.node` from `app.asar.unpacked`. No `process.platform` branches added in audio wrappers — variance stays in Rust (CLAUDE.md isolation).

#### `native-module/src/speaker/mod.rs` dispatch

```rust
#[cfg(target_os="linux")]
pub mod pipewire;
#[cfg(target_os="linux")]
pub use pipewire::{list_output_devices, SpeakerInput, SpeakerStream, default_output_device_uid};
```

Fallback-order inside `pipewire.rs` (`libpulse` helper is `mod pulse;` private submodule, not a separate `#[cfg]` branch) keeps `mod.rs` trivial.

---

### 3.2 Capture — Wayland Screen Grabbing

#### Priority order (design for graceful degradation)

1. **Electron `desktopCapturer` (primary, zero code)**  
   On Wayland it goes through `xdg-desktop-portal` → PipeWire screencast stream (same portal as system-audio screencast) **if** Electron runs as Ozone Wayland client and portal is installed. First thing to validate — it may already work with correct flags. `ScreenshotHelper.ts:523 thumbnailSize = logical bounds` latency hint still valid.

2. **Rust / D-Bus portal helper (robust fallback, if `desktopCapturer` proves unreliable)**  
   `ashpd = { version="0.12", features=["tokio"] }` + `zbus 5` calling `org.freedesktop.portal.ScreenCast::CreateSession / SelectSources / Start` → PipeWire fd → `pw-stream` frame → PNG. Reuse `sharp` for crop/stitch. Exposed to JS via `napi` as `createPortalScreenshot(rect)`; JS orchestrates same `computeThumbnailCrop` + `stitchImages`.

3. **CLI compositor tools (dev / interactive fallback)**  
   `grim -g "$(slurp)" -` (wlroots/Hyprland/Sway), `grimblast`, `wayfreeze` killer feature for freeze-then-select. Extend `getScreenshotCommand(outputPath, interactive)`:

   ```ts
   // ScreenshotHelper.ts:648 — add wayland branch
   if (platform==='linux') {
     const isWayland = process.env.XDG_SESSION_TYPE==='wayland' || process.env.WAYLAND_DISPLAY;
     if (isWayland) {
       return interactive
         ? `grim -g "$(slurp)" "${safePath}" 2>/dev/null || grim -g "$(slurp -d)" "${safePath}"`
         : `grim "${safePath}" 2>/dev/null || gnome-screenshot -f "${safePath}" 2>/dev/null || scrot "${safePath}"`;
     }
     return interactive
       ? `gnome-screenshot -a -f "${safePath}" 2>/dev/null || scrot -s "${safePath}" 2>/dev/null || import "${safePath}"`
       : `gnome-screenshot -f "${safePath}" 2>/dev/null || scrot "${safePath}" 2>/dev/null || import -window root "${safePath}"`;
   }
   ```

**Crop math:** reuse `computeThumbnailCrop()` unchanged — portal returns native pixels, ratio derives from `thumbnail.getSize()` so 1× vs 2× is handled (same fix as `ScreenshotHelper.ts:139`).

**Permissions:** On Wayland, first `desktopCapturer.getSources` triggers portal dialog; cache probe result and surface clear "grant screen share in portal dialog" error (parallel to `assertScreenRecordingPermission` for macOS `31-60`).

---

### 3.3 Window & Overlay — Wayland Compositors

#### Phase 1-2 (minimal, ships)

Run Electron as Ozone Wayland client; `BrowserWindow {transparent:true, frame:false, alwaysOnTop:true, skipTaskbar:true, backgroundColor:'#00000000'}` works as floating window under KWin/Hyprland/Sway. Known limits documented, not blocked:

- `setContentProtection(true)` → **no Wayland `WDA_EXCLUDEFROMCAPTURE`/`NSWindowSharingNone`** — capture-exclusion is portal-controlled, not window-flag.
- `setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})`, `setHiddenInMissionControl` — **no-op** on Wayland (workspaces are compositor-specific).
- `type:'panel'` — **no-op** off macOS.
- `isMac?{vibrancy:'under-window'}` — **no-op** off macOS.

#### Electron flags — `electron/main.ts` before `app.whenReady()`

```ts
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform,WaylandWindowDecorations');
  if (process.env.XDG_SESSION_TYPE === 'wayland') {
    app.commandLine.appendSwitch('enable-wayland-ime', 'true');
  }
}
```

#### `WindowHelper.ts` / `CropperWindowHelper.ts` / `SettingsWindowHelper.ts` guards

```ts
// WindowHelper.createWindow() — overlay section
const isLinux = process.platform === 'linux';
const overlayOpts: Electron.BrowserWindowConstructorOptions = {
  width: OVERLAY_DEFAULT_WIDTH, height: 1,
  frame: false, transparent: true, backgroundColor: '#00000000',
  alwaysOnTop: true, focusable: true, resizable: false, movable: true,
  skipTaskbar: true, hasShadow: false,
  ...(isLinux ? {} : isMac ? { type: 'panel' as const } : {}),
};
// After creation:
win.setContentProtection(true); // best-effort on Linux (no-op if unsupported)
if (!isLinux) {
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // ... setHiddenInMissionControl, floating vs screen-saver levels
}
```

Existing tests already inject `platform` param (`windowsFocusPolicy.attachNoActivate(win,platform)`, `CropperWindowHelper.buildCropperWindowSettings(combinedBounds,platform)`, `WindowsPlatformParity.test.mjs`) — add `linux` branch assertions; no `process.platform` mutation in tests.

#### Phase 3 (layer-shell, optional, deferred)

Small Rust helper using `gtk4-layer-shell` or `smithay-client-toolkit` `wlr-layer-shell-unstable-v1` to create an overlay surface; Electron could run via XWayland fallback (`--ozone-platform=x11`). **Prefer not to implement** unless floating window proves insufficient — complexity vs benefit low. Guidance for v1: "share single window, not entire screen" + `setContentProtection` advisory in docs.

---

### 3.4 Hardware Acceleration — `ort` / ONNX Runtime

**Change:** `electron/audio/whisper/inferenceConfig.ts:206-233` — extend before final `return ['cpu']`:

```ts
if (platform === 'linux') {
  // Probe in order; first available wins, falls back to cpu
  // CUDA needs onnxruntime-node built with --use_cuda and nvidia driver present
  // TensorRT similarly; OpenVINO for Intel iGPU
  const avail = detectLinuxOrtProviders(); // e.g. try ort.getAvailableProviders() or fs probe
  if (process.env.NATIVELY_LINUX_CUDA === '1' && avail.includes('cuda')) {
    return { executionProviders: ['cuda','cpu'], dtype: WHISPER_SAFE_DTYPE };
  }
  if (avail.includes('tensorrt')) return { executionProviders: ['tensorrt','cpu'], dtype: WHISPER_SAFE_DTYPE };
  if (avail.includes('openvino')) return { executionProviders: ['openvino','cpu'], dtype: WHISPER_SAFE_DTYPE };
  return { executionProviders: ['cpu'], dtype: WHISPER_SAFE_DTYPE };
}
```

- `onnxruntime-node 1.22` Linux wheels ship `cpu` only by default; `cuda` build requires `onnxruntime-node-gpu` or custom `CUDAExecutionProvider` build. Propose **feature-gated opt-in** `NATIVELY_LINUX_CUDA=1` rather than default, to avoid driver coupling.
- Keep `resolveNemotronExecutionProviders()` CPU-only (existing benchmark holds).
- `onnxThreadConfig.ts` Linux mem probe (`/proc/meminfo:MemAvailable:371`) already exists — add unit test and CI verification; keep `intraOpNumThreads` cap 4 for `rnnt-decode`, arena disabled.

---

## 4. Required System Dependencies

### 4.1 Build-time (developer machine, CachyOS / Arch `pacman`)

```bash
sudo pacman -S --needed \
  base-devel clang pkgconf openssl \
  rustup nodejs npm \
  pipewire pipewire-pulse pipewire-alsa wireplumber \
  alsa-lib pulseaudio libpulse \
  dbus \
  libxcb xorg-xwayland \
  gtk4 libadwaita \
  vips sqlite \
  grim slurp wayland wl-clipboard xdg-utils \
  xdg-desktop-portal xdg-desktop-portal-hyprland xdg-desktop-portal-kde xdg-desktop-portal-gtk xdg-desktop-portal-wlr

# Optional GPU (only if cuda/tensorrt/openvino EP wanted; do not install by default)
sudo pacman -S --needed cuda cudnn tensorrt openvino

# Verify PipeWire graph is running
systemctl --user status pipewire pipewire-pulse wireplumber
pw-cli info 0 | head -20
pactl info | grep "Server Name"
```

| Package | Why | Phase |
|---------|-----|-------|
| `base-devel`, `clang`, `pkgconf`, `openssl` | `napi-rs` cdylib, `ringbuf`/`rubato`, `reqwest` (native-module) | 0,1 |
| `rustup` | `cargo`, `rustup target add` (build-native mac parity) | 0,1 |
| `nodejs>=22.6.0`, `npm`, `electron@43.1` | renderer + main build | 1 |
| `pipewire`, `pipewire-pulse`, `pipewire-alsa`, `wireplumber` | Dual-stream audio graph; CachyOS default | 0,1 |
| `alsa-lib`, `libpulse` | `cpal` ALSA/Pulse backends, `libpulse-binding` | 0 |
| `dbus`, `zbus` deps | Portal D-Bus (if ashpd path) | 2 |
| `gtk4`, `libadwaita` | Candidate layer-shell helper (Phase 3) | 3 |
| `vips`, `sqlite` | `sharp 0.34`, `better-sqlite3 12.11`, `sqlite-vec` | 1 |
| `grim`, `slurp`, `wayland`, `wl-clipboard` | Wayland screenshot CLI fallback | 2 |
| `xdg-desktop-portal` + impl (`-hyprland`/`-kde`/`-gtk`/`-wlr`) | `desktopCapturer` PipeWire portal | 2 |
| `libxcb`, `xorg-xwayland` | XWayland fallback for overlay if needed | 3 |
| `cuda`, `cudnn`, `tensorrt`, `openvino` | `ort` Linux GPU EPs (opt-in) | 4 |

**Ubuntu/Debian CI equivalent (`apt` for `build-smoke.yml` linux runner):**

```bash
sudo apt-get update && sudo apt-get install -y \
  build-essential clang pkg-config libssl-dev \
  libasound2-dev libpulse-dev libdbus-1-dev \
  libvips-dev libsqlite3-dev \
  grim slurp wayland-protocols \
  xdg-desktop-portal xdg-desktop-portal-gtk \
  xvfb
```

### 4.2 Runtime (end user, AppImage / deb — no `pacman` needed)

AppImage/deb bundles `sharp` linux `*.node`, `sqlite-vec-linux-*`, `onnxruntime-node` linux. User only needs running `pipewire` + `pipewire-pulse` + `wireplumber` + appropriate `xdg-desktop-portal-*` impl. Document one-liner:

```bash
systemctl --user --now enable pipewire pipewire-pulse wireplumber
```

---

## 5. Phased Execution Roadmap

### Overview

```
Phase 0  Headless CLI audio spike (PipeWire dual-stream → 16k → transcription)
   │
Phase 1  Native build fixes & CI decoupling (linux compiles + packages + CI green)
   │
Phase 2  Portal & screenshot (desktopCapturer + portal + grim fallback)
   │
Phase 3  GUI overlay & window lifecycle port (floating BrowserWindow, no layer-shell v1)
   │
Phase 4  Full integration & release (E2E on CachyOS, AppImage+deb, release-linux.yml)
```

---

### Phase 0 — Headless CLI Audio Verification (1–2 days)

**Goal:** Prove PipeWire dual-stream → canonical 16 kHz → transcription works in isolation, before touching Electron.

| # | Task | File(s) | Acceptance |
|---|------|---------|------------|
| 0.1 | Create `speaker/pipewire.rs` stub + `mod.rs` `#[cfg(linux)]` dispatch | `native-module/src/speaker/{mod,pipewire}.rs` | `cargo check --target x86_64-unknown-linux-gnu` passes |
| 0.2 | Add `[target.'cfg(linux)'.dependencies]` (`pipewire 0.8` or `libpulse-binding 2.1`) | `native-module/Cargo.toml` | `Cargo.lock` updated, `cargo build --release` produces `index.linux-x64-gnu.node` |
| 0.3 | Implement `SpeakerInput::new/stream` + thread (PipeWire monitor, `HeapRb<f32>(131072)`, `push_slice` + Condvar) | `pipewire.rs` | Matches `windows.rs`/`core_audio.rs` trait |
| 0.4 | CLI spike `cargo run --bin natively-audio-spike -- --seconds 5 --dump /tmp/natively-spike.wav` (mic cpal + system pipewire concurrently) | `native-module/src/bin/audio-spike.rs` (or `scripts/`) | `pw-top` shows two streams |
| 0.5 | Verify DSP: `ffprobe` 16 k mono `i16`, silence-suppressor not firing on silence, 5 s clip transcribes via `node scripts/smoke-packaged-local-fallback.mjs` | — | `RTF < 1.0` on `Xenova/whisper-tiny` cpu |

**Exit criteria:** `pw-top` two streams, `ffprobe` 16 k mono, transcription non-empty. No Electron changes.

---

### Phase 1 — Native Build Fixes & CI Decoupling (2–3 days)

**Goal:** Linux compiles, packages, and CI proves it — before GUI work.

| # | Task | File(s) |
|---|------|---------|
| 1.1 | Linux Rust build verification (`ldd` check, no `install_name_tool`; note `rpath` handling) | `scripts/build-native.js` |
| 1.2 | `package.json` `optionalDependencies` add `sqlite-vec-linux-x64` + `arm64` (`^0.1.7-alpha.2`) | `package.json:361` |
| 1.3 | Linux `sharp` ensure: extend `ensure-sharp-mac-deps.js` or add `ensure-sharp-linux-deps.js` (`@img/sharp-linux-x64`) | `scripts/ensure-sharp-linux-deps.js`, `scripts/ensure-sqlite-vec.js` |
| 1.4 | `inferenceConfig.ts` Linux EP branch (cpu default, cuda/tensorrt/openvino opt-in) | `electron/audio/whisper/inferenceConfig.ts:230` |
| 1.5 | `scripts/verify-packaged-local-assets.mjs` add `index.linux-x64-gnu.node` to `REQUIRED_UNPACKED_NATIVE` | `scripts/verify-packaged-local-assets.mjs:96` |
| 1.6 | `.github/workflows/build-smoke.yml` add `ubuntu-latest` to matrix, `apt-get` deps, `xvfb-run` for Electron tests, `npm ci --include=optional` linux verification, `verify-sqlite-vec-load.mjs` under `xvfb` | `.github/workflows/build-smoke.yml:49` |
| 1.7 | `.github/workflows/release-linux.yml` (new) — `ubuntu-22.04`, `tag v*`, `electron-builder --linux` AppImage+deb, upload `latest-linux.yml` | `.github/workflows/release-linux.yml` |
| 1.8 | `electron-builder` Linux target: keep `AppImage+deb x64`, document `arm64` future | `package.json:220`, `build-native.js:152` |

**Acceptance:** `npm run build:native` on CachyOS produces `native-module/index.linux-x64-gnu.node`; `electron-builder --linux` produces runnable `release/*.AppImage`; `build-smoke` linux leg green.

---

### Phase 2 — Native Build Fixes → Screenshot & Portal (2–3 days)

| # | Task | File(s) |
|---|------|---------|
| 2.1 | `electron/main.ts` Ozone switches before `app.whenReady()` | `electron/main.ts` |
| 2.2 | `ScreenshotHelper.ts` add `XDG_SESSION_TYPE` / `WAYLAND_DISPLAY` wayland branch in `getScreenshotCommand` + `takeScreenshot` linux `desktopCapturer` first, shell fallback second | `electron/ScreenshotHelper.ts:648,667,741` |
| 2.3 | Optional portal helper `ashpd`/`zbus` (defer unless `desktopCapturer` proves unreliable) | `native-module/src/portal.rs` or `electron/portal/screencast.ts` |
| 2.4 | Tests: `computeThumbnailCrop` Wayland fixture + `buildCropperWindowSettings('linux')` | `electron/services/__tests__/`, `scripts/__tests__/` |
| 2.5 | Manual verification: `desktopCapturer.getSources` on Hyprland/KWin/Sway Wayland → thumbnails → crop → PNG, not black; multi-display `stitchImages` | — |

**Acceptance:** `ScreenshotHelper.takeScreenshot()` + `takeSelectiveScreenshot(rect)` work on Wayland (portal consent → thumbnail → crop → PNG). `desktopCapturer` path preferred; CLI `grim` fallback works without portal.

---

### Phase 3 — GUI Overlay and Window Lifecycle Port (3–5 days)

| # | Task | File(s) |
|---|------|---------|
| 3.1 | `WindowHelper.createWindow()` Wayland guards: keep `transparent:true`, guard `type:'panel'`, `setVisibleOnAllWorkspaces`/`setHiddenInMissionControl`/`alwaysOnTop` level normalization as `if (!isLinux)` | `electron/WindowHelper.ts:500-918` |
| 3.2 | `CropperWindowHelper` / `SettingsWindowHelper` / `ModelSelectorWindowHelper` same guards | `electron/CropperWindowHelper.ts:99`, `SettingsWindowHelper.ts:207`, `ModelSelectorWindowHelper.ts:158` |
| 3.3 | `stealth_window.rs` `#[cfg(linux)]` no-op | `native-module/src/stealth_window.rs` |
| 3.4 | `windowsFocusPolicy.ts` / `overlayStealthFocusGuards` — no-op on Linux (stealth typing deferred) | `electron/utils/windowsFocusPolicy.ts` |
| 3.5 | Docs: CachyOS quickstart (Ozone flags, portal permission, "share window not screen" guidance) | `docs/` |
| 3.6 | Optional `gtk-layer-shell` helper — **deferred** unless floating window rejected | — |

**Acceptance:** Overlay floats, transparent, always-visible, draggable without `WM_SYSCOMMAND` modal loop; cropper spans `getCombinedDisplayBounds()` negative origins; no crash on `setContentProtection`; app launches under Wayland and XWayland.

---

### Phase 4 — Full Integration & Testing Checklist (2–3 days)

| # | Area | Checks |
|---|------|--------|
| 4.1 | Audio E2E (CachyOS Hyprland + KWin + Sway) | mic-only, system-only, dual-channel concurrent, Bluetooth HFP 24 k (`getNativeSampleRate`), device retarget `pactl set-default-sink` while running |
| 4.2 | Vision E2E | multi-display screenshot → vision prompt → answer, `vision_first` vs `private_vision`, `ImageOptimizer` profiles `fast/balanced/technical/best` |
| 4.3 | ONNX soak | `onnxThreadConfig` Linux `/proc/meminfo` mem probe, 2 concurrent Whisper sessions, Nemotron int4 chunked RNNT (`cap 2` weight 3 exclusive timeout), Smart Turn v3 |
| 4.4 | Packaging | AppImage + deb install on clean CachyOS VM (no dev deps), `verify-packaged-local-assets.mjs` green, `smoke-onnx-packaging.mjs` version match `1.22`, `sqlite-vec` vec0 under `xvfb` |
| 4.5 | Secure storage | `keytar` → `libsecret` (`secret-tool`); graceful fallback if no keyring |
| 4.6 | Parity harness | `WindowsPlatformParity`-style Linux parity tests (platform-injected `pipewire` vs `wasapi` vs `core_audio`) + `inferenceConfig` Linux branch unit tests |
| 4.7 | Release | `release-linux.yml` `ubuntu-22.04` tag `v*` `electron-builder --linux` upload AppImage+deb+`latest-linux.yml` alongside macOS `zip/dmg` |
| 4.8 | Perf | `RTF` Whisper cpu on CachyOS (target `< 0.5` for Moonshine Tiny, `< 1.0` for Whisper small); PipeWire latency vs macOS CoreAudio / Windows WASAPI (~20-40 ms acceptable) |

**Out of scope for v1:** layer-shell true overlay, `evdev`/`libei` stealth typing, CUDA bundled by default, `ia32`/`arm` Linux builds, `portal RemoteDesktop` keyboard injection.

---

## 6. Testing & Verification Matrix

| Suite | macOS (`darwin`) | Windows (`win32`) | Linux (`linux` Wayland) | CI |
|-------|------------------|-------------------|------------------------|----|
| `npm run build` + `build:electron` | ✓ | ✓ | **new** `xvfb-run` | `build-smoke` matrix `fail-fast:false` |
| `typecheck:electron` (TS7/TS5) | ✓ | ✓ | ✓ | matrix |
| `npm test` (Electron unit, 41-win fails known) | enforcing | `continue-on-error` | **new** `continue-on-error` initially | matrix |
| `test:intelligence` | enforcing | enforcing | enforcing | matrix |
| `test:lib` / `test:scripts` | enforcing | enforcing | enforcing | matrix |
| `verify-sqlite-vec-load.mjs` vec0 (`xvfb-run` on Linux) | ✓ | ✓ | **new** | matrix |
| `verify-packaged-local-assets` | ✓ | ✓ | **new** linux native assert | matrix |
| `smoke-onnx-packaging` | ✓ | ✓ | **new** | matrix |
| `ScreenshotHelper` crop/stitch unit | ✓ | ✓ | **new** wayland fixture | lib |
| `inferenceConfig` Linux branch unit | — | — | **new** | lib |
| Manual: PipeWire dual-stream + transcription | CoreAudio Tap vs SCK auto-fallback | WASAPI event-driven | **PipeWire monitor vs pulse fallback** | lab |
| Manual: overlay floating/transparent/alwaysOnTop | `floating` | `screen-saver` | **floating (KWin/Hyprland/Sway)** | lab |
| Packaging E2E | `zip+dmg` signed+notarized | `nsis+portable` | **AppImage+deb `xvfb`** | `release-*.yml` |

**After each phase gate:** `git diff --stat` review, `detect_changes` impact radius, re-run `typecheck:electron` on all three platform branches via injected `platform` param (do not mutate `process.platform`; prefer `createFeature(platform: NodeJS.Platform)` pattern per CLAUDE.md).

---

## 7. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Wayland portal permission UX (user must approve screen share) | Screenshot black until granted | Cache `getSources` probe result, surface "grant in portal dialog" error like `assertScreenRecordingPermission` does for macOS; docs in CachyOS quickstart |
| PipeWire monitor source name varies (`alsa_output.*.monitor` vs `pipewire-pulse` `.monitor`) | Wrong device, silence | `default_output_device_uid()` polls `pactl`/`pw-dump`, stale-ID fallback (same pattern `windows.rs:200` WASAPI) |
| `webrtc-vad` on Linux with Bluetooth HFP (24 k) | Chipmunk / false suppress | Reuse `resampler.rs` `FftFixedIn` to 16k before VAD (already done), `for_microphone_on(false)` keeps `use_vad=true` like macOS |
| Electron Wayland `transparent` + `alwaysOnTop` inconsistencies across compositors | Overlay not on top or not transparent | Test matrix KWin/Hyprland/Sway; document XWayland fallback `--ozone-platform=x11`; guard `setContentProtection` best-effort |
| `onnxruntime-node` Linux CUDA coupling to driver | Requires driver, breaks clean AppImage | Ship `cpu` by default; CUDA as `NATIVELY_LINUX_CUDA=1` opt-in with `onnxruntime-node-gpu` optional dep |
| Missing `sqlite-vec-linux-*` / `sharp` linux binaries | Vector search + image pipeline broken | Add to `optionalDependencies` + ensure script, verify under `xvfb-run` in CI |
| `keytar` → `libsecret` keyring absent | Secure storage throws | Graceful fallback (already in `CredentialsManager`); document `gnome-keyring`/`kwallet` + `secret-tool` |
| `portal` impl varies (Hyprland vs KDE vs GTK) | `desktopCapturer` inconsistent | Pin per-compositor portal impl in deps table; `grim+slurp` CLI fallback |

---

## 8. Open Questions for Owner

1. **PipeWire backend — native `pipewire-rs` (lowest latency) vs `libpulse-binding` (simplest, reuses `pipewire-pulse`)?**  
   Recommendation: both — PipeWire primary, Pulse fallback. Adds one `mod pulse;` private helper, no `mod.rs` churn.

2. **Capture-exclusion on Wayland — acceptable to document "share single window, not entire screen" for v1?**  
   Wayland portal spec has no `WDA_EXCLUDEFROMCAPTURE`/`NSWindowSharingNone` equivalent. Overlay exclusion cannot be guaranteed at compositor level. Guidance covers v1.

3. **GPU acceleration on Linux — ship CPU-only v1, defer CUDA/TensorRT to `NATIVELY_LINUX_CUDA=1` opt-in?**  
   Or bundle `cuda` wheel and require driver? Preference: CPU default.

4. **Distro scope — CachyOS/Arch only, or also Ubuntu/Debian `apt` deps?**  
   Plan covers `pacman` (user) + Ubuntu `apt` (CI `build-smoke` linux runner). Recommend both.

5. **Layer-shell overlay — defer unless floating window fails?**  
   `gtk4-layer-shell` / `wlr-layer-shell` is Phase 3 optional. Floating `BrowserWindow` + Ozone is sufficient for v1.

---

## 9. Appendix — Absolute File Map

### Native / Audio

- `native-module/Cargo.toml:1-74` — crate manifest, `#[target.'cfg(...)'.dependencies]` gates
- `native-module/src/lib.rs:1-779` — `SystemAudioCapture`/`MicrophoneCapture` NAPI, `BatchEmitter`, `CANONICAL_STT_RATE 16000`, DSP loop
- `native-module/src/microphone.rs:22-438` — `cpal` mic, `HeapRb<f32>(32768)`, `build_input_stream` real-time `try_push`
- `native-module/src/audio_config.rs:1-49` — `SAMPLE_RATE 16_000`, `FRAME_MS 20 → 320`, `DSP_POLL_MS 5`
- `native-module/src/speaker/mod.rs:1-88` — macOS (`core_audio,macos,sck`) / Windows (`windows`) / fallback stub (`not(any)`), issue #219
- `native-module/src/speaker/core_audio.rs:1-360` — Process Tap macOS 14.4+, aggregate device, `HeapRb(131072)` ~2.7s
- `native-module/src/speaker/sck.rs:1-405` — SCK fallback 13.0+, global capture
- `native-module/src/speaker/macos.rs:1-109` — CoreAudio→SCK shim
- `native-module/src/speaker/windows.rs:1-320` — WASAPI `Shared Float` event-driven `h_event.wait_for_event(3000)`
- `native-module/src/resampler.rs:12-192` — `rubato FftFixedIn → i16`
- `native-module/src/silence_suppression.rs:1-580` — adaptive RMS + `webrtc-vad`, `for_microphone_on(is_windows)` injectable
- `native-module/src/channel_state.rs:1-262` — `JointState` fold, `for_platform(cfg!(windows))`
- `native-module/src/vad.rs:1-140` — UI-only RMS
- `native-module/src/stealth_window.rs:51-250` — `NSWindow` direct ObjC (macOS 15 SPI `_setPreventsActivation`)
- `electron/audio/MicrophoneCapture.ts:138-377` — lazy init, deferred teardown `setImmediate`, pre-warm
- `electron/audio/SystemAudioCapture.ts:1-297` — thin EventEmitter bridge + sample-rate polling
- `electron/audio/nativeModuleLoader.ts:185-298` — `index.<platform>.node` probing, `app.asar.unpacked` first
- `electron/audio/whisper/audioResampler.ts:6-36` — `resampleToF32` linear interp to 16k
- `electron/audio/whisper/vadProcessor.ts:14-214` — `WINDOW 480 RMS 0.008 hangover 10` Whisper gate
- `electron/audio/LocalWhisperSTT.ts:257-1417` — streaming profiles Moonshine 750/400, Nemotron 280/560, Whisper 1500/800
- `electron/audio/whisper/types.ts` — `WorkerInitMessage {executionProviders, dtype, cacheDir}`
- `electron/audio/whisper/modelManager.ts` — catalog ~18 models, `getModelsDir() userData/whisper-models`, `isModelCached`, `getModelSizeBytes`

### Window / Screen

- `electron/ScreenshotHelper.ts:1-922` — `desktopCapturer` single/multi stitching, `computeThumbnailCrop:131`, `getScreenshotCommand:648` wayland TODO, queue `MAX_SCREENSHOTS 5`
- `electron/CropperWindowHelper.ts:50-791` — `buildCropperWindowSettings(combinedBounds,platform):99`, verification `verifyCombinedBounds:560`, opacity shield win32, `enableLargerThanScreen` `darwin||win32`
- `electron/WindowHelper.ts:1-918` — owns 5 `BrowserWindow`s, `createWindow:500-918`, `applyContentProtection:271 reassert:334`, `syncOverlayInteractionPolicy:1354 setIgnoreMouseEvents`, `setVisibleOnAllWorkspaces:851 setHiddenInMissionControl:852`, Ozone TODO for Linux
- `electron/SettingsWindowHelper.ts:1-400`, `electron/ModelSelectorWindowHelper.ts:1-350`, `electron/utils/windowsFocusPolicy.ts:1-120`, `electron/preload.ts`

### ML / ONNX

- `electron/audio/whisper/inferenceConfig.ts:1-233` — `WHISPER_SAFE_DTYPE`, `resolveInferenceConfig()` (`coreml/dml/cpu`), `resolveNemotronExecutionProviders()` cpu, `buildWorkerInitMessage()`
- `electron/audio/whisper/whisperWorker.ts:1-500` — `pipeline('automatic-speech-recognition')`, `env.backends.onnx.executionProviders`, Nemotron dual-channel sharing
- `electron/audio/whisper/nemotron/nemotronEngine.ts:1-400` — `InferenceSession, Tensor float32`, `createSessionWithFallback cpu`, `runEncoder/DecoderJoint`
- `electron/utils/onnxThreadConfig.ts:1-432` — `getBoundedOnnxSessionOptions workload`, global semaphore `__nativelyOnnxSemaphoreV1__ cap 2`, `getAvailableMemoryGB() vm_stat vs /proc/meminfo vs os.freemem`, `hasEnoughMemoryForOnnxSession 2.0 GB`
- `electron/rag/providers/LocalEmbeddingProvider.ts:7-27`, `LocalReranker.ts:1-80`, `llm/IntentClassifier.ts:13-394`

### Build / Packaging / CI

- `package.json:1-374` — `build.mac x64+arm64 / win x64 / linux x64(AppImage+deb)`, `asarUnpack *.node/*.dylib`, `extraResources models/`, `optionalDependencies sqlite-vec-darwin/windows` (missing linux), `scripts postinstall patch-package + rebuild-native-electron`
- `electron-builder.signed.cjs:1-100` — production `identity:auto BJM29W3UQ6 hardenedRuntime:true afterSign notarize.js afterAllArtifactBuild create-dmg`
- `native-module/Cargo.toml:29-73` — macOS `cidre/objc2/core-graphics`, Windows `wasapi/windows 0.52`
- `vite.config.mts:1-124` — `@ alias`, manualChunks, `tesseract.js` external
- `scripts/build-native.js:1-284` — `darwin LIBRARY_PATH clang -print-resource-dir + install_name_tool` vs `win32/linux artifactMap + DLL-lock stale` (needs Linux `ldd` note)
- `scripts/build-electron.js:1-175` — esbuild `electron+premium → dist-electron`, externals `onnxruntime-node` etc.
- `scripts/rebuild-native-for-target.cjs:1-141` — `@electron/rebuild per arch`
- `scripts/verify-packaged-local-assets.mjs:1-212`, `smoke-onnx-packaging.mjs:1-162`, `download-models.js:1-181`, `afterAllArtifactBuild.cjs:1-339`
- `.github/workflows/build-smoke.yml:1-426` — `matrix [macos-latest, windows-latest]`, premium submodule, TS7 check, `npm test` 41-win fails advisory
- `.github/workflows/release-macos.yml:1-243` — `macos-14` `rust targets x86_64+aarch64-apple-darwin`
- `build/entitlements.mac.plist:19`, `build/entitlements.mac.inherit.plist`, `.cargo/config.toml`

### Regex search coverage

`process.platform` ~100 hits (mostly `main.ts:7207,7534` lifecycle, `WindowHelper:316,518,562,840,850,893`, `ScreenshotHelper:32,537,551,658,684,713,748,759`); `BrowserWindow` 100+; `desktopCapturer|getSources` 46; `wasapi` 8, `coreaudio` 9, `cpal` 76; `pipewire`/`pulse` 0 audio hits (negative result — confirms gap); `ort|onnx|whisper|moonshine` ~100; `CoreML|DirectML|CUDA|execution.*provider` key at `inferenceConfig`; `wayland|x11|portal|layer` — no wayland handling (gap confirmed).

---

> **Next step:** Owner approval on open questions §8 → Phase 0 spike (no Electron changes). All Phase 0 work is `native-module/src/speaker/pipewire.rs` + `Cargo.toml` linux deps + `scripts/build-native.js` Linux path; `darwin`/`win32` untouched. Wayland/Capture/Window deltas gated behind `process.platform==='linux'` / `XDG_SESSION_TYPE==='wayland'` or `#[cfg(target_os="linux")]`, preserving both shipped platforms.
