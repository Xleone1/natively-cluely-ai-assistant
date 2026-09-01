# CachyOS / Arch Linux Quickstart — Natively

> Target: **CachyOS (Arch) / Wayland / PipeWire** — the stack verified in Phase 0-3 (`audio_spike` dual 48k→16k on PipeWire 1.6.8, Hyprland/KWin/Sway with `xdg-desktop-portal`).

This page is the runnable counterpart to `docs/plans/linux-support-plan.md` §3-4.

---

## 1. Prerequisites

### 1.1 Runtime (user machine — no dev deps needed for AppImage/deb)

AppImage/deb already bundles `sharp-linux-x64`, `sqlite-vec-linux-x64/vec0.so`, `onnxruntime-node`, and the Rust monitor (`index.linux-x64-gnu.node`). The host only needs the system services:

```bash
# Audio graph — CachyOS already ships PipeWire, but ensure the Pulse compat + session manager are present
sudo pacman -S --needed pipewire pipewire-pulse pipewire-alsa wireplumber
systemctl --user --now enable pipewire pipewire-pulse wireplumber
systemctl --user status pipewire pipewire-pulse wireplumber
pw-cli info 0 | head -20          # should show natively monitor stream when app is running
pactl info | grep "Server Name"   # PulseAudio (on PipeWire 1.6.8)

# Screen portal — pick ONE impl for your compositor (Hyprland → -hyprland, KDE → -kde, GNOME → -gtk)
sudo pacman -S --needed xdg-desktop-portal xdg-desktop-portal-hyprland xdg-desktop-portal-gtk xdg-desktop-portal-wlr
# Native screenshot CLI fallback (when portal dialog is cancelled)
sudo pacman -S --needed grim slurp wayland wl-clipboard xdg-utils

# Secure storage (optional but recommended; without it keys use the app-managed fallback)
sudo pacman -S --needed libsecret gnome-keyring   # KDE: kwallet + kwalletmanager
# Verify secret service: 
secret-tool store --label=test natively test moocow && secret-tool lookup natively test && secret-tool clear natively test

# Verify portal can grant screen share:
# Launch Natively, click Screenshot → portal dialog should appear → grant → portal should not show black.
```

### 1.2 Build prerequisites (developer / CI)

```bash
sudo pacman -S --needed base-devel clang pkgconf openssl \
  rustup nodejs npm \
  pipewire libpulse alsa-lib dbus \
  libxcb xorg-xwayland gtk4 libadwaita \
  vips sqlite \
  grim slurp wayland wl-clipboard \
  xdg-desktop-portal xdg-desktop-portal-hyprland

# Ubuntu CI equivalent (build-smoke.yml ubuntu-latest):
# sudo apt-get install -y libasound2-dev libpulse-dev libdbus-1-dev libvips-dev libsqlite3-dev xvfb pulseaudio
```

---

## 2. Install Natively

### AppImage

```bash
chmod +x Natively-*.AppImage
./Natively-*.AppImage
# Or integrate: ./Natively-*.AppImage --appimage-extract ; desktop-file-install ...
```

### deb

```bash
sudo pacman -U Natively_*.deb  # or sudo dpkg -i Natively_*.deb on Ubuntu, then apt -f install
natively
```

First launch creates `~/.config/Natively` + `~/.local/share/Natively/` (models, credentials).

---

## 3. Audio — PipeWire monitor on CachyOS

- The app captures **two independent streams** (mic + system monitor `<default_sink>.monitor`) via `pipewire-pulse`. No ALSA loopback config needed.
- Default sink follows `pactl get-default-sink` (e.g. `alsa_output.usb-Burr-Brown...analog-stereo-output`) and its monitor is `…output.monitor`. Switching sinks mid-meeting is picked up within a few seconds (poll of `default_output_device_uid`).
- Verify:

```bash
pactl list sinks short
pactl list sources short | grep monitor
pw-top  # shows NativelySystemAudio when system capture is active
```

- If system capture stays silent: check that something is playing (`pw-play` or browser) and that the monitor is not muted in `pavucontrol` → Output Devices → Show Monitors.

**Headless proof** (no Electron):

```bash
cargo build -p natively-audio --bin audio_spike
./target/debug/audio_spike --seconds 5 --dump /tmp/natively-spike
ffprobe -hide_banner /tmp/natively-spike.system.wav  # expect 16000 Hz, 1ch, s16
# With audio playing:
speaker-test -t sine -f 440 -c 2 -l 1 & ./target/debug/audio_spike --seconds 4 --dump /tmp/natively-spike-live
python3 -c "import struct,math; d=open('/tmp/natively-spike-live.system.wav','rb').read()[44:]; s=struct.unpack('<'+'h'*(len(d)//2), d); print('RMS', math.sqrt(sum((x/32768)**2 for x in s)/len(s)))"
# → RMS ~0.28 for sine, proves end-to-end (Phase 0).
```

---

## 4. Screen sharing & privacy — single-window guidance

- Wayland portal is **per-share, per-app-consent**. Full-desktop share grants every visible window, including the overlay (there is **no** `WDA_EXCLUDEFROMCAPTURE` / `NSWindowSharingNone` on Wayland). The overlay's stealth on Linux is Ozone/BrowserWindow flags, not a capture-exclusion bit.
- **Recommended:** share the **single IDE/browser window** where the meeting runs, not the entire screen. The overlay then lives outside the shared stream by construction.
- If you must share the desktop, the overlay will be visible to recipients on Wayland — this is a portal-spec limitation, not a bug. The docs will warn in-app when `XDG_SESSION_TYPE=wayland`.

Portal debugging:

```bash
# Wayland check
echo $XDG_SESSION_TYPE $WAYLAND_DISPLAY  # wayland wayland-0 → Wayland; x11 :0 → XWayland
# Electron Ozone flags are set automatically when main.ts detects linux (ozone-platform-hint=auto)
# If desktopCapturer shows black, retry and watch portal logs:
journalctl --user -u xdg-desktop-portal -u xdg-desktop-portal-hyprland -f
# Screenshot CLI fallback chain: grim -g "$(slurp)" || gnome-screenshot -a -f || scrot -s || import
which grim slurp  # both must be present for interactive Wayland selection
```

---

## 5. Hardware acceleration (ONNX)

- **Default:** `['cpu']` with `WHISPER_SAFE_DTYPE` (`encoder fp32, decoder q8`) — fastest on decoder, no WER loss. Nemotron stays `['cpu']` (CoreML/DML both regress on it).
- **NVIDIA CUDA opt-in:** only when explicitly requested

```bash
NATIVELY_LINUX_CUDA=1 ./Natively-*.AppImage
# or
NATIVELY_LINUX_CUDA=1 npx electron .
```

The worker still drops unknown `cuda` EP → `cpu` if the host lacks drivers or the `onnxruntime-node` CUDA build, so enabling it on a non-CUDA host is safe (just logs and falls back).

- Verify which EP the app chose:

```bash
# In app log or DevTools console, whisperWorker logs `providers ...` (cpu vs cuda)
# Or force CPU and compare:
NATIVELY_ONNX_INTRA_OP_THREADS=1 NATIVELY_ONNX_MIN_FREE_GB=2.0
```

---

## 6. Secure storage — Linux keyring

- Preferred: OS keyring via `safeStorage` (`libsecret`/`gnome-keyring` or `kwallet`). Check backend:

```bash
# Electron exposes safeStorage.getSelectedStorageBackend() on linux — the app logs it in
# credential_storage_status telemetry (phase=startup): basic_text → no keyring (expected
# failure), gnome_libsecret/kwallet → keyring present.
```

- **Fallback:** when `safeStorage.isEncryptionAvailable()` is false or `D-Bus secret service` is unreachable (headless, sandboxed, `gnome-keyring` not unlocked), the app transparently uses an app-managed AES-256-GCM file (`credentials.fallback.enc` + per-install `credentials.salt` at 0600). Keys survive restart (machine-bound), but are **not** OS-keyring strength — see `electron/services/CredentialsManager.ts` + `credentialFallbackCrypto.ts` for posture.
- Troubleshooting:

```bash
echo $XDG_RUNTIME_DIR  # must be set, keyring needs D-Bus: /run/user/1000
secret-tool lookup natively test  # if this hangs, secret service is down
# App log shows fallback path: "[CredentialsManager] OS keyring unavailable; saved via app-managed encrypted fallback"
```

---

## 7. Known limitations (Linux)

- Layer-shell true overlay (`gtk4-layer-shell`/`wlr-layer-shell`) is **deferred** — the overlay is a floating `BrowserWindow` via Ozone, alwaysOnTop `true` (standard level), `transparent:true, frame:false`. It may not stay above fullscreen `F11` browsers on all compositors (KWin/Hyprland/Sway tested; XWayland fallback `--ozone-platform=x11` works if needed).
- `setContentProtection(true)` is best-effort on Wayland (no-op); single-window share guidance above is the mitigation.
- Stealth typing on Linux is not yet `libei`/portal RemoteDesktop — `stealth_window` NAPI is a no-op stub, `windowsFocusPolicy attachNoActivate` early-returns on non-win32.
- `1366×768` tested explicitly (low-res laptop): `computeThumbnailCrop` density-agnostic ratio + cropper `3286` span verified in `ScreenshotHelperLinux.test.mjs`.

---

## 8. Verification checklist (local)

```bash
npm ci
npm run build:native            # expect native-module/index.linux-x64-gnu.node (ldd ok)
npm run build:electron
npm run verify:packaged-local-assets -- --include-linux
ELECTRON_RUN_AS_NODE=1 xvfb-run -a npx --no-install electron scripts/verify-sqlite-vec-load.mjs  # vec0.so dlopen
node scripts/smoke-onnx-packaging.mjs
npx electron-builder --linux --dir --publish never  # dry-run, unpacked layout
./target/debug/audio_spike --seconds 5 --dump /tmp/natively-spike && ffprobe /tmp/natively-spike.system.wav
npm test -- electron/services/__tests__/LinuxPlatformParity.test.mjs  # plus ScreenshotHelperLinux, WindowHelperLinux
```

CI: `build-smoke.yml` runs `ubuntu-latest` with `apt libasound2-dev libpulse-dev xvfb pulseaudio` + `xvfb-run` for Electron tests; `release-linux.yml` builds `AppImage+deb` from tag `v*`.

---

## 9. Filing Linux bugs

Include in issue:

```bash
echo $XDG_SESSION_TYPE $WAYLAND_DISPLAY
pactl info | grep "Server Name"   # PulseAudio (on PipeWire …)
pw-cli info 0 | head
echo $XDG_CURRENT_DESKTOP
journalctl --user -u xdg-desktop-portal --since "5 min ago" | tail -50
~/.config/Natively/logs/main.log | tail -100
```

See also: `docs/plans/linux-support-plan.md` (full audit & delta), `ROADMAP.md`, `CHANGELOG.md`.
