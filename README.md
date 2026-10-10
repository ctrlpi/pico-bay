# Pico Bay

[![Platform: Cross-Platform](https://img.shields.io/badge/platform-Cross--Platform-006400.svg)](#quick-start)
[![Version 0.9.29](https://img.shields.io/badge/version-0.9.29-blue.svg)](https://github.com/ctrlpi/pico-bay/tags)
[![Node 20+](https://img.shields.io/badge/node-20%2B-blue.svg)](https://nodejs.org/)
[![Protocol: MCP](https://img.shields.io/badge/protocol-MCP-006400.svg)](#mcp-server)
[![License: MIT](https://img.shields.io/badge/license-MIT-188038.svg)](LICENSE)
![Status: Beta](https://img.shields.io/badge/status-Beta-red.svg)
[![Build Status](https://github.com/ctrlpi/pico-bay/actions/workflows/ci.yml/badge.svg)](https://github.com/ctrlpi/pico-bay/actions)

`pico-bay` is an **App** and **MCP Server** for managing Raspberry Pi Pico and ESP32 boards with MicroPython and CircuitPython over USB. It runs with Node.js built-in modules and needs no browser extension or runtime npm dependencies.

## Quick start

Requires Node.js 20 or newer.

```sh
npx @ctrlpi/pico-bay
```

Your browser will open automatically! If it doesn't, head to [http://localhost:7426](http://localhost:7426). On a Raspberry Pi, open `http://PI_HOST_ADDR:7426` from another device on the same network, replacing `PI_HOST_ADDR` with the Pi's IP address or hostname.

Port `7426` spells **`PICO`** on a phone keypad, a nod to the T9 years and flip-phone era.

## Devices

- Supports Raspberry Pi Pico and ESP32 boards with MicroPython or CircuitPython, including Pico, Pico W, Pico 2, Pico 2 W, ESP32, ESP32-C3, and ESP32-S3.
- Detects multiple connected boards and follows USB hot-plug events.
- Detects MicroPython or CircuitPython automatically, including whether its filesystem is read-only or writable.
- Detects RP2040 and RP2350 BOOTSEL mode and installs the latest MicroPython firmware for the selected Pico model.
- Detects Espressif ROM download mode over USB serial, shows the detected chip details, and installs the latest generic MicroPython firmware on supported ESP32 chips.
- Shows Flash and RAM usage for each board.
- Supports soft reset, hard reset, Ctrl-C interruption, and filesystem cleanup.

## Files

- Browses the complete filesystem as a searchable, collapsible tree.
- Shows file sizes and modification times when the board provides them.
- Creates, renames, moves, uploads, downloads, and recursively deletes files and folders.
- Opens text files with Python and JSON highlighting.
- Renders a safe Markdown preview without executing embedded HTML.
- Detects binary files and offers them for download instead of displaying them as text.
- Downloads and restores the complete filesystem as a standard ZIP archive.

## Run and console

- Runs any Python file as `__main__` without replacing `main.py`.
- Streams program and boot output to a live console.
- Accepts console input and can interrupt a running program with Ctrl-C.

## MCP server

pico-bay includes a dependency-free [Model Context Protocol](https://modelcontextprotocol.io/) server, enabled by default on Raspberry Pi hosts. On macOS and other non-Pi hosts, enable MCP in the user interface or with `--mcp-stdio` or `--mcp-http`.

### Agent configuration

In Claude Desktop, open **Settings → Developer → Edit Config** to get to the configuration file (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, or the equivalent file on Windows or Linux), and add the server under `mcpServers` enabling stdio:

```json
"mcpServers": {
  "pico-bay": {
    "command": "npx",
    "args": ["-y", "@ctrlpi/pico-bay", "--mcp-stdio"]
  }
}
```

### Streamable HTTP

Use HTTP when the MCP client runs on another computer or Raspberry Pi:

```sh
npx @ctrlpi/pico-bay --mcp-http
```

The normal web interface remains available and MCP is served at `http://HOST:7426/mcp`. Configure the MCP agent to connect over HTTP, replacing `PI_HOST_ADDR` with the platform running pico-bay:

```json
"mcpServers": {
  "pico-bay": {
    "command": "npx",
    "args": ["-y", "mcp-remote", "http://PI_HOST_ADDR:7426/mcp", "--allow-http"]
  }
}
```

`--allow-http` permits the connection over a trusted local network. On macOS and other non-Pi hosts, add `--host 0.0.0.0` when starting pico-bay to make it reachable from another computer. A Raspberry Pi listens on the LAN by default.

> **No authentication or TLS:** MCP tools can run code, overwrite files, reset boards, and permanently delete board files. HTTP mode is intended only for a trusted local network. Do not expose `/mcp` or pico-bay’s port directly to the internet.

The server supports MCP revision `2026-07-28` and the legacy initialize flow through `2025-03-26`. It uses plain JSON responses rather than SSE because it does not send server-initiated messages.

### MCP tools

| Tool | Purpose |
| --- | --- |
| `pico_boards_list` | List connected boards, stable board IDs, firmware details, and capabilities. |
| `pico_files_list` | List the board filesystem and report Flash and RAM usage. |
| `pico_file_read` | Read a text or binary file using UTF-8 or base64. |
| `pico_file_write` | Create or overwrite a UTF-8 or base64 file, up to 8 MB decoded. |
| `pico_directory_create` | Create a directory. |
| `pico_path_rename` | Rename or move a file or directory. |
| `pico_path_delete` | Permanently delete a file or recursively delete a directory. |
| `pico_python_run` | Run a file as `__main__` or execute Python code and return its output. |
| `pico_board_interrupt` | Send Ctrl-C to interrupt a running program. |
| `pico_board_reset` | Soft-reset a board or request a supported hard reset. |
| `pico_install` | Check and install MicroPython on a Pico in BOOTSEL mode or a supported ESP32 in DOWNLOAD mode. |

Call `pico_boards_list` first, then pass its `board_id` to board-specific tools. ZIP backup/restore, live console streaming, and **Delete all files** are intentionally not exposed through MCP.

## Installing MicroPython in BOOTSEL mode

On a Pico running MicroPython or CircuitPython, select **Reboot to BOOTSEL** from the top-right menu and confirm. To enter manually, disconnect the board, hold its **BOOTSEL** button, and reconnect USB while continuing to hold it. Keep holding for 3 seconds, then release. pico-bay shows the RP2040 or RP2350 boot device as a red pill. Select it and choose if this is a W model (with Wi-Fi) or not, as it is not autodetectable. To cancel before installing firmware, unplug USB and plug it back in without holding any buttons.

pico-bay confirms the operation, downloads the latest matching MicroPython UF2 from [micropython.org](https://micropython.org/download/), validates it, and copies it to the boot volume. The screen reports the download, validation, installation, and reboot stages. Keep the board connected during installation. It reboots automatically and then appears as a normal MicroPython device.

## ESP32 download mode

Select **Enter download mode…** from the top-right menu and confirm. For manual entry, hold **BOOT/IO0**, press and release **RESET / EN**, and keep holding **BOOT/IO0** for 3 seconds, then release. Alternatively, unplug USB and hold **BOOT/IO0**. Plug the USB cable back in while continuing to hold **BOOT/IO0**. Keep holding for 3 seconds, then release. Click **Scan** in pico-bay, then select the red **DOWNLOAD** pill to see the detected chip and security details. To cancel before installing firmware, unplug USB and plug it back in without holding any buttons.

Select **Install MicroPython** to download, validate, install, and verify the latest official generic build. **Erase and initialize storage** is selected by default and runs after firmware verification, before reboot; uncheck it to preserve existing files. The screen shows each stage and the write progress percentage. Installation uses the ESP32 ROM without extra dependencies and is disabled when the chip is unsupported, unidentified, or protected by flash security.

## Requirements

- Node.js 20 or newer.
- MacOS, Linux, Windows, or Raspberry Pi OS.
- A USB-connected Raspberry Pi Pico or ESP32 board running MicroPython or CircuitPython, or a supported board in bootloader mode.
- Permission to open the board's serial device.
- On Windows, the .NET Framework v4 C# compiler (`csc.exe`) is required to build the serial helper automatically at startup.
- For ESP32 on Windows, the appropriate serial driver installed (see [Troubleshooting](#no-board-appears)).

## Install

From GitHub:

```bash
git clone https://github.com/ctrlpi/pico-bay.git
cd pico-bay
npm start
```

Or install the npm package locally:

```bash
npm install @ctrlpi/pico-bay
npx pico-bay
```

## Options

```text
pico-bay [--port PORT] [--host ADDRESS] [--hold MILLISECONDS] [--no-open] [--mcp-stdio | --mcp-http | --no-mcp] [--help] [--version]
```

<table width="100%">
  <thead>
    <tr>
      <th width="20%">Option</th>
      <th width="20%">Environment</th>
      <th width="13%">Default</th>
      <th width="47%">Purpose</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td width="20%"><code>--port</code></td>
      <td width="20%"><code>PICO_PORT</code></td>
      <td width="13%"><code>7426</code></td>
      <td width="47%">Web server port.</td>
    </tr>
    <tr>
      <td width="20%"><code>--host</code></td>
      <td width="20%"><code>PICO_HOST</code></td>
      <td width="13%">Automatic</td>
      <td width="47%"><code>127.0.0.1</code> normally; <code>0.0.0.0</code> on a Raspberry Pi host.</td>
    </tr>
    <tr>
      <td width="20%"><code>--hold</code></td>
      <td width="20%"><code>PICO_HOLD_MS</code></td>
      <td width="13%"><code>900</code></td>
      <td width="47%">Idle time before releasing and soft-resetting the board.</td>
    </tr>
    <tr>
      <td width="20%"><code>--no-open</code></td>
      <td width="20%"><code>PICO_NO_OPEN</code></td>
      <td width="13%"><code>false</code></td>
      <td width="47%">Do not automatically open the default browser on start. Browsers are never opened automatically on Raspberry Pi hosts.</td>
    </tr>
    <tr>
      <td width="20%"><code>--mcp-stdio</code></td>
      <td width="20%"><code>PICO_MCP_STDIO</code></td>
      <td width="13%"><code>false</code></td>
      <td width="47%">Run only the MCP stdio transport. No web server or browser is started.</td>
    </tr>
    <tr>
      <td width="20%"><code>--mcp-http</code></td>
      <td width="20%"><code>PICO_MCP_HTTP</code></td>
      <td width="13%">Pi only</td>
      <td width="47%">Add Streamable HTTP MCP at <code>/mcp</code> to the normal web server. Enabled automatically on Raspberry Pi hosts.</td>
    </tr>
    <tr>
      <td width="20%"><code>--no-mcp</code></td>
      <td width="20%"><code>PICO_NO_MCP</code></td>
      <td width="13%"><code>false</code></td>
      <td width="47%">Disable all MCP transports, including the Raspberry Pi HTTP default.</td>
    </tr>
    <tr>
      <td width="20%"><code>--help</code></td>
      <td width="20%">—</td>
      <td width="13%">—</td>
      <td width="47%">Show command-line help.</td>
    </tr>
    <tr>
      <td width="20%"><code>--version</code></td>
      <td width="20%">—</td>
      <td width="13%">—</td>
      <td width="47%">Show the installed version.</td>
    </tr>
  </tbody>
</table>

Command-line values take precedence over environment variables.
Boolean environment variables accept `true` or `false`, and `1` or `0`.

## Running on a Raspberry Pi

On Linux, pico-bay checks `/proc/device-tree/model`. When the host is a Raspberry Pi, it listens on `0.0.0.0` by default so another computer on the same network can open it. It does not try to launch a browser on the Pi itself, and Streamable HTTP MCP is enabled at `/mcp` by default. Start with `--no-mcp` to disable MCP while keeping the web interface available.

Several USB-connected boards may require a powered USB hub and a reliable Raspberry Pi power supply. MicroPython usually uses slightly less power because it exposes only serial; CircuitPython also exposes storage and HID. After an undervoltage event, pico-bay warns that USB may have stopped; fix the power issue and reboot the Pi.

Raspberry Pi OS Lite and other headless installations commonly detect CircuitPython USB storage without mounting it. When `udisksctl` is available, pico-bay automatically mounts unmounted VFAT partitions labeled `CIRCUITPY` as the current user, then matches each volume to its board through `boot_out.txt`. If mounting is unavailable or denied, it falls back to serial access.

BOOTSEL storage may also be detected without being mounted. pico-bay attempts to mount it with `udisksctl`; if Raspberry Pi OS requires permission, the installation screen shows the command to run on the Pi and a Proceed button to retry afterward.

Only expose pico-bay on a trusted network. It has no login and can modify or erase files on connected boards.

## Board access

pico-bay uses the firmware's raw REPL for serial operations. A serial file or board operation briefly interrupts the running program, performs the requested work, and then soft-resets the board so its normal program resumes. Related operations share a short session controlled by `--hold`; use `--hold 0` to release the board after every operation. Toolbar file execution and interactive console commands are available with either firmware.

Reads, writes, uploads, and downloads are binary-safe.

For CircuitPython, pico-bay matches each `CIRCUITPY` volume by hardware UID. It uses the mounted volume for faster file access when available and serial otherwise. The UI shows read-only only when neither route can write.

When pico-bay stops, it attempts to reset any open board so it is not left halted. Files written to Flash remain after reset; in-memory state does not.

## Backups

Download ZIP creates a standard archive of all board files. Restore recreates its files and folders, overwrites matching paths, and leaves other board files untouched. Keep a separate copy of important files before restoring or using **Delete all files**.

## Security

pico-bay can run code, overwrite files, reset a board, and erase its filesystem. It is intended for a trusted local workstation.

- The server listens on `127.0.0.1` by default, or `0.0.0.0` when the host is a Raspberry Pi.
- State-changing requests require the expected HTTP method and same-origin access.
- Device paths reject invalid or traversing path segments.
- The app has no authentication, TLS, authorization, or multi-user isolation.

Do not expose it to an untrusted network.

## Troubleshooting

### No board appears

- For file access, confirm that the board is running MicroPython or CircuitPython. Supported bootloader modes appear as red device pills instead.
- Use a USB data cable and check that its serial device appears under `/dev` on macOS/Linux or **Ports (COM & LPT)** in Windows Device Manager.
- On Linux, check serial permissions, commonly provided by the `dialout` group.
- On Windows, if your ESP32 board is not detected at all, you may be missing its serial driver. Many ESP32 boards use a CP210x USB to UART bridge. Download the [CP210x Universal Windows Driver](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers) and extract the ZIP. Open **Device Manager**, find the unrecognized device (often under "Other devices"), right-click it, select **Update driver** → **Browse my computer for drivers**, and select the extracted folder.
- Close Thonny, `mpremote`, screen, and other programs that may own the serial port.
- For identification or installation failures, check the Pico Bay terminal for the underlying error.

### BOOTSEL does not appear

On Linux, check `lsusb`, `lsblk -p -o NAME,LABEL,FSTYPE,MOUNTPOINT`, and `sudo dmesg | tail -60`. USB enumeration errors must be resolved before mounting can work; try another data cable or USB port and check the Pi's power supply. An unmounted `RPI-RP2` or `RP2350` volume should still appear in Pico Bay.

### A command times out

- Startup code may be keeping the board busy or disabling interrupts.
- Increase `--hold` when repeated operations collide with a slow `main.py` startup.
- Disconnect and reconnect the board to recover an unknown raw-REPL state.

### The program restarts after file access

This is expected. Raw-REPL access interrupts the program, and pico-bay resets the board afterward so `main.py` can resume.

## Tests

Run the dependency-free test suite with:

```bash
npm test
```

`test.js` covers parsing, ZIP handling, device discovery, HTTP and MCP APIs, and mocked firmware installation. The optional hardware section reports every discovered board, skipping bootloader devices and failing unidentified devices. Other boards continue testing: MicroPython and writable CircuitPython receive temporary file/folder write-read-delete checks; read-only CircuitPython receives capability and console checks. With no devices found, the hardware section is skipped.

## Known limits

- Filesystem operations temporarily stop the running application.
- Uploads are limited to 8 MB; ZIP restore supports Store or Deflate with up to 512 files and 16 MB decompressed.
- Concurrent file-change conflict detection is not provided.

## License

[MIT](http://localhost:8181/LICENSE)
