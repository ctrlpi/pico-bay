# CLAUDE.md - pico-bay

This file provides guidance to Claude Code when working in this repository.

## The README is locked

`README.md` is done. Do not edit it without the user's explicit confirmation, even for a small wording or formatting fix, and even to keep it in sync with another project's README.

## What this is

`pico-bay` is an app and MCP server for managing Raspberry Pi Pico and ESP32 boards with MicroPython or CircuitPython over USB. It supports multiple boards, live console access, file operations, ZIP backup and restore, and MicroPython installation for RP2040 and RP2350 boards in BOOTSEL mode and supported ESP32 boards in ROM download mode.

The app uses only Node.js built-in modules for its JavaScript runtime and has no frontend build step. On Windows, it compiles [combridge.cs](combridge.cs) into a native serial helper at startup using the installed .NET Framework C# compiler (`csc.exe`). The backend, serial protocol, firmware adapters, HTTP API, MCP server, and BOOTSEL installer live in [pico-bay.js](pico-bay.js). The standalone frontend is [page.html](page.html).

The npm package is **`pico-bay`**. Its executable is `pico-bay.js`, and the package includes `pico-bay.js`, `combridge.cs`, `page.html`, `favicon.ico` (the ctrlPi icon, served at `/favicon.ico`), `README.md`, `test`, and `LICENSE`.

## Location

This repository lives at `pico-bay/` inside the ctrlpi workspace folder, next to the other ctrlpi projects. It is its own git repository (the workspace root gitignores it), and the workspace root `CLAUDE.md` rules apply here too. Publishing is described in the root `CLAUDE.md` only.

## Running

```bash
npm start
npm run dev
npm test
node pico-bay.js [--port 7426] [--host 127.0.0.1] [--allow-host NAME] [--hold 900] [--no-open] [--ui on|off] [--mcp off|http|stdio]
node pico-bay.js --mcp stdio
node pico-bay.js --mcp http
node pico-bay.js --ui off
node pico-bay.js --help
node pico-bay.js --version
```

Configuration precedence is command line, environment, then default:

- Port: `--port`, `PICO_PORT`, `7426`. On a busy port (`listenOnFreePort()`) a pico-bay already running there is opened in the browser and no second copy starts (two would fight over the serial ports). When another program holds it, the next 3 ports are tried, only for the default port on a desktop without HTTP MCP; otherwise it fails with the port-in-use message.
- Host: `--host`, `PICO_HOST`, then `127.0.0.1`; Raspberry Pi hosts default to `0.0.0.0`.
- Allowed host names: `--allow-host` (repeatable or comma-separated) plus `PICO_ALLOW_HOSTS`. `hostAllowed()` checks the `Host` header on every route, `/mcp` included, against DNS rebinding: IP addresses, `localhost`, `os.hostname()` (with or without `.local`), the `--host` value and these names pass, anything else gets `403`.
- Serial hold: `--hold`, `PICO_HOLD_MS`, `900` milliseconds.
- Browser launch: `--no-open` or `PICO_NO_OPEN`; Raspberry Pi hosts never open a browser.
- Mode: `--ui on|off` (`PICO_UI`) and `--mcp off|http|stdio` (`PICO_MCP`), parsed by `parseMode()`; a flag wins over its variable, and the old flags (`--mcp-stdio`, `--mcp-http`, `--mcp-only`, `--no-mcp`) and variables are ignored. `--ui off` alone means `--mcp http`; `--mcp stdio` means no web UI. `--ui off --mcp off`, `--ui on --mcp stdio` and a bad value exit with code 2. Raspberry Pi hosts enable HTTP MCP by default (`--mcp off` disables it). With neither `--ui` nor `--mcp` set (and no variable) and stdin a pipe or socket, `detectMcpStdio()` reads the first line: a JSON-RPC message starts stdio MCP; anything else, a closed stdin or 2 seconds of silence starts the web app. A web start logs `ui: on|off, mcp: off|http (key set: yes|no)`.

Boolean environment values accept `true`, `false`, `1`, or `0`.

## Architecture

The process has four main parts:

1. **Serial layer**: one `PicoPort` per device path, with all operations serialized through its command chain.
2. **Firmware adapters**: MicroPython and CircuitPython detection, capabilities, console behavior, and filesystem commands.
3. **Storage layer**: mounted `CIRCUITPY` access, hardware-UID volume matching, Linux `udisksctl` mounting, and RP2040/RP2350 BOOTSEL handling.
4. **Servers**: the web UI and JSON API, plus optional MCP stdio or Streamable HTTP transport.

Important HTTP routes include:

- `/api/devices`, `/api/files`, and `/api/file` for discovery and files.
- `/api/mkdir`, `/api/touch`, `/api/rename`, and `/api/clean` for mutations.
- `/api/zip`, `/api/download-all`, and `/api/restore` for backups.
- `/api/run`, `/api/interrupt`, `/api/reset`, `/api/bootloader`, and `/api/console` for board control.
- `/api/bootsel/install` and `/api/bootsel/install/status` for background MicroPython UF2 installation and stage reporting.
- `/api/esp/install` and `/api/esp/install/status` for confirmed background MicroPython installation and progress through the ESP ROM loader.
- `/api/storage/initialize` for explicitly confirmed recovery of an uninitialized ESP32 MicroPython VFS partition.
- `/api/readme` for the full-screen README view.
- `/api/ctrlpi/install` for "Install ctrlPi API": `ctrlpiBoardKind()` picks the agent from the board (`pico-gpio-api` on a Pico W / Pico 2 W, `esp32-gpio-api` on any ESP32 running MicroPython (the agent officially supports the ESP32, ESP32-S3, ESP32-C3 and ESP32-C6); anything else is a `400`). `downloadCtrlpiAgent()` fetches its files from the project's GitHub `main` branch (`CTRLPI_AGENTS`: `app.mpy`, `upgrader.mpy` and `main.py`, plus `boot.py` on the ESP32; `upgrader.mpy` runs the agent's own `/upgrade`, and a board without it answers that with `500`), `ctrlpiFileError()` checks each the way the agent's upgrader does (`.mpy` header and size for both `.mpy` files), a leftover `upgrade.lock` is deleted first (it would boot the upgrader over the new files), and they are written with `main.py` last, then `config.json` (the board's own kept, with the new key and name), `wifi.txt`, and a `scripts/cpu-temp.py` for that board when it has none. `page.html` offers the menu item on the same boards, and shows it greyed out on every other running board (a Pico without WiFi, any board running CircuitPython). An ESP32 chip the agent does not officially support (S2, C5) is allowed: the menu item and the form carry a "not officially supported" note. A disabled menu item is grey whatever its own colour (the red Delete all files, the blue Install ctrlPi API). `installCtrlpi()` does the work for this route and for the `pico_ctrlpi_install` MCP tool (which needs `confirmed: true`). A key left empty, in the form or the tool, keeps the board's own and becomes `your-secret-key` on a board without one; the form shows that default in grey and does not require a key, and the result's `defaultKey` makes the page add the public-key warning to its success message. The tool passes `keepOmitted` to `ctrlpiInstallFiles()`, so a name left out keeps the board's own too, and a default key adds a `warning` to its result.
- `/mcp` when Streamable HTTP MCP is enabled.
- `/hello` and `/remote-config` (always served, for `ctrlpi-remote`): see "HTTP MCP key" below.

### HTTP MCP key

`POST /mcp` needs `Api-Key`. The key is `mcp.api_key` (with `mcp.key_set`) in `~/.ctrlpi/pico-bay-config.json` (`CONFIG_FILE`; `--config <folder>` holds it, a `.json` path is the file itself, `resolveConfigFile()`; a `--config` without a value exits with code 2), re-read on every request. The default `your-mcp-key` is accepted until the first different key (1-128 printable ASCII characters) claims it and is saved (`mcpKeyAccepted()`, trust on first use, not adopted when the file cannot be written); wrong or missing gets `403` and a `[SECURITY]` log line. `GET /hello` (no key) answers `{"service": "pico-bay", "key": <true once a key is set>}`. `POST /remote-config` with the current key and `{"api_key": "<new>"}` changes it: `200 {key_set}`, `403` (wrong key or foreign `Origin`), `400` (empty, the default, over 128 or not printable), `405`, `413` (over 4 KB), `500` (not saved); it never claims a key. Stdio MCP needs no key. Recovery: remove `mcp.api_key` from the file and the default works again. The web UI and its `/api/*` routes have no key.

`--ui off` implies HTTP MCP, never opens a browser, and serves only `/mcp`, `/hello` and `/remote-config`: everything else, the page and `/api/mcp` included, is a `404`, and `pico_ui` refuses with a tool error. With `--mcp off` it exits with code 2.

The `pico_ui` MCP tool opens this web UI (`openUi()`) or, with `action: "stop"`, stops it (`stopUi()`). Under stdio MCP no web server runs, so `ensureUiServer()` starts one on the first call, on the port or one of the next 3, or uses a pico-bay already running there; it lives until the client closes stdin. The browser opens only on a local desktop. For a client elsewhere (a Raspberry Pi host, a non-loopback `Host` on HTTP MCP, `SSH_CONNECTION` under stdio) or with `--no-open`, the result is `opened: false` and the `url` to open: the request's `Host`, the ssh session's address, else the first LAN address. Stop closes only a server the tool started; the app's own server and another running pico-bay stay up (`stopped: false`).

## Serial and device constraints

- **Node has no serial API.** On macOS and Linux, ports are opened with `fs.openSync(dev, O_RDWR|O_NOCTTY)` and configured through `stty`. macOS uses `-f`, Linux uses `-F`, and macOS must use `cu.*` devices rather than `tty.*`.

- **Exclusive ports and the serial helper.** Node cannot make ioctl calls, so one helper script runs on the open descriptor (fd 3) with its mode as the argument: `SERIAL_HELPER_PERL`, with the same script in Python (`SERIAL_HELPER_PYTHON`) as the backup, then none (`runSerialHelper()`). `lock` marks a port exclusive right after `stty` (which opens the device itself, so it must run first): a later open by any other program, another pico-bay included, fails with `EBUSY`. `unlock` clears it just before the close, so a stalled close cannot keep a port locked; the system also clears it on close, exit or crash, and no lock file exists. The other modes are the ESP32 DTR/RTS reset sequences (`resetEspLines()`); keep the two scripts identical in behaviour. An `EBUSY` open reports `Board is in use by <program> (PID n)` (`portHolder()`, from `lsof`), keeps the board's cached record, retries its probe every 3 s, and shows the board as a red BUSY pill. Startup and the hardware tests warn when another pico-bay is running (`otherPicoBayWarning()`). Root ignores exclusive mode. `PICO_TEST_SERIAL_HELPER=perl|python|none` picks the helper for a test run.

- **Windows serial bridge.** [combridge.cs](combridge.cs) (`ComBridge`) opens and configures COM ports through Win32 APIs, streams serial data through standard input/output, and receives DTR/RTS commands over a named pipe. Windows port discovery reads `HKLM\HARDWARE\DEVICEMAP\SERIALCOMM`. At startup, the app locates `csc.exe` in the .NET Framework v4 `Framework64` or `Framework` directory and compiles the helper if its versioned `pico-bay-combridge-<version>.exe` is absent from the system temporary directory. Startup fails if the compiler is unavailable. Keep the helper source in the npm package; when changing it during development, remove the cached executable or change the package version so it is rebuilt.

- **`min 0 time 1` is required.** It prevents a raw TTY read from blocking the server indefinitely when no bytes are available.

- **Opening never blocks.** A system open of a troubled port can wait for over a minute, and a synchronous one stops every other board. `_openNow()` opens the tty, the write descriptor, `stty` and the `lock` helper asynchronously, in that order. `_openDescriptor()` gives the open 10 s (`OPEN_TIMEOUT_MS`), then fails that board with `USB serial port did not open in 10 s`; the system open still running is kept in `pendingOpen` (one per port), reused by the next attempt, and closed if it returns with nobody waiting. `_open()` shares one open among callers (`opening`). Keep it free of `...Sync` calls.

- **Writes never block.** A blocking write to a board that stopped reading freezes the whole process, timers included. `_open()` opens a second descriptor (`wfd`, `O_WRONLY|O_NONBLOCK`) before the port is locked, and `_writeAll()` and `shutdown()` write through it: a write retries on `EAGAIN` and fails with `timed out waiting for the board (it accepts no data)` after 5 s without progress (`WRITE_TIMEOUT_MS`). Never write to `fd` when `wfd` is open.

- **Preserve unread bytes.** `readUntil()` must keep bytes after its match because a USB packet can contain both the token and following payload. `readN()` and raw-paste flow control depend on the same persistent receive buffer.

- **Keep the raw-paste fallback.** `_rawPasteWrite()` is the MicroPython fast path. Older firmware may reject raw paste, so `exec()` must retain the throttled raw-REPL fallback and its different acknowledgement behavior.

- **Keep the hold debounce.** `command()` briefly leaves a board halted and schedules `_release()` after `HOLD_MS`. This avoids repeatedly rebooting programs, especially Wi-Fi startup code, between related operations. Use `--hold 0` when immediate release is required.

- **One conversation per port.** All operations use `command()` and `this.chain`. `_pump()` is the only reader and sends bytes either to the active command or to console subscribers.

- **Probing is cached and isolated by device.** The UI polls for hot-plug changes, but known boards must not be interrupted on every poll. Multiple probes may run concurrently, and metadata must never leak between ports. Disconnected ports must be cancelled and removed promptly.

- **Use `pyError()` for board errors.** It reduces a returned traceback to the useful final error line.

- **Reset on shutdown.** `shutdown()` attempts Ctrl-C, Ctrl-B, and Ctrl-D on open ports so boards are not left halted.

## CircuitPython storage

CircuitPython can give filesystem write ownership to either the running board or the USB host. Prefer a safely matched mounted `CIRCUITPY` volume for fast file access, and use serial when the board owns the filesystem.

Mounted volumes are matched to boards by hardware UID from `boot_out.txt`, never by volume name or discovery order. This is required when multiple CircuitPython boards are connected. Report read-only only when neither serial nor a matched writable mount can write.

Raspberry Pi OS Lite may detect USB storage without mounting it. The app uses `lsblk` and `udisksctl`, reports the exact mount command when authorization is required, and must associate an unmounted volume with the correct board serial before exposing that command. If the optional `usb-automount.sh` file is present, the UI may also offer it as a one-time Pi setup; do not assume it is included in every package.

## BOOTSEL installation

BOOTSEL volumes labeled `RPI-RP2` or `RP2350` appear as non-operable red devices. The selected chip family limits the available Pico models, but Pico versus Pico W cannot be autodetected. Firmware downloads must remain HTTPS-only, host-restricted, size-limited, and UF2-header validated before being copied to the mounted boot volume.

## ESP32 installation

ESP32, ESP32-S2, ESP32-C3, ESP32-S3, and ESP32-C6 ROM download mode appears as a red DOWNLOAD device. Installation uses only the built-in ROM protocol at 115200 baud. Select the latest stable generic `.bin` from the matching official MicroPython download page, validate its ESP image header, chip ID, segments, and checksum before writing, and verify the flashed bytes with `SPI_FLASH_MD5` before rebooting. Refuse installation when the chip is unknown, its security state cannot be read, or secure download, secure boot, or flash encryption is enabled. The checked-by-default storage option uses a named `vfs` partition when present, or the flash space after the last partition used by current official images. Locate this region before writing; erase and verify it with the ROM compressed-flash commands only after firmware verification and before reboot. It uses Node's built-in `zlib` and does not perform a full-chip erase.

## Frontend

`page.html` contains all frontend HTML, CSS, and JavaScript and is served after replacing `{{VERSION}}`. It must remain valid without a build step.

Keep new UI consistent with the existing colors, shared dialogs and tooltips, firmware-colored pills, resizable sidebar and console, full-screen README and BOOTSEL views, and top connection/power/mount warnings. Selecting a board or scanning exits the full-screen README view.

## Online version: keep feature parity

The sibling `pico-online` project serves this app in the browser over Web Serial. It builds its page from this project's `page.html` as it is, and its `backend.js` is a port of the serial layer, raw REPL, board-side code, ZIP handling and `/api/*` routes of `pico-bay.js`. A feature or fix here (a route, its JSON, board-side code, a UI element the online scripts hook) needs the same change in `pico-online`, then its `node build.js` and `node --test`. All of its code and tests live there, none here.

## Testing

Run the complete dependency-free suite with:

```bash
npm test
```

The test suite in `test/` covers parsing, ZIP handling, firmware detection, multiple-board isolation, mounted-volume behavior, mocked HTTP routes, MCP (stdio detection, `pico_ui`, busy ports), BOOTSEL installation, and ESP32 ROM installation.

After the non-hardware tests pass, the suite scans for connected boards. With no board, the physical section is skipped. MicroPython and writable CircuitPython boards receive temporary file/folder write-read-delete checks. Read-only CircuitPython boards receive non-destructive capability and console checks. Each firmware uses its own protocol path, and all temporary files must be removed in `finally` cleanup.

Never test `/api/clean` on a board containing important files; it deletes the entire board filesystem, including `main.py`.
