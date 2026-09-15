# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## What this is

`pico-bay` is an app and MCP server for managing Raspberry Pi Pico and ESP32 boards with MicroPython or CircuitPython over USB. It supports multiple boards, live console access, file operations, ZIP backup and restore, and MicroPython installation for RP2040 and RP2350 boards in BOOTSEL mode and supported ESP32 boards in ROM download mode.

The app uses only Node.js built-in modules at runtime and has no build step. The backend, serial protocol, firmware adapters, HTTP API, MCP server, and BOOTSEL installer live in [pico-bay.js](pico-bay.js). The standalone frontend is [page.html](page.html).

The npm package is **`@ctrlpi/pico-bay`**. Its executable is `pico-bay.js`, and the package includes `pico-bay.js`, `page.html`, `README.md`, `test.js`, and `LICENSE`. Update the version in `package.json` before publishing.

## Running

```bash
npm start
npm run dev
npm test
node pico-bay.js [--port 7426] [--host 127.0.0.1] [--hold 900] [--no-open] [--no-mcp]
node pico-bay.js --mcp-stdio
node pico-bay.js --mcp-http
node pico-bay.js --help
node pico-bay.js --version
```

Configuration precedence is command line, environment, then default:

- Port: `--port`, `PICO_PORT`, `7426`.
- Host: `--host`, `PICO_HOST`, then `127.0.0.1`; Raspberry Pi hosts default to `0.0.0.0`.
- Serial hold: `--hold`, `PICO_HOLD_MS`, `900` milliseconds.
- Browser launch: `--no-open` or `PICO_NO_OPEN`; Raspberry Pi hosts never open a browser.
- MCP: `--mcp-stdio`/`PICO_MCP_STDIO` or `--mcp-http`/`PICO_MCP_HTTP`. Raspberry Pi hosts enable HTTP MCP by default; `--no-mcp`/`PICO_NO_MCP` disables all MCP transports.

Boolean environment values accept `true`, `false`, `1`, or `0`.

## Architecture

The process has four main parts:

1. **Serial layer** — one `PicoPort` per device path, with all operations serialized through its command chain.
2. **Firmware adapters** — MicroPython and CircuitPython detection, capabilities, console behavior, and filesystem commands.
3. **Storage layer** — mounted `CIRCUITPY` access, hardware-UID volume matching, Linux `udisksctl` mounting, and RP2040/RP2350 BOOTSEL handling.
4. **Servers** — the web UI and JSON API, plus optional MCP stdio or Streamable HTTP transport.

Important HTTP routes include:

- `/api/devices`, `/api/files`, and `/api/file` for discovery and files.
- `/api/mkdir`, `/api/touch`, `/api/rename`, and `/api/clean` for mutations.
- `/api/zip`, `/api/download-all`, and `/api/restore` for backups.
- `/api/run`, `/api/interrupt`, `/api/reset`, `/api/bootloader`, and `/api/console` for board control.
- `/api/bootsel/install` and `/api/bootsel/install/status` for background MicroPython UF2 installation and stage reporting.
- `/api/esp/install` and `/api/esp/install/status` for confirmed background MicroPython installation and progress through the ESP ROM loader.
- `/api/storage/initialize` for explicitly confirmed recovery of an uninitialized ESP32 MicroPython VFS partition.
- `/api/readme` for the full-screen README view.
- `/mcp` when Streamable HTTP MCP is enabled.

## Serial and device constraints

- **Node has no serial API.** Ports are opened with `fs.openSync(dev, O_RDWR|O_NOCTTY)` and configured through `stty`. macOS uses `-f`, Linux uses `-F`, and macOS must use `cu.*` devices rather than `tty.*`.

- **`min 0 time 1` is required.** It prevents a raw TTY read from blocking the server indefinitely when no bytes are available.

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

ESP32, ESP32-S2, ESP32-C3, and ESP32-S3 ROM download mode appears as a red DOWNLOAD device. Installation uses only the built-in ROM protocol at 115200 baud. Select the latest stable generic `.bin` from the matching official MicroPython download page, validate its ESP image header, chip ID, segments, and checksum before writing, and verify the flashed bytes with `SPI_FLASH_MD5` before rebooting. Refuse installation when the chip is unknown, its security state cannot be read, or secure download, secure boot, or flash encryption is enabled. The checked-by-default storage option uses a named `vfs` partition when present, or the flash space after the last partition used by current official images. Locate this region before writing; erase and verify it with the ROM compressed-flash commands only after firmware verification and before reboot. It uses Node's built-in `zlib` and does not perform a full-chip erase.

## Frontend

`page.html` contains all frontend HTML, CSS, and JavaScript and is served after replacing `{{VERSION}}`. It must remain valid without a build step.

Keep new UI consistent with the existing colors, shared dialogs and tooltips, firmware-colored pills, resizable sidebar and console, full-screen README and BOOTSEL views, and top connection/power/mount warnings. Selecting a board or scanning exits the full-screen README view.

## Testing

Run the complete dependency-free suite with:

```bash
npm test
```

`test.js` covers parsing, ZIP handling, firmware detection, multiple-board isolation, mounted-volume behavior, mocked HTTP routes, MCP, BOOTSEL installation, and ESP32 ROM installation. It also acts as the test reporter to normalize duration output for local and CI runs.

After the non-hardware tests pass, the suite scans for connected boards. With no board, the physical section is skipped. MicroPython and writable CircuitPython boards receive temporary file/folder write-read-delete checks. Read-only CircuitPython boards receive non-destructive capability and console checks. Each firmware uses its own protocol path, and all temporary files must be removed in `finally` cleanup.

Never test `/api/clean` on a board containing important files; it deletes the entire board filesystem, including `main.py`.
