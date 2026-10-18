#!/usr/bin/env node
'use strict';

/* Manage Raspberry Pi Pico and ESP32 boards with MicroPython or CircuitPython over USB. */

// Set before async filesystem work starts.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '12';

const http = require('http');
const https = require('https');
const fs   = require('fs');
const net  = require('net');
const os   = require('os');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');

// Node has no serial API on Windows: combridge.cs is compiled once per version into a
// helper exe (cached in the temp folder) that opens COM ports for us.
let winSerialHelperPath = null;
if (process.platform === 'win32') {
  // The .NET Framework 4 compiler ships with Windows, in Framework64 or Framework.
  const csc = ['C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', 'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'].find(fs.existsSync);
  if (!csc) {
    console.error('Error: Could not find C# compiler (csc.exe) for native Windows serial communication.');
    process.exit(1);
  }
  winSerialHelperPath = path.join(os.tmpdir(), `pico-bay-combridge-${require('./package.json').version.replaceAll('.', '-')}.exe`);
  if (!fs.existsSync(winSerialHelperPath)) {
    const csPath = path.join(__dirname, 'combridge.cs');
    execFileSync(csc, ['/nologo', '/out:' + winSerialHelperPath, csPath], { stdio: 'ignore' });
  }
}

// ── Config ──────────────────────────────────────────────────────────────────
const VERSION = require('./package.json').version;
const envEnabled = value => /^(1|true)$/i.test(String(value || '').trim());
const args = process.argv.slice(2);
if (require.main === module && args.includes('--version')) {
  console.log(VERSION);
  process.exit(0);
}
if (require.main === module && args.includes('--help')) {
  console.log(`Usage: pico-bay [options]

Options:
  --port PORT         Web server port
  --host ADDRESS      Web server address
  --hold MILLISECONDS Board release delay
  --allow-host NAME   Also accept requests addressed to this host name
  --no-open           Do not open a browser
  --mcp-stdio         Run MCP over stdio
  --mcp-http          Enable MCP over HTTP
  --no-mcp            Disable MCP
  --help              Show this help
  --version           Show the version`);
  process.exit(0);
}
// Command-line flags; each falls back to its PICO_* environment variable, then the default.
let portArg = null;
let holdArg = null;
let hostArg = null;
const allowHostArgs = [];
let noOpen = envEnabled(process.env.PICO_NO_OPEN);
let cliMcpStdio = false;
let cliMcpHttp = false;
let cliNoMcp = envEnabled(process.env.PICO_NO_MCP);
// Flags that take a value read the next argument.
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') portArg = args[++i];
  else if (args[i] === '--hold') holdArg = args[++i];
  else if (args[i] === '--host') hostArg = args[++i];
  else if (args[i] === '--allow-host') allowHostArgs.push(args[++i]);
  else if (args[i] === '--no-open') noOpen = true;
  else if (args[i] === '--mcp-stdio') cliMcpStdio = true;
  else if (args[i] === '--mcp-http') cliMcpHttp = true;
  else if (args[i] === '--no-mcp') cliNoMcp = true;
}
const PORT = parseInt(portArg || process.env.PICO_PORT || '7426', 10);
const RASPBERRY_PI_HOST = isRaspberryPi();
// Loopback by default; a Pi listens on the LAN so another computer can open the UI.
const HOST = hostArg || process.env.PICO_HOST || (RASPBERRY_PI_HOST ? '0.0.0.0' : '127.0.0.1');
// Extra host names the web server answers to (comma-separated or repeated); the --host
// name is one of them, so a server started on a name can be opened by that name.
const ALLOW_HOSTS = hostList([...allowHostArgs, process.env.PICO_ALLOW_HOSTS, HOST]);

// Lower-cased host names from comma-separated values.
function hostList(values) {
  return values.flatMap(value => String(value || '').split(','))
    .map(name => name.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean);
}

// Against DNS rebinding: a page on another domain can point its name at this machine,
// but the browser still sends that name in Host. Only IP addresses, localhost, this
// machine's own name (and <name>.local) and the --allow-host names get through.
function hostAllowed(hostHeader, extra = [], hostname = os.hostname()) {
  const match = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9.-]+))(?::\d+)?$/i.exec(String(hostHeader || ''));
  if (!match) return false;
  const name = (match[1] || match[2]).toLowerCase().replace(/\.$/, '');
  if (net.isIP(name) || name === 'localhost') return true;
  const own = String(hostname || '').toLowerCase().replace(/\.local$/, '');
  if (own && (name === own || name === own + '.local')) return true;
  return extra.includes(name);
}

// Which MCP transports run: command-line flags win over the environment, --no-mcp turns
// both off, and a Raspberry Pi gets HTTP MCP unless stdio was chosen.
function selectMcpTransports(options) {
  if (options.noMcp) return { stdio: false, http: false };
  const cliTransport = options.cliStdio || options.cliHttp;
  const stdio = cliTransport ? options.cliStdio : envEnabled(options.envStdio);
  const http = cliTransport ? options.cliHttp :
    envEnabled(options.envHttp) || (options.raspberryPiHost && !stdio);
  return { stdio, http };
}

const selectedMcp = selectMcpTransports({
  raspberryPiHost: RASPBERRY_PI_HOST, noMcp: cliNoMcp,
  cliStdio: cliMcpStdio, cliHttp: cliMcpHttp,
  envStdio: process.env.PICO_MCP_STDIO, envHttp: process.env.PICO_MCP_HTTP,
});
const mcpStdio = selectedMcp.stdio;
const mcpHttp = selectedMcp.http;
// --no-mcp together with an MCP flag is reported at startup.
const conflictingMcpFlags = cliNoMcp && (cliMcpStdio || cliMcpHttp);

// Delay before leaving raw REPL and restarting main.py. Zero resets immediately.
const HOLD_MS = parseInt(holdArg || process.env.PICO_HOLD_MS || '900', 10);
const README = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
const LICENSE = fs.readFileSync(path.join(__dirname, 'LICENSE'), 'utf8');
// Changes on every start, so an open page can tell the server restarted.
const SERVER_INSTANCE = process.pid + '-' + Date.now();
// The optional Pi automount script is offered in the UI only when it was shipped.
const USB_AUTOMOUNT_SETUP_AVAILABLE = fs.existsSync(path.join(__dirname, 'usb-automount.sh'));
// The whole frontend, served from memory with the version filled in.
const PAGE = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8')
  .split('{{VERSION}}').join(VERSION);

// macOS callout devices open without waiting for carrier detect.
const DEV_DIR = '/dev';
const STTY_FLAG = process.platform === 'darwin' ? '-f' : '-F';

// Promise helpers: a delay, and execFile resolving with its stdout.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const execFileText = (file, argv, options = {}) => new Promise((resolve, reject) => {
  execFile(file, argv, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
});

// Python helper that toggles DTR/RTS on the already-open serial descriptor (fd 3) to
// reset an ESP32 or put it in download mode; Node cannot set modem lines itself. Each
// mode is one sequence: a plain reset ('normal', 'usb-normal'), or download-mode entry
// for native USB-Serial/JTAG, classic auto-reset circuits and the default timing
// ('-slow' variants wait longer).
const ESP_DTR_RTS_RESET = String.raw`
import fcntl, os, struct, sys, termios, time
# Inherit the parent's open serial descriptor; opening the device again can
# change DTR/RTS and race with the parent's serial reader.
fd = 3
attrs = termios.tcgetattr(fd)
attrs[2] = (attrs[2] | termios.CLOCAL | termios.CREAD) & ~termios.HUPCL
attrs[4] = termios.B115200
attrs[5] = termios.B115200
attrs[6][termios.VMIN] = 0
attrs[6][termios.VTIME] = 1
termios.tcsetattr(fd, termios.TCSANOW, attrs)
def lines(dtr, rts):
    state = struct.unpack('I', fcntl.ioctl(fd, termios.TIOCMGET, struct.pack('I', 0)))[0]
    state &= ~(termios.TIOCM_DTR | termios.TIOCM_RTS)
    if dtr: state |= termios.TIOCM_DTR
    if rts: state |= termios.TIOCM_RTS
    fcntl.ioctl(fd, termios.TIOCMSET, struct.pack('I', state))
def line(bit, on):
    request = termios.TIOCMBIS if on else termios.TIOCMBIC
    fcntl.ioctl(fd, request, struct.pack('I', bit))
mode = sys.argv[1] if len(sys.argv) > 1 else 'tight'
delay = 0.55 if mode.endswith('-slow') else 0.05
if mode == 'usb-normal':
    line(termios.TIOCM_DTR, False)
    line(termios.TIOCM_RTS, True)
    line(termios.TIOCM_DTR, False)
    time.sleep(0.2)
    line(termios.TIOCM_RTS, False)
    line(termios.TIOCM_DTR, False)
    time.sleep(0.2)
elif mode == 'normal':
    line(termios.TIOCM_DTR, False)
    line(termios.TIOCM_RTS, True)
    line(termios.TIOCM_DTR, False)
    time.sleep(0.1)
    line(termios.TIOCM_RTS, False)
    line(termios.TIOCM_DTR, False)
elif mode == 'usb-jtag':
    # Espressif USB-Serial/JTAG reset sequence. This peripheral responds to
    # individual line writes, including reapplying DTR after each RTS write.
    def dtr(on):
        global dtr_state
        dtr_state = on
        line(termios.TIOCM_DTR, on)
    def rts(on):
        line(termios.TIOCM_RTS, on)
        line(termios.TIOCM_DTR, dtr_state)
    dtr_state = False
    rts(False)
    dtr(False)
    time.sleep(0.1)
    dtr(True)
    rts(False)
    time.sleep(0.1)
    rts(True)
    dtr(False)
    rts(True)
    time.sleep(0.1)
    dtr(False)
    rts(False)
elif mode.startswith('classic'):
    line(termios.TIOCM_DTR, False)
    line(termios.TIOCM_RTS, True)
    line(termios.TIOCM_DTR, False)
    time.sleep(0.1)
    line(termios.TIOCM_DTR, True)
    line(termios.TIOCM_RTS, False)
    line(termios.TIOCM_DTR, True)
    time.sleep(delay)
    line(termios.TIOCM_DTR, False)
else:
    lines(False, False)
    lines(True, True)
    lines(False, True)
    time.sleep(0.1)
    lines(True, False)
    time.sleep(delay)
    lines(False, False)
    line(termios.TIOCM_DTR, False)
os.close(fd)
`;

// Runs ESP_DTR_RTS_RESET on the open descriptor; killed after 3 s if it hangs.
function resetEspLines(fd, mode) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', ESP_DTR_RTS_RESET, mode], {
      stdio: ['ignore', 'ignore', 'pipe', fd],
    });
    let stderr = '';
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || 'DTR/RTS reset helper timed out or failed'));
    });
  });
}

// The same DTR/RTS sequences on Windows, sent to combridge over its control pipe.
async function winResetEspLines(winPort, mode) {
  if (!winPort || !winPort.winPortControl) throw new Error('Serial control pipe is unavailable');
  // combridge takes "dtr:0|1" and "rts:0|1" lines on its control pipe; the sequences
  // match the Python helper's, one per mode.
  const delay = mode.endsWith('-slow') ? 550 : 50;
  // Sets both lines in one control message.
  const set = (dtr, rts) => new Promise((resolve, reject) => {
    const control = winPort.winPortControl;
    if (!control || control.destroyed) return reject(new Error('Serial control pipe is unavailable'));
    control.write(`dtr:${dtr ? '1' : '0'}\nrts:${rts ? '1' : '0'}\n`, error => error ? reject(error) : resolve());
  });
  // Plain resets for native USB and USB-UART boards, then the download-mode entries.
  if (mode === 'usb-normal') {
    await set(false, true); await sleep(200);
    await set(false, false); await sleep(200);
  } else if (mode === 'normal') {
    await set(false, true); await sleep(100);
    await set(false, false);
  } else if (mode === 'usb-jtag') {
    await set(false, false); await sleep(100);
    await set(true, false); await sleep(100);
    await set(true, true); await sleep(100);
    await set(false, false);
  } else if (mode.startsWith('classic')) {
    await set(false, true); await sleep(100);
    await set(true, false); await sleep(delay);
    await set(false, false);
  } else {
    await set(false, false);
    await set(true, true);
    await set(false, true); await sleep(100);
    await set(true, false); await sleep(delay);
    await set(false, false);
  }
}

// True on a Raspberry Pi: Linux with "Raspberry Pi" in the device-tree model.
function isRaspberryPi(platform = process.platform, model = null) {
  if (platform !== 'linux') return false;
  if (model === null) {
    try { model = fs.readFileSync('/proc/device-tree/model', 'utf8'); }
    catch { return false; }
  }
  return /raspberry pi/i.test(String(model));
}

// A browser opens at startup unless disabled, or on a Pi, which usually has no screen.
function shouldOpenBrowser(disabled, raspberryPiHost) {
  return !disabled && !raspberryPiHost;
}

// Turns `vcgencmd get_throttled` output into a warning when undervoltage was seen (bit 0
// now, bit 16 since boot); null when the power is fine.
function parseRaspberryPiThrottle(output) {
  const match = /throttled=0x([0-9a-f]+)/i.exec(String(output || ''));
  if (!match) return null;
  const flags = parseInt(match[1], 16);
  if (!(flags & 0x10001)) return null;
  return {
    code: 'throttled=0x' + match[1].toLowerCase(),
    current: !!(flags & 0x1),
    message: 'USB may have stopped responding. Check the power supply or use a powered USB hub, then reboot the Pi.',
  };
}

// The Pi power warning, checked at most every 10 s.
let powerWarningCache = { checked: 0, value: null };
function raspberryPiPowerWarning(now = Date.now()) {
  if (!RASPBERRY_PI_HOST) return null;
  if (now - powerWarningCache.checked < 10000) return powerWarningCache.value;
  powerWarningCache.checked = now;
  try {
    powerWarningCache.value = parseRaspberryPiThrottle(execFileSync('vcgencmd', ['get_throttled'], {
      encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch { powerWarningCache.value = null; }
  return powerWarningCache.value;
}

// ── Raw REPL control bytes ──────────────────────────────────────────────────
const CTRL_A = '\x01'; // enter raw REPL
const CTRL_B = '\x02'; // back to the friendly REPL
const CTRL_C = '\x03'; // interrupt the running program
const CTRL_D = '\x04'; // in raw REPL: run the pasted block; in friendly: soft reset
const RAW_BANNER = 'raw REPL; CTRL-B to exit\r\n>';

// Owns one serial conversation and serializes all board operations.
class PicoPort {
  // State for one serial device; the port opens lazily on the first command.
  constructor(dev) {
    this.dev = dev;
    this.deviceIdentity = deviceIdentity(dev);
    this.fd = null;
    this.winPort = null;
    this.closing = false;
    this.connectionGeneration = 0;
    this.chain = Promise.resolve();
    this.rx = '';           // bytes received during a command, not yet consumed
    this.inCommand = false;
    this.capture = null;    // in-flight readUntil, if any
    this.monitors = new Set();
    this.pumping = false;
    this.info = null;       // cached probe result
    this.probeFailure = null; // avoid retry storms for unresponsive boards
    this.probePromise = null; // coalesces overlapping hot-plug polls
    this.busy = false;
    this.halted = false;    // true while the board sits in the raw REPL
    this.idleTimer = null;
  }

  // ── Port lifecycle ──
  // Waits for a previous close to finish before the device is reopened.
  async _waitForClose(timeout = 1500) {
    const deadline = Date.now() + timeout;
    while (this.closing && Date.now() < deadline) await sleep(20);
    if (this.closing) throw new Error('USB serial port is still closing. Reconnect the board, then Scan.');
  }

  // Opens the device: through combridge on Windows (data on stdio, DTR/RTS over a named
  // pipe), elsewhere as a raw tty set up with stty. Starts the reader.
  async _open() {
    if (this.fd !== null || this.winPort !== null) return;
    if (this.closing) throw new Error('USB serial port is still closing. Reconnect the board, then Scan.');
    try {
      this.connectionGeneration++;
      if (process.platform === 'win32') {
        const generation = this.connectionGeneration;
        // combridge connects back to a random named pipe, which carries DTR/RTS commands.
        this.winPortPipeBase = 'picobay_' + crypto.randomBytes(8).toString('hex');
        this.winPortPipe = '\\\\.\\pipe\\' + this.winPortPipeBase;
        const srv = require('net').createServer();
        this.winPortServer = srv;
        await new Promise((resolve, reject) => {
          const fail = error => {
            clearTimeout(timer);
            if (generation === this.connectionGeneration) {
              this._disconnected();
              this._emit('sys', '[board disconnected]\n');
            }
            reject(error);
          };
          // combridge must connect to the pipe within 5 s.
          const timer = setTimeout(() => fail(new Error('Serial control pipe timed out')), 5000);
          srv.on('error', fail);
          srv.on('connection', control => {
            control.on('error', fail);
            if (generation !== this.connectionGeneration) { control.destroy(); return; }
            this.winPortControl = control;
            control.on('close', () => fail(new Error('Serial control pipe closed')));
            clearTimeout(timer);
            resolve();
          });
          try {
            srv.listen(this.winPortPipe);
            // Serial data flows over the helper's stdin and stdout.
            const child = spawn(winSerialHelperPath, [this.dev.replace(/^\\\\?\\\\.\\/, ''), '115200', this.winPortPipeBase], { stdio: ['pipe', 'pipe', 'inherit'] });
            this.winPort = child;
            child.on('error', fail);
            child.on('exit', () => fail(new Error('Board disconnected: ' + this.dev)));
            child.stdin.on('error', fail);
            child.stdout.on('error', fail);
            child.stdout.on('data', data => {
              if (generation === this.connectionGeneration) this._onData(data.toString('binary'));
            });
          } catch (error) { fail(error); }
        });
        return;
      }

      // macOS and Linux open the tty directly.
      this.fd = fs.openSync(this.dev, fs.constants.O_RDWR | fs.constants.O_NOCTTY);
      // Return reads after 100 ms instead of blocking indefinitely.
      execFileSync('stty', [STTY_FLAG, this.dev, 'raw', '-echo', '115200', 'min', '0', 'time', '1'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch (error) {
      this._disconnected();
      const failure = new Error('Board disconnected: ' + this.dev);
      failure.code = error.code || error.message;
      throw failure;
    }
    this._pump();
  }

  // Closes the device without blocking the event loop.
  _close() {
    if (this.winPortServer) {
      this.winPortServer.close();
      this.winPortServer = null;
    }
    if (this.winPort !== null) {
      this.connectionGeneration++;
      const child = this.winPort;
      this.winPort = null;
      if (this.winPortControl) {
        this.winPortControl.destroy();
        this.winPortControl = null;
      }
      // An exit/error handler may be closing a helper that has already stopped.
      this.closing = !!child.pid && child.exitCode === null && child.signalCode === null;
      if (this.closing) child.once('close', () => { this.closing = false; });
      child.stdin.end();
      return;
    }
    if (this.fd === null) return;
    this.connectionGeneration++;
    const fd = this.fd;
    this.fd = null;
    // A USB driver can wait indefinitely in close() after a native-USB ESP
    // resets. Detach immediately and keep that wait off the event loop.
    this.closing = true;
    fs.close(fd, () => { this.closing = false; });
  }

  // Forgets everything learned about the board and fails any read in progress.
  _disconnected() {
    const capture = this.capture;
    this.capture = null;
    this._close();
    this.halted = false;
    this.info = null;
    this.probeFailure = null;
    this.deviceIdentity = null;
    if (capture && capture.reject) capture.reject(new Error('Board disconnected: ' + this.dev));
  }

  // Single reader for command replies and console output.
  async _pump() {
    if (this.pumping) return;
    this.pumping = true;
    const buf = Buffer.alloc(8192);
    try {
      while (this.fd !== null) {
        const fd = this.fd;
        const generation = this.connectionGeneration;
        let n = 0;
        try {
          n = await new Promise((res, rej) =>
            fs.read(fd, buf, 0, buf.length, null, (e, cnt) => (e ? rej(e) : res(cnt))));
        } catch (e) {
          if (generation !== this.connectionGeneration) continue;
          if (e.code === 'EAGAIN' || e.code === 'EINTR') { await sleep(20); continue; }
          // Drop disconnected descriptors before the next command.
          this._disconnected();
          this._emit('sys', '[board disconnected]\n');
          break;
        }
        if (generation === this.connectionGeneration && n > 0) this._onData(buf.subarray(0, n).toString('binary'));
      }
    } finally {
      this.pumping = false;
    }
  }

  // Bytes go to the running command, or to console subscribers when idle.
  _onData(chunk) {
    if (this.inCommand) { this.rx += chunk; this._check(); return; }
    this._emit('out', chunk);
  }

  // Consume through the requested boundary and retain trailing bytes.
  _check() {
    const cap = this.capture;
    if (!cap) return;
    if (cap.onChunk && this.rx.length > cap.fwd) {
      cap.onChunk(this.rx.slice(cap.fwd));
      cap.fwd = this.rx.length;
    }
    let end;
    if (cap.want != null) {                    // waiting for a byte count
      if (this.rx.length < cap.want) return;
      end = cap.want;
    } else {                                   // waiting for a token
      const at = this.rx.indexOf(cap.needle);
      if (at === -1) return;
      end = at + cap.needle.length;
    }
    const taken = this.rx.slice(0, end);
    this.rx = this.rx.slice(end);
    this.capture = null;
    cap.resolve(taken);
  }

  // Sends console text ('out' or 'sys') to every subscriber.
  _emit(type, text) {
    for (const m of this.monitors) { try { m(type, text); } catch { /* client gone */ } }
  }

  // ── Primitives ──

  // Handle short tty writes.
  _writeAll(buf, off, len) {
    if (this.winPort !== null) {
      return new Promise((resolve, reject) => {
        this.winPort.stdin.write(buf.subarray(off, off + len), error => error ? reject(error) : resolve());
      });
    }
    let done = 0;
    while (done < len) {
      if (this.fd === null) throw new Error('port closed');
      done += fs.writeSync(this.fd, buf, off + done, len - done);
    }
  }

  // Feed plain raw REPL in small chunks because it lacks flow control.
  async write(data) {
    const buf = Buffer.from(data, 'binary');
    if (buf.length <= 256) { await this._writeAll(buf, 0, buf.length); return; }
    for (let off = 0; off < buf.length; off += 256) {
      await this._writeAll(buf, off, Math.min(256, buf.length - off));
      await sleep(2);
    }
  }

  // Waits for a token (needle) or a byte count (want) in the receive buffer.
  _read(spec, timeoutMs, onChunk) {
    if (this.capture) return Promise.reject(new Error('read already in flight'));
    return new Promise((resolve, reject) => {
      const cap = { ...spec, onChunk: onChunk || null, fwd: 0, resolve: null, reject: null };
      const timer = setTimeout(() => {
        if (this.capture === cap) this.capture = null;
        reject(new Error('timed out waiting for the board (' +
                         JSON.stringify(spec.needle != null ? spec.needle : spec.want + ' bytes') +
                         '); got ' + JSON.stringify(this.rx.slice(-200))));
      }, timeoutMs);
      cap.resolve = (v) => { clearTimeout(timer); resolve(v); };
      cap.reject = (e) => { clearTimeout(timer); reject(e); };
      this.capture = cap;
      this._check();   // the answer may already be sitting in the buffer
    });
  }

  // Resolves with everything up to and including `needle`.
  readUntil(needle, timeoutMs = 10000, onChunk = null) {
    return this._read({ needle }, timeoutMs, onChunk);
  }

  // Resolves with exactly `want` bytes.
  readN(want, timeoutMs = 5000) {
    return this._read({ want }, timeoutMs, null);
  }

  // Retry until startup code becomes interruptible.
  async _enterRaw(budgetMs = 8000) {
    const deadline = Date.now() + budgetMs;
    let lastErr;
    do {
      try {
        // Leave any raw REPL, interrupt the program twice, then enter the raw REPL.
        await this.write('\r' + CTRL_B);
        await sleep(50);
        await this.write('\r' + CTRL_C);
        await sleep(150);
        await this.write(CTRL_C);
        await sleep(150);
        this.capture = null;                     // discard the interrupt traceback
        this.rx = '';
        await this.write(CTRL_A);
        // Start reading after a successful write to avoid orphaned timeout promises.
        await this.readUntil(RAW_BANNER, 1500);
        return;
      } catch (e) { lastErr = e; }
    } while (Date.now() < deadline);
    throw lastErr || new Error('could not enter the raw REPL');
  }

  // Soft reset so main.py starts again.
  async _resume() {
    try {
      await this.write(CTRL_B);
      await sleep(30);
      await this.write(CTRL_D);
      await sleep(60);
    } catch { /* port already gone */ }
  }

  // Send code with raw-paste flow control; return false when unsupported.
  async _rawPasteWrite(code) {
    await this.write('\x05A\x01');
    const hdr = await this.readN(2, 3000);
    if (hdr !== 'R\x01') {
      // R\x00 means raw-paste is unsupported.
      if (hdr !== 'R\x00') await this.readUntil('w REPL; CTRL-B to exit\r\n>', 3000).catch(() => {});
      return false;
    }
    const ws = await this.readN(2, 3000);
    // The board grants a window of bytes; each \x01 it sends adds another window.
    const windowSize = ws.charCodeAt(0) | (ws.charCodeAt(1) << 8);
    let remain = windowSize;
    const buf = Buffer.from(code + CTRL_D, 'binary');

    let i = 0;
    while (i < buf.length) {
      while (remain === 0 || this.rx.length) {
        const b = this.rx.length ? this._takeByte() : await this.readN(1, 30000);
        if (b === '\x01') remain += windowSize;
        else if (b === '\x04') { await this.write(CTRL_D); return true; }  // board gave up
      }
      const n = Math.min(remain, buf.length - i);
      await this._writeAll(buf, i, n);
      i += n;
      remain -= n;
    }
    // Wait for the board to confirm it has the whole block before reading its reply.
    await this.readUntil('\x04', 10000);   // end-of-data acknowledgement
    return true;
  }

  // Removes and returns the first buffered byte.
  _takeByte() {
    const b = this.rx[0];
    this.rx = this.rx.slice(1);
    return b;
  }

  // Execute code and return raw REPL's separate stdout and stderr streams.
  async exec(code, {
    timeout = 20000,
    onChunk = null,
    rawPaste = this.info?.firmware !== 'circuitpython',
  } = {}) {
    let plainRaw = false;
    if (!rawPaste || !(await this._rawPasteWrite(code))) {
      // Plain raw REPL uses the shared \x04> terminator.
      plainRaw = true;
      // CircuitPython's plain raw REPL needs byte-wise pacing.
      const buf = Buffer.from(code + CTRL_D, 'binary');
      for (let off = 0; off < buf.length; off += 1) {
        await this._writeAll(buf, off, 1);
        await sleep(1);
      }
    }
    // The reply is stdout, \x04, stderr, \x04> (plain raw mode adds a leading OK); only stdout is streamed.
    let acc = '', seen = 0;
    const res = await this.readUntil('\x04>', timeout, onChunk && ((chunk) => {
      // Forward stdout only.
      acc += chunk;
      const end = acc.indexOf('\x04');
      const upto = end === -1 ? acc.length : end;
      if (upto > seen) { onChunk(acc.slice(seen, upto)); seen = upto; }
    }));
    let body = res.slice(0, res.indexOf('\x04>'));
    if (plainRaw && body.startsWith('OK')) body = body.slice(2);
    const cut = body.indexOf('\x04');
    const out = cut === -1 ? body : body.slice(0, cut);
    const err = cut === -1 ? '' : body.slice(cut + 1);
    return { out, err };
  }

  // Serialize work and debounce release by HOLD_MS.
  command(fn, { rawRepl = true } = {}) {
    // Opens the port, enters the raw REPL once, runs fn, then holds or releases the board.
    const run = async () => {
      this._cancelIdle();
      this.busy = true;
      this.inCommand = true;
      try {
        await this._waitForClose();
        await this._open();
        if (rawRepl && !this.halted) {
          this.rx = '';
          await this._enterRaw();
          this.halted = true;
        }
        return await fn(this);
      } catch (e) {
        // Force the next command to resynchronize after failure.
        this.halted = false;
        throw e;
      } finally {
        this.busy = false;
        this.inCommand = false;
        this.capture = null;
        this.rx = '';
        if (this.halted) this._scheduleIdle();
        else await this._release();
      }
    };
    // Runs after everything queued before it, whether that succeeded or failed.
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  // Stops a pending release.
  _cancelIdle() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  // Releases the board HOLD_MS after the last command, unless another one arrives first.
  _scheduleIdle() {
    this._cancelIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // Queue release to avoid racing a new command.
      this.chain = this.chain.then(() => this._release()).catch(() => {});
    }, HOLD_MS);
  }

  // Restart main.py and close unused ports.
  async _release(force = false) {
    this._cancelIdle();
    if (this.busy) return;
    this.inCommand = false;
    this.capture = null;
    this.rx = '';
    if (this.halted) { await this._resume(); this.halted = false; }
    // Reopening USB-UART adapters can toggle DTR/RTS and knock an ESP32 out
    // of download mode. Keep its identified ROM session open until install,
    // disconnect, shutdown, or an explicit release.
    if (!force && (this.info?.bootloader === 'esp-rom' || Date.now() < (this.rebootingUntil || 0))) return;
    if (this.monitors.size === 0) this._close();
  }

  // Releases the board once queued work is done, even an ESP32 held in download mode.
  releaseNow() {
    const next = this.chain.then(() => this._release(true), () => this._release(true));
    this.chain = next.catch(() => {});
    return next;
  }

  // Subscribes a console client; the port stays open while any are attached.
  async addMonitor(fn) {
    await this._waitForClose();
    await this._open();
    this.monitors.add(fn);
  }
  // Unsubscribes, and closes the port when nothing else needs it.
  removeMonitor(fn) {
    this.monitors.delete(fn);
    if (this.monitors.size === 0 && !this.busy && !this.halted && this.info?.bootloader !== 'esp-rom' &&
        Date.now() >= (this.rebootingUntil || 0)) this._close();
  }
}

// ── Device registry ─────────────────────────────────────────────────────────
const ports = new Map(); // dev path -> PicoPort
const espInstalls = new Set(); // serial paths with an active firmware installation
let deviceListOverride = null; // test seam; null always in normal CLI use

// What each firmware supports and how to hard-reset it. CircuitPython counts as
// read-only until a writable route (serial or a mounted volume) is found.
const FIRMWARE_ADAPTERS = {
  micropython: {
    id: 'micropython', label: 'MicroPython', readOnly: false, console: true, run: true,
    hardResetCode: 'import machine\nmachine.reset()',
  },
  circuitpython: {
    id: 'circuitpython', label: 'CircuitPython', readOnly: true, console: true, run: true,
    hardResetCode: 'import microcontroller\nmicrocontroller.reset()',
  },
  unknown: {
    id: 'unknown', label: 'Unknown firmware', readOnly: true, console: false, run: false,
    hardResetCode: '',
  },
};

// The adapter for a firmware name, or the 'unknown' one.
function firmwareAdapter(name) {
  return FIRMWARE_ADAPTERS[name] || FIRMWARE_ADAPTERS.unknown;
}

// Strips terminal escape codes (titles, colours) from REPL output.
function cleanReplOutput(text) {
  return String(text)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

// Collects the PVI_* values a probe printed into { impl, machine, release, uid }.
function parseProbeOutput(out) {
  const values = {};
  for (const line of cleanReplOutput(out).split(/\r?\n/)) {
    const m = /PVI_(IMPL|MACHINE|RELEASE|UID)\s+(.*)$/.exec(line);
    if (m) values[m[1].toLowerCase()] = m[2].trim();
  }
  return values;
}

// Serial devices that can be boards: COM ports from the Windows registry (Bluetooth
// excluded), cu.usbmodem / cu.usbserial on macOS, ttyACM / ttyUSB on Linux.
function listDevs(platform = process.platform) {
  if (deviceListOverride) return [...deviceListOverride];
  if (platform === 'win32') {
    try {
      // Windows: every COM port in the registry, Bluetooth ports excluded.
      const reg = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'reg.exe') : 'reg';
      const out = execFileSync(reg, ['query', 'HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      const ports = [];
      for (const line of out.split(/\r?\n/)) {
        if (/BthModem|Bluetooth/i.test(line)) continue;
        const match = /\b(COM\d+)\b/i.exec(line);
        if (match && !ports.includes(match[1])) ports.push(match[1]);
      }
      return ports.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    } catch { return []; }
  }
  // macOS and Linux: USB serial devices in /dev.
  const devMatch = platform === 'darwin'
    ? /^cu\.(usbmodem|usbserial)/
    : /^(ttyACM|ttyUSB)/;
  try {
    return fs.readdirSync(DEV_DIR)
      .filter(n => devMatch.test(n))
      .map(n => path.posix.join(DEV_DIR, n))
      .sort();
  } catch { return []; }
}

// Identifies the physical device behind a path (inode and device number), so a board
// unplugged and replaced on the same path is treated as a new one.
function deviceIdentity(dev) {
  try {
    const stat = fs.statSync(dev);
    return String(stat.ino) + ':' + String(stat.rdev);
  } catch {
    return process.platform === 'win32' && /^COM\d+$/i.test(dev) ? dev : null;
  }
}

// The PicoPort for a device path, created on first use.
function getPort(dev) {
  if (!ports.has(dev)) ports.set(dev, new PicoPort(dev));
  return ports.get(dev);
}

// Espressif ROM serial protocol. Detection uses only read-only commands; the
// flash commands below are reached only by an explicitly confirmed install.
// https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/serial-protocol.html
// SLIP framing used by the ROM: 0xC0 delimits a frame, 0xDB escapes 0xC0 and 0xDB.
function espSlipEncode(bytes) {
  const out = [0xc0];
  for (const byte of bytes) {
    if (byte === 0xc0) out.push(0xdb, 0xdc);
    else if (byte === 0xdb) out.push(0xdb, 0xdd);
    else out.push(byte);
  }
  out.push(0xc0);
  return Buffer.from(out);
}

// Undoes espSlipEncode for one frame without its delimiters.
function espSlipDecode(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    let byte = bytes[i];
    if (byte === 0xdb) {
      const escaped = bytes[++i];
      if (escaped !== 0xdc && escaped !== 0xdd) throw new Error('Invalid ESP SLIP escape');
      byte = escaped === 0xdc ? 0xc0 : 0xdb;
    }
    out.push(byte);
  }
  return Buffer.from(out);
}

// The ROM commands this file may send: flash, memory, sync, register reads, MD5, security info.
const ESP_ROM_COMMANDS = new Set([0x02, 0x03, 0x04, 0x08, 0x0a, 0x0b, 0x0d, 0x10, 0x11, 0x12, 0x13, 0x14]);

// Sends one ROM command and waits for its reply frame, skipping boot log noise. Returns
// { value, data }, or throws with the ROM's error code.
async function espRomCommand(port, opcode, data = Buffer.alloc(0), timeout = 700, checksum = 0) {
  if (!ESP_ROM_COMMANDS.has(opcode)) throw new Error('Unsupported ESP ROM command');
  const request = Buffer.alloc(8 + data.length);
  request[1] = opcode;
  request.writeUInt16LE(data.length, 2);
  request.writeUInt32LE(checksum >>> 0, 4);
  data.copy(request, 8);
  await port.write(espSlipEncode(request).toString('binary'));
  const deadline = Date.now() + timeout;
  // Bound both traffic and time; ignore boot logs and extra SYNC replies.
  for (let count = 0; count < 64 && Date.now() < deadline; count++) {
    let frame;
    try {
      frame = await port.readUntil('\xc0', Math.max(1, deadline - Date.now()));
    } catch (error) {
      if (/timed out waiting for the board/.test(String(error.message || error))) {
        throw new Error('ESP ROM did not respond to command 0x' +
          opcode.toString(16).padStart(2, '0') +
          '. Keep the board in download mode, check its USB connection and power, then Scan and retry.');
      }
      throw error;
    }
    // Skip frames that are not a well-formed reply to this command.
    if (frame.length > 4096) throw new Error('Oversized ESP response');
    let reply;
    try { reply = espSlipDecode(Buffer.from(frame.slice(0, -1), 'binary')); }
    catch { continue; }
    if (reply.length < 10 || reply[0] !== 1 || reply[1] !== opcode) continue;
    const size = reply.readUInt16LE(2);
    if (reply.length !== 8 + size || size < 2) continue;
    // The status sits in the last 2 or 4 bytes; a nonzero first byte is a ROM error.
    const statusSize = size === 2 ? 2 : 4;
    if (reply[reply.length - statusSize] !== 0 || reply[reply.length - statusSize + 1] !== 0) {
      const code = reply[reply.length - statusSize + 1];
      throw new Error('ESP ROM rejected command 0x' + opcode.toString(16).padStart(2, '0') +
        ' (error 0x' + code.toString(16).padStart(2, '0') + ')');
    }
    return { value: reply.readUInt32LE(4), data: reply.subarray(8, reply.length - statusSize) };
  }
  throw new Error('No matching ESP ROM response');
}

// Recognises an ESP32 in ROM download mode with read-only commands only: SYNC, then the
// chip from security info or the magic register, its MAC and its security state.
// Returns a device record for the red DOWNLOAD pill, or null when no ROM answers.
async function detectEspBootloader(port) {
  port.rx = '';
  // The SYNC payload: 07 07 12 20 followed by 32 bytes of 0x55.
  const sync = Buffer.concat([Buffer.from([7, 7, 18, 32]), Buffer.alloc(32, 0x55)]);
  let synced = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // ROMs vary in the SYNC value field. A matching opcode and successful
      // status establish synchronization; chip identity is read below.
      const reply = await espRomCommand(port, 0x08, sync);
      if (reply.value === 0) continue; // A running flasher stub is not the ROM.
      synced = true;
      break;
    }
    catch { /* Retry synchronization, but never reset or write firmware. */ }
  }
  if (!synced) return null;
  const details = { mode: 'ROM download mode', baudRate: 115200 };
  let chip = null;
  const readReg = async address => {
    const data = Buffer.alloc(4);
    data.writeUInt32LE(address);
    return (await espRomCommand(port, 0x0a, data)).value;
  };
  try {
    // GET_SECURITY_INFO: secure boot, secure download and flash encryption, plus the chip
    // id on newer chips.
    const { data } = await espRomCommand(port, 0x14);
    if (data.length === 12 || data.length === 20) {
      const flags = data.readUInt32LE(0);
      details.secureBoot = !!(flags & 1);
      details.secureDownload = !!(flags & 4);
      details.flashCryptCount = data[4];
      details.flashEncryption = (data[4].toString(2).replace(/0/g, '').length & 1) === 1;
      details.securityChecked = true;
      if (data.length === 20) {
        details.chipId = data.readUInt32LE(12);
        chip = ({ 5: 'ESP32-C3', 9: 'ESP32-S3' })[details.chipId] || null;
      }
    }
  } catch { /* Older ROMs do not implement GET_SECURITY_INFO. */ }
  if (!chip && details.chipId === undefined) {
    try {
      // Chips without a chip id are identified by the magic value at 0x40001000.
      const magic = await readReg(0x40001000);
      details.magic = '0x' + magic.toString(16).padStart(8, '0');
      chip = ({ [0x00f01d83]: 'ESP32', [0x000007c6]: 'ESP32-S2' })[magic] || null;
    } catch { /* Restricted ROMs can deny register reads. */ }
  }
  if (chip === 'ESP32') {
    try {
      // Classic ESP32: the MAC address from eFuse.
      const low = await readReg(0x3ff5a004);
      const high = await readReg(0x3ff5a008);
      const mac = Buffer.alloc(6);
      mac.writeUInt16BE(high & 0xffff, 0);
      mac.writeUInt32BE(low, 2);
      details.mac = [...mac].map(byte => byte.toString(16).padStart(2, '0')).join(':');
    } catch { /* Keep the confirmed chip even if optional identity is unavailable. */ }
    try {
      // Classic ESP32: flash encryption count and secure boot from eFuse.
      const security0 = await readReg(0x3ff5a000);
      const security6 = await readReg(0x3ff5a018);
      const cryptCount = (security0 >>> 20) & 0x7f;
      details.flashCryptCount = cryptCount;
      details.flashEncryption = (cryptCount.toString(2).replace(/0/g, '').length & 1) === 1;
      details.secureBoot = !!(security6 & 0x30);
      details.securityChecked = true;
    } catch { /* Security registers are best-effort during identification. */ }
  }
  // Install only on an identified chip whose security state is known and unlocked.
  details.installSupported = !!chip && !!details.securityChecked && !details.secureDownload &&
    !details.secureBoot && !details.flashEncryption;
  const installFirmware = espFirmwareForChip(chip);
  return {
    dev: port.dev, bootMode: true, bootloader: 'esp-rom',
    firmware: 'esp-bootloader', firmwareLabel: 'Download mode',
    machine: chip || 'Espressif chip (unidentified)', label: chip || 'Espressif',
    release: '', uid: details.mac ? details.mac.replace(/:/g, '') : '',
    serial: '', readOnly: true, bootDetails: details,
    installFirmware: installFirmware ? {
      id: installFirmware.id, name: installFirmware.name,
      build: installFirmware.build, page: installFirmware.page,
      address: installFirmware.offset,
    } : null,
    capabilities: { read: false, write: false, run: false, console: false },
  };
}

// Accept complete probe markers even when auto-reload prevents the final prompt.
async function probeRecord(port, key, code, attempts = 4) {
  // The value is read from its PVI_<key> marker anywhere in the output.
  const marker = key === 'IMPL'
    ? /PVI_IMPL\s*(micropython|circuitpython)/
    : new RegExp('PVI_' + key + '\\s+([^\\r\\n\\x04\\x1b"\\\\]*)');
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let text = '';
    try {
      const result = await port.command(pt => pt.exec(code, { timeout: 8000, rawPaste: false }));
      if (result.err.trim()) lastError = new Error(pyError(result.err));
      text = result.out;
    } catch (error) {
      lastError = error;
      text = String(error.message || error);
    }
    const found = marker.exec(cleanReplOutput(text));
    if (found && found[1].trim()) return found[1].trim();
    // No firmware answered the first try: check for ESP download mode, then explain the
    // common failure (blank flash, watchdog reset loop) before giving up.
    if (key === 'IMPL' && attempt === 0 && port instanceof PicoPort) {
      const boot = await port.command(async active => {
        const found = await detectEspBootloader(active);
        if (found) active.info = found;
        return found;
      }, { rawRepl: false }).catch(() => null);
      if (boot) { port.info = boot; return 'esp-bootloader'; }
      if (/invalid header:\s*0x[fF]{8}/i.test(text)) {
        throw new Error('ESP reports an invalid flash header and is not in download mode. ' +
          'Hold BOOT, press and release RESET/EN, keep holding BOOT for 3 seconds, then release and Scan. ' +
          'If there is no RESET button, reconnect USB while holding BOOT and keep holding for 3 seconds.');
      }
      // Watchdog reset messages repeating mean the flashed program crashes on boot.
      const resetLoop = /RTCWDT_RTC_RESET|TG0WDT_SYS_RESET|TG1WDT_SYS_RESET/.test(text);
      if (resetLoop) {
        throw new Error('Board reports watchdog resets during flash boot and does not respond to MicroPython or the download bootloader.');
      }
      if (lastError && !/timeout|no matching|PVI_IMPL/i.test(lastError.message)) {
        throw lastError;
      }
      throw new Error('Board did not respond to MicroPython or the ESP download bootloader. Check its firmware and boot mode, then Scan to retry.');
    }
  }
  if (lastError) throw lastError;
  throw new Error('board did not report ' + key.toLowerCase());
}

// One probe for machine, release, UID and writability (hex-encoded so nothing breaks
// the marker parsing). Retries while startup code is still running.
async function probeDetails(port, firmware, attempts = 6) {
  // One line of board code printing everything; CircuitPython also reports whether its
  // filesystem is writable from the board.
  const code = firmware === 'circuitpython'
    ? "import os,binascii,microcontroller,storage;u=os.uname();print('PVI_DETAILS',binascii.hexlify(u.machine.encode()).decode(),u.release,binascii.hexlify(microcontroller.cpu.uid).decode(),0 if storage.getmount('/').readonly else 1)"
    : "import os,binascii,machine;u=os.uname();print('PVI_DETAILS',binascii.hexlify(u.machine.encode()).decode(),u.release,binascii.hexlify(machine.unique_id()).decode(),1)";
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let text = '';
    try {
      const result = await port.command(pt => pt.exec(code, { timeout: 8000, rawPaste: false }));
      if (result.err.trim()) lastError = new Error(pyError(result.err));
      text = result.out;
    } catch (error) {
      lastError = error;
      text = String(error.message || error);
    }
    const found = /PVI_DETAILS\s+([0-9a-f]+)\s+(\S+)\s+([0-9a-f]+)\s+([01])/.exec(cleanReplOutput(text));
    if (found) {
      return {
        machine: Buffer.from(found[1], 'hex').toString('utf8'),
        release: found[2],
        uid: found[3],
        writable: found[4] === '1',
      };
    }
  }
  if (lastError) throw lastError;
  throw new Error('board did not report its details');
}

// Cache probes because they interrupt the running program.
async function probe(dev) {
  const p = getPort(dev);
  // Wait out a reboot in progress, then reuse a known result or a probe already running;
  // a recent failure is reported again for 10 s instead of probing again.
  if (Date.now() < (p.rebootingUntil || 0)) await sleep(p.rebootingUntil - Date.now());
  if (p.info) return p.info;
  if (p.probePromise) return p.probePromise;
  if (p.probeFailure && Date.now() < p.probeFailure.retryAt) throw p.probeFailure.error;
  const oldFailure = p.probeFailure;
  p.probeFailure = null;
  // Firmware first (or ESP download mode), then its details. CircuitPython reports
  // each value in its own command; MicroPython all at once.
  const identify = async () => {
    const detected = await probeRecord(
      p,
      'IMPL',
      "import sys;print('PVI_IMPL',getattr(sys.implementation,'name','micropython'))",
      1,
    );
    // An ESP32 in download mode was recognised; its record is already set.
    if (detected === 'esp-bootloader') return p.info;
    let values;
    if (detected === 'circuitpython') {
      values = {
        machine: await probeRecord(p, 'MACHINE', "import os;print('PVI_MACHINE',os.uname().machine)"),
        release: await probeRecord(p, 'RELEASE', "import os;print('PVI_RELEASE',os.uname().release)"),
        uid: await probeRecord(
          p, 'UID',
          "import binascii,microcontroller;print('PVI_UID',binascii.hexlify(microcontroller.cpu.uid).decode())",
        ),
        writable: (await probeRecord(
          p, 'WRITABLE',
          "import storage;print('PVI_WRITABLE',0 if storage.getmount('/').readonly else 1)",
        )) === '1',
      };
    } else {
      values = await probeDetails(p, detected);
    }
    // Build the cached record: firmware, model, capabilities and read-only state.
    const implementation = detected;
    const adapter = firmwareAdapter(implementation);
    const readOnly = implementation === 'circuitpython' ? !values.writable : false;
    const machine = values.machine || '';
    const release = values.release || '';
    const uid = values.uid || '';
    p.info = {
      dev,
      firmware: adapter.id,
      firmwareLabel: adapter.label,
      // Board-side state; scanDevices also checks host mount access.
      serialReadOnly: readOnly,
      readOnly,
      capabilities: { read: true, write: !readOnly, run: adapter.run, console: adapter.console },
      machine,
      release,
      uid,
      label: shortModel(machine),
      serial: (uid || path.basename(dev)).slice(-4),
    };
    return p.info;
  };
  // One shared probe per board; a failure is retried once after 2 s, unless the board
  // was unplugged or replaced meanwhile.
  p.probePromise = (async () => {
    try { return await identify(); }
    catch (error) {
      // Keep one shared pending probe through the delay: polling must not
      // show the first failure or start additional attempts.
      await sleep(2000);
      const identity = deviceIdentity(dev);
      if (ports.get(dev) !== p || (p.deviceIdentity && identity && p.deviceIdentity !== identity)) throw error;
      return identify();
    }
  })();
  try { return await p.probePromise; }
  catch (error) {
    p.probeFailure = { error, retryAt: oldFailure ? Infinity : Date.now() + 10000 };
    throw error;
  }
  finally { p.probePromise = null; }
}

// The route for writing to a board: a writable mounted CIRCUITPY volume, else serial.
// Throws when the filesystem is read-only both ways.
async function requireWritable(dev) {
  const info = await probe(dev);
  if (info.firmware === 'circuitpython') {
    const serialReadOnly = info.serialReadOnly ?? info.readOnly;
    const root = await circuitRootForInfo(info);
    if (root && mountedRootWritable(root)) return { info, mode: 'mount', root };
    if (!serialReadOnly) return { info, mode: 'serial', root: null };
  } else if (!info.readOnly) {
    return { info, mode: 'serial', root: null };
  }
  throw new Error(info.firmwareLabel + ' filesystem is read-only (no writable serial filesystem or matched CIRCUITPY volume)');
}

// "Raspberry Pi Pico 2 W with RP2350" -> "Pico 2 W"
function shortModel(machine) {
  if (!machine) return 'Pico';
  let m = machine.replace(/^Raspberry Pi\s+/i, '').split(/\s+with\s+/i)[0].trim();
  if (/\bESP32/i.test(m)) {
    m = m.replace(/^Generic\s+/i, '').replace(/\s+module$/i, '').trim();
  }
  return m || machine;
}

// What was last logged per device, so the terminal shows each change only once.
const loggedDevices = new Map();
let loggedNoDevices = false;

// The device list for the UI: drops ports that vanished or now belong to another
// device, probes the rest (or, without waitForProbes, returns "Identifying board…"
// placeholders while probing continues), adds CIRCUITPY mount state and BOOTSEL drives.
async function scanDevices({ waitForProbes = true } = {}) {
  const devs = listDevs();
  const bootDevices = deviceListOverride ? Promise.resolve(bootselDeviceOverride || []) : bootselDevices();
  // Forget ports whose device is gone or now belongs to another board.
  for (const [dev, port] of ports) {
    if (devs.includes(dev)) {
      const identity = deviceIdentity(dev);
      if (!port.deviceIdentity || !identity || port.deviceIdentity === identity) {
        if (identity) port.deviceIdentity = identity;
        continue;
      }
    }
    port._cancelIdle();
    port._disconnected();
    ports.delete(dev);
  }
  // Identify every board in parallel.
  const serialDevices = await Promise.all(devs.map(async (dev) => {
    try {
      const port = getPort(dev);
      if (!waitForProbes && !port.info &&
          !(port.probeFailure && Date.now() < port.probeFailure.retryAt)) {
        // Start/coalesce identification, but return the other boards immediately.
        if (Date.now() >= (port.rebootingUntil || 0)) void probe(dev).catch(() => {});
        return {
          dev, ok: false, probing: true, label: path.basename(dev).replace(/^cu\./, ''),
          serial: '', error: 'Identifying board…',
          capabilities: { read: false, write: false, run: false, console: false },
        };
      }
      const info = await probe(dev);
      if (info.firmware === 'circuitpython') {
        const root = await circuitRootForInfo(info);
        // CircuitPython is writable when serial or a mounted volume can write; an unmounted
        // volume gets the command that would mount it.
        const mountWritable = !!root && mountedRootWritable(root);
        info.mountAvailable = !!root;
        info.mountWritable = mountWritable;
        info.readOnly = !!(info.serialReadOnly ?? info.readOnly) && !mountWritable;
        info.capabilities.write = !info.readOnly;
        const unmounted = unmountedCircuitVolumes.get(String(info.uid || '').toLowerCase());
        info.mountCommand = info.readOnly && !root && unmounted
          ? 'udisksctl mount --block-device ' + unmounted : null;
      }
      return { ...info, ok: true };
    } catch (e) {
      let msg = String(e.message || e);
      if (msg.includes('timed out waiting for the board')) {
        msg = 'Board is unresponsive (timed out).';
      }
      return {
        dev, ok: false, error: msg,
        machine: '', release: '', uid: '',
        label: path.basename(dev).replace(/^cu\./, ''), serial: path.basename(dev).slice(-4),
      };
    }
  }));
  // Running boards first, then install-mode devices, each group sorted by name.
  return serialDevices.concat(await bootDevices)
    .sort((a, b) => Number(!!a.bootMode) - Number(!!b.bootMode) ||
      String(a.label || a.machine || a.dev).localeCompare(String(b.label || b.machine || b.dev)) ||
      String(a.dev).localeCompare(String(b.dev)));
}

// Logs boards that appeared, changed or failed identification, once per change.
function logDeviceChanges(devices) {
  if (!devices.length) {
    if (!loggedNoDevices) console.log('no device connected');
    loggedNoDevices = true;
    loggedDevices.clear();
    return;
  }

  loggedNoDevices = false;
  const present = new Set(devices.map(d => d.dev));
  for (const dev of loggedDevices.keys()) {
    if (!present.has(dev)) loggedDevices.delete(dev);
  }
  for (const device of devices) {
    if (device.probing) continue;
    // Log a board again only when something about it changed.
    const signature = [device.ok, device.firmware, device.machine, device.release, device.uid, device.error].join('|');
    if (loggedDevices.get(device.dev) === signature) continue;
    loggedDevices.set(device.dev, signature);
    if (device.bootMode) {
      console.log('device found: ' + device.machine + (device.bootloader === 'esp-rom'
        ? ' · ROM download mode · ' + device.dev : ' · BOOTSEL firmware-install mode'));
    } else if (device.ok) {
      console.log('device found: ' + (device.label || device.machine) +
        ' · ' + device.firmwareLabel + ' ' + device.release + ' · serial ' + (device.uid || device.serial) +
        ' · ' + device.dev);
    } else {
      const reason = String(device.error || '').replace(/[\r\n]+/g, ' ').trim();
      console.log('device found: ' + device.dev + ' · identification failed' +
        (reason ? ': ' + reason : ''));
    }
  }
}

// ── On-device operations ────────────────────────────────────────────────────

// The last line of a board traceback, which carries the actual error.
function pyError(err) {
  const lines = cleanReplOutput(err).trim().split(/\r?\n/).filter(l => l.trim());
  return lines.length ? lines[lines.length - 1].trim() : 'Board reported an error';
}

// A JavaScript string as a quoted Python string literal.
const pyStr = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

// A buffer as a Python bytes literal, printable ASCII kept as is.
function pyBytes(buf) {
  let s = "b'";
  for (const b of buf) {
    if (b === 0x5c) s += '\\\\';
    else if (b === 0x27) s += "\\'";
    else if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
    else s += '\\x' + b.toString(16).padStart(2, '0');
  }
  return s + "'";
}

// A board path from user input, or null when it has empty, '.', '..', backslash or
// control-character segments.
function cleanPath(p) {
  if (typeof p !== 'string' || !p) return null;
  const parts = p.replace(/^\/+/, '').split('/').filter(Boolean);
  if (parts.some(s => s === '.' || s === '..' || /[\\\x00-\x1f]/.test(s))) return null;
  const out = parts.join('/');
  return out.length ? out : null;
}

// Match macOS volumes to USB devices by hardware serial number.
function parseDarwinCircuitVolumes(mountOutput, ioregOutput) {
  const diskSerials = new Map();
  let usbSerial = '';
  for (const line of String(ioregOutput).split('\n')) {
    const serial = /"kUSBSerialNumberString"\s*=\s*"([0-9a-f]+)"/i.exec(line);
    if (serial) usbSerial = serial[1].toLowerCase();
    const disk = /"BSD Name"\s*=\s*"(disk\d+)(?:s\d+)?"/.exec(line);
    if (disk && usbSerial) diskSerials.set(disk[1], usbSerial);
  }

  const volumes = new Map();
  for (const line of String(mountOutput).split('\n')) {
    const mounted = /^\/dev\/(disk\d+)(?:s\d+)? on (\/Volumes\/(.+?)) \(/.exec(line);
    if (!mounted || !/^CIRCUITPY(?: |$)/i.test(mounted[3])) continue;
    const serial = diskSerials.get(mounted[1]);
    if (serial) volumes.set(serial, mounted[2]);
  }
  return volumes;
}

// Mounted CIRCUITPY volumes by board UID, cached for up to 3 s; the other
// *Override values are test seams, null in normal use.
let circuitVolumeCache = { expires: 0, volumes: new Map() };
let circuitVolumeOverride = null; // test seam
let circuitVolumePromise = null;
let unmountedCircuitVolumes = new Map();
let bootselDeviceOverride = null;
let bootselInstallOverride = null;
let espInstallOverride = null;

// Folders that may be a CIRCUITPY volume: Windows drives other than C: holding
// boot_out.txt, /Volumes on macOS, /media, /run/media and /mnt on Linux.
function circuitMountCandidates() {
  const found = new Set();
  if (process.platform === 'win32') {
    try {
      const fsutil = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'fsutil.exe') : 'fsutil';
      const out = execFileSync(fsutil, ['fsinfo', 'drives'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      const drives = [...out.matchAll(/([A-Za-z]:\\)/g)].map(m => m[1]);
      for (const drive of drives) {
        if (drive.toUpperCase().startsWith('C:')) continue;
        try {
          if (fs.existsSync(path.join(drive, 'boot_out.txt'))) {
            found.add(drive);
          }
        } catch {}
      }
    } catch {}
    return [...found];
  }
  const bases = process.platform === 'darwin'
    ? ['/Volumes']
    : ['/media', '/run/media', '/mnt'];
  // Adds CIRCUITPY folders in `directory`; Linux mounts often sit one user level deeper.
  function inspect(directory, descend) {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(directory, entry.name);
      if (/^CIRCUITPY(?:[ _-]?\d+)?$/i.test(entry.name)) found.add(full);
      else if (descend) inspect(full, false); // Linux commonly adds a username level.
    }
  }
  for (const base of bases) inspect(base, process.platform !== 'darwin');
  return [...found];
}

// The mount points of one lsblk entry, in either of lsblk's two output formats.
function blockMountpoints(device) {
  return (Array.isArray(device.mountpoints) ? device.mountpoints : [device.mountpoint]).filter(Boolean);
}

// The lsblk device tree as JSON (path, parent, label, filesystem, serial, mount).
async function linuxBlockDevices(run = execFileText) {
  // Newly attached USB disks can exist before udev has populated LABEL/SERIAL.
  // Bound the wait and still scan if udevadm is missing or its queue is busy.
  await run('udevadm', ['settle', '--timeout=2'], { timeout: 2500 }).catch(() => {});
  return run('lsblk', [
    '--json', '--paths', '--tree', '--output', 'PATH,PKNAME,LABEL,FSTYPE,SERIAL,MOUNTPOINT',
  ], { timeout: 3000 });
}

// Unmounted VFAT partitions labelled CIRCUITPY, which may be mounted automatically.
function parseLinuxCircuitPartitions(output) {
  let parsed;
  try { parsed = JSON.parse(String(output)); } catch { return []; }
  const partitions = [];
  function visit(device) {
    const mounts = blockMountpoints(device);
    if (device.label === 'CIRCUITPY' && device.fstype === 'vfat' && device.path && mounts.length === 0) {
      partitions.push(device.path);
    }
    for (const child of device.children || []) visit(child);
  }
  for (const device of parsed.blockdevices || []) visit(device);
  return partitions;
}

// Unmounted CIRCUITPY partitions by board serial, taken from the partition or its disk,
// so the right board can be offered the mount command.
function parseLinuxUnmountedCircuitVolumes(output) {
  let parsed;
  try { parsed = JSON.parse(String(output)); } catch { return new Map(); }
  const volumes = new Map();
  const serials = new Map();
  function collectSerials(device) {
    if (device.path && device.serial) serials.set(device.path, device.serial);
    for (const child of device.children || []) collectSerials(child);
  }
  for (const device of parsed.blockdevices || []) collectSerials(device);
  function visit(device, parent = {}) {
    const mounts = blockMountpoints(device);
    const serial = device.serial || parent.serial || serials.get(device.pkname);
    if (device.label === 'CIRCUITPY' && device.fstype === 'vfat' && device.path && !mounts.length && serial) {
      volumes.set(String(serial).toLowerCase(), device.path);
    }
    for (const child of device.children || []) visit(child, device);
  }
  for (const device of parsed.blockdevices || []) visit(device);
  return volumes;
}

// BOOTSEL drives (RPI-RP2 for RP2040, RP2350) in lsblk output, as device records.
function parseBootselBlockDevices(output) {
  let parsed;
  try { parsed = JSON.parse(String(output)); } catch { return []; }
  const devices = [];
  function visit(device, parent = {}) {
    const volume = String(device.label || '').toUpperCase();
    if ((volume === 'RPI-RP2' || volume === 'RP2350') && device.path) {
      const chip = volume === 'RPI-RP2' ? 'RP2040' : 'RP2350';
      devices.push({
        dev: 'bootsel:' + device.path, ok: true, bootMode: true,
        firmware: 'bootsel', firmwareLabel: 'BOOTSEL', machine: chip, release: '',
        uid: device.serial || parent.serial || '', label: chip, serial: '', readOnly: true,
        blockDevice: device.path,
        mountRoot: blockMountpoints(device)[0] || null,
        capabilities: { read: false, write: false, run: false, console: false },
      });
    }
    for (const child of device.children || []) visit(child, device);
  }
  for (const device of parsed.blockdevices || []) visit(device);
  return devices;
}

// BOOTSEL drives mounted under /Volumes on macOS, from `mount` output.
function parseDarwinBootselVolumes(output) {
  const devices = [];
  for (const line of String(output).split('\n')) {
    const mount = /^\/dev\/disk\d+(?:s\d+)? on (\/Volumes\/(RPI-RP2|RP2350)(?: \d+)?) \(/i.exec(line);
    if (!mount) continue;
    const chip = mount[2].toUpperCase() === 'RPI-RP2' ? 'RP2040' : 'RP2350';
    devices.push({
      dev: 'bootsel:' + mount[1], ok: true, bootMode: true,
      firmware: 'bootsel', firmwareLabel: 'BOOTSEL', machine: chip, release: '', uid: '',
      label: chip, serial: '', readOnly: true, blockDevice: null, mountRoot: mount[1],
      capabilities: { read: false, write: false, run: false, console: false },
    });
  }
  return devices;
}

// The last BOOTSEL discovery error, so it is logged once rather than on every scan.
let bootselDiscoveryError = '';
// BOOTSEL drives on this host: by volume name on Windows, lsblk on Linux, mount on macOS.
async function bootselDevices() {
  if (bootselDeviceOverride) return bootselDeviceOverride;
  if (process.platform === 'win32') {
    try {
      const fsutil = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'fsutil.exe') : 'fsutil';
      // Windows: drives other than C: whose volume name is RPI-RP2 or RP2350.
      const out = await execFileText(fsutil, ['fsinfo', 'drives'], { timeout: 2000 });
      const drives = [...out.matchAll(/([A-Za-z]:\\)/g)].map(m => m[1]);
      const devices = [];
      for (const drive of drives) {
        if (drive.toUpperCase().startsWith('C:')) continue;
        try {
          const info = await execFileText(fsutil, ['fsinfo', 'volumeinfo', drive.slice(0, 2)], { timeout: 2000 });
          const m = /^Volume Name\s*:\s*(RPI-RP2|RP2350)/im.exec(info);
          if (m) {
            const chip = m[1].toUpperCase() === 'RPI-RP2' ? 'RP2040' : 'RP2350';
            devices.push({
              dev: 'bootsel:' + drive, ok: true, bootMode: true,
              firmware: 'bootsel', firmwareLabel: 'BOOTSEL', machine: chip, release: '', uid: '',
              label: chip, serial: '', readOnly: true, blockDevice: drive, mountRoot: drive,
              capabilities: { read: false, write: false, run: false, console: false },
            });
          }
        } catch {}
      }
      return devices;
    } catch { return []; }
  }
  if (process.platform === 'linux') {
    try {
      // Linux: BOOTSEL partitions in lsblk, whether mounted or not.
      const output = await linuxBlockDevices();
      bootselDiscoveryError = '';
      return parseBootselBlockDevices(output);
    } catch (error) {
      const message = 'BOOTSEL discovery failed: ' + String(error.message || error);
      if (message !== bootselDiscoveryError) console.warn(message);
      bootselDiscoveryError = message;
      return [];
    }
  }
  if (process.platform === 'darwin') {
    try {
      // macOS mounts BOOTSEL drives under /Volumes by itself.
      return parseDarwinBootselVolumes(await execFileText('mount', [], { timeout: 2000 }));
    } catch { return []; }
  }
  return [];
}

// The latest official MicroPython UF2 for each Pico model, by firmware id.
const BOOTSEL_FIRMWARE = {
  'pico': {
    chip: 'RP2040', name: 'Raspberry Pi Pico', filename: 'rp2-pico-latest.uf2',
    url: 'https://micropython.org/download/rp2-pico/rp2-pico-latest.uf2',
  },
  'pico-w': {
    chip: 'RP2040', name: 'Raspberry Pi Pico W', filename: 'rp2-pico-w-latest.uf2',
    url: 'https://micropython.org/download/rp2-pico-w/rp2-pico-w-latest.uf2',
  },
  'pico2': {
    chip: 'RP2350', name: 'Raspberry Pi Pico 2', filename: 'RPI_PICO2-latest.uf2',
    url: 'https://micropython.org/download/RPI_PICO2/RPI_PICO2-latest.uf2',
  },
  'pico2-w': {
    chip: 'RP2350', name: 'Raspberry Pi Pico 2 W', filename: 'RPI_PICO2_W-latest.uf2',
    url: 'https://micropython.org/download/RPI_PICO2_W/RPI_PICO2_W-latest.uf2',
  },
};

// The official generic MicroPython build for each ESP32 chip: the ROM chip id it must
// carry, where it is flashed, and the download page listing the latest .bin.
const ESP_FIRMWARE = {
  'ESP32': {
    id: 'esp32', name: 'MicroPython for ESP32', build: 'ESP32_GENERIC', chipId: 0,
    offset: 0x1000,
    page: 'https://micropython.org/download/ESP32_GENERIC/',
  },
  'ESP32-S2': {
    id: 'esp32-s2', name: 'MicroPython for ESP32-S2', build: 'ESP32_GENERIC_S2', chipId: 2,
    offset: 0x1000,
    page: 'https://micropython.org/download/ESP32_GENERIC_S2/',
  },
  'ESP32-C3': {
    id: 'esp32-c3', name: 'MicroPython for ESP32-C3', build: 'ESP32_GENERIC_C3', chipId: 5,
    offset: 0,
    page: 'https://micropython.org/download/ESP32_GENERIC_C3/',
  },
  'ESP32-S3': {
    id: 'esp32-s3', name: 'MicroPython for ESP32-S3', build: 'ESP32_GENERIC_S3', chipId: 9,
    offset: 0,
    page: 'https://micropython.org/download/ESP32_GENERIC_S3/',
  },
};

// A copy of the firmware entry for a chip, or null when it is not supported.
function espFirmwareForChip(chip) {
  const firmware = ESP_FIRMWARE[chip];
  return firmware ? { ...firmware } : null;
}

// The newest .bin link for this build on the micropython.org download page.
function resolveEspFirmwareUrl(firmware, pageHtml) {
  const links = [...String(pageHtml).matchAll(/href=["']([^"']+\.bin)["']/gi)]
    .map(match => new URL(match[1], firmware.page))
    .filter(url => url.hostname === 'micropython.org' &&
      path.posix.basename(url.pathname).startsWith(firmware.build + '-') &&
      !url.pathname.endsWith('.app-bin'));
  if (!links.length) throw new Error('Could not find the latest MicroPython .bin download');
  return links[0].href;
}

// Downloads the download page, then the newest image it links to.
async function downloadEspFirmware(firmware, download = downloadFirmware) {
  const page = await download(firmware.page);
  const url = resolveEspFirmwareUrl(firmware, page.toString('utf8'));
  return download(url);
}

// Validates an ESP firmware image before anything is written: magic byte, segment
// count, chip id, segment bounds, XOR checksum and the optional SHA-256. Returns its
// flash size and segment count.
function espImageInfo(image, expectedChipId) {
  if (!Buffer.isBuffer(image) || image.length < 48 || image.length > 8 * 1024 * 1024) {
    throw new Error('Downloaded ESP firmware has an invalid size');
  }
  // Image header: magic 0xE9, segment count, flash size; the chip id sits at byte 12.
  if (image[0] !== 0xe9) throw new Error('Downloaded file is not an ESP firmware image');
  const segmentCount = image[1];
  if (!segmentCount || segmentCount > 16) throw new Error('ESP firmware has an invalid segment count');
  const chipId = image.readUInt16LE(12);
  if (chipId !== expectedChipId) {
    throw new Error('Downloaded firmware is for a different ESP32 chip');
  }
  let checksum = 0xef;
  // Walk the segments, XOR-ing their data into the checksum stored after the last one.
  let cursor = 24;
  for (let segment = 0; segment < segmentCount; segment++) {
    if (cursor + 8 > image.length) throw new Error('ESP firmware segment header is truncated');
    const length = image.readUInt32LE(cursor + 4);
    cursor += 8;
    if (length > 8 * 1024 * 1024 || cursor + length > image.length) {
      throw new Error('ESP firmware segment is truncated');
    }
    for (let i = cursor; i < cursor + length; i++) checksum ^= image[i];
    cursor += length;
  }
  const checksumOffset = Math.ceil((cursor + 1) / 16) * 16 - 1;
  if (checksumOffset >= image.length || image[checksumOffset] !== checksum) {
    throw new Error('ESP firmware checksum is invalid');
  }
  // Byte 23 says a SHA-256 of the whole image follows the checksum.
  const hasSha256 = image[23] === 1;
  if (hasSha256) {
    const digestOffset = checksumOffset + 1;
    if (digestOffset + 32 > image.length ||
        !crypto.createHash('sha256').update(image.subarray(0, digestOffset)).digest()
          .equals(image.subarray(digestOffset, digestOffset + 32))) {
      throw new Error('ESP firmware SHA-256 digest is invalid');
    }
  }
  // The high nibble of byte 3 encodes the flash size the image was built for.
  const flashSizeCode = image[3] >> 4;
  const flashSize = ({ 0: 1, 1: 2, 2: 4, 3: 8, 4: 16, 5: 32, 6: 64, 7: 128 })[flashSizeCode];
  return { chipId, segmentCount, flashSize: flashSize ? flashSize * 1024 * 1024 : null, hasSha256 };
}

// 32-bit little-endian words, the ROM's argument format.
function espWords(...values) {
  const data = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => data.writeUInt32LE(value >>> 0, index * 4));
  return data;
}

// The ROM's XOR checksum of a data block.
function espChecksum(data) {
  let checksum = 0xef;
  for (const byte of data) checksum ^= byte;
  return checksum;
}

// One FLASH_DATA payload: length and sequence number, then the data.
function espInstallBlock(data, sequence) {
  return Buffer.concat([espWords(data.length, sequence, 0, 0), data]);
}

// Where the board's filesystem lives: the partition labelled "vfs", else the flash
// after the last partition in the image's table. Null when no table is found.
function espStorageRange(image, firmware, flashSize) {
  // The partition table sits at flash address 0x8000, inside the image.
  const tableOffset = 0x8000 - firmware.offset;
  if (tableOffset < 0 || tableOffset + 32 > image.length) return null;
  let partitionEnd = 0;
  let entries = 0;
  for (let offset = tableOffset; offset + 32 <= image.length && offset < tableOffset + 0x1000; offset += 32) {
    if (image.readUInt16LE(offset) !== 0x50aa) break;
    const start = image.readUInt32LE(offset + 4);
    const size = image.readUInt32LE(offset + 8);
    if (!size || start % 0x1000 || size % 0x1000 || start + size > flashSize) return null;
    entries++;
    partitionEnd = Math.max(partitionEnd, start + size);
    const label = image.subarray(offset + 12, offset + 28).toString('ascii')
      .replace(/\0.*$/, '').trim().toLowerCase();
    if (label === 'vfs') return { offset: start, size };
  }
  // Current official MicroPython images use the unpartitioned flash tail as VFS.
  const start = Math.ceil(partitionEnd / 0x1000) * 0x1000;
  return entries && start < flashSize ? { offset: start, size: flashSize - start } : null;
}

// Erases the filesystem region by writing 0xFF through the ROM's compressed-flash
// commands, then checks it with SPI_FLASH_MD5.
async function initializeEspFlashStorage(port, device, firmware, image, flashSize, onProgress) {
  const storage = espStorageRange(image, firmware, flashSize);
  if (!storage) throw new Error('Could not locate the ESP32 filesystem region in this firmware image');
  onProgress({ stage: 'initializing', percent: 0 });
  const blockSize = 0x400;
  // Erased flash reads 0xFF; compressing it keeps the transfer tiny.
  const blank = Buffer.alloc(storage.size, 0xff);
  const compressed = zlib.deflateSync(blank, { level: 9 });
  const blocks = Math.ceil(compressed.length / blockSize);
  const begin = espWords(storage.size, blocks, blockSize, storage.offset);
  const beginData = device.machine === 'ESP32' ? begin : Buffer.concat([begin, espWords(0)]);
  await espRomCommand(port, 0x10, beginData,
    Math.max(10000, Math.ceil(storage.size / 1000000) * 40000));
  for (let sequence = 0; sequence < blocks; sequence++) {
    const start = sequence * blockSize;
    const block = compressed.subarray(start, Math.min(start + blockSize, compressed.length));
    // A tiny compressed block can expand to megabytes of erased data. Budget
    // for flash work, not wire size; send the exact compressed stream length.
    await espRomCommand(port, 0x11, espInstallBlock(block, sequence),
      Math.max(10000, Math.ceil(storage.size / 1000000) * 40000), espChecksum(block));
    onProgress({ stage: 'initializing', percent: Math.round((sequence + 1) / blocks * 90) });
  }
  // FLASH_DEFL_END exits some ROM loaders even with the stay-in-loader flag.
  // Keep the ROM session alive for MD5 verification and the final hard reset.
  const md5Reply = await espRomCommand(port, 0x13,
    espWords(storage.offset, storage.size, 0, 0),
    Math.max(10000, Math.ceil(storage.size / 1000000) * 10000));
  const remoteMd5 = md5Reply.data.toString('ascii').replace(/\0/g, '').trim().toLowerCase();
  const blankMd5 = crypto.createHash('md5').update(blank).digest('hex');
  if (remoteMd5 !== blankMd5) throw new Error('ESP32 storage initialization verification failed');
  onProgress({ stage: 'initializing', percent: 100 });
  return storage;
}

// The firmware for a download-mode chip, or an error when the chip is unsupported or
// its flash security is enabled or unknown.
function assertEspInstallAllowed(device) {
  const firmware = espFirmwareForChip(device && device.machine);
  if (!device || device.bootloader !== 'esp-rom' || !firmware) {
    throw new Error('This ESP download-mode chip is not supported for installation');
  }
  const security = device.bootDetails || {};
  if (security.securityChecked !== true) {
    throw new Error('Installation is disabled because this ESP32 security state could not be verified');
  }
  if (security.secureDownload || security.secureBoot || security.flashEncryption) {
    throw new Error('Installation is disabled because this ESP32 has flash security enabled');
  }
  return firmware;
}

// Writes a validated image through the ROM: re-checks the chip is the one selected,
// writes 1 KB blocks (each retried once), verifies the flash with MD5, optionally
// erases the filesystem, then reboots into MicroPython.
async function flashEspImage(port, device, firmware, image, onProgress = () => {}, options = {}) {
  const imageInfo = espImageInfo(image, firmware.chipId);
  const detected = await detectEspBootloader(port);
  if (!detected) throw new Error('ESP32 is not responding in download mode. Enter download mode and Scan before retrying.');
  if (detected.machine !== device.machine ||
      (device.uid && detected.uid && detected.uid !== device.uid)) {
    throw new Error('The board on this serial port no longer matches the selected ESP32');
  }
  assertEspInstallAllowed(detected);
  const blockSize = 0x400;
  const blocks = Math.ceil(image.length / blockSize);
  const flashSize = Math.max(imageInfo.flashSize || 4 * 1024 * 1024,
    Math.ceil((firmware.offset + image.length) / 0x100000) * 0x100000);
  onProgress({ stage: 'preparing', percent: 0 });
  // SPI_ATTACH and SPI_SET_PARAMS tell the ROM which flash chip and size to use.
  await espRomCommand(port, 0x0d, espWords(0, 0), 3000);
  await espRomCommand(port, 0x0b, espWords(0, flashSize, 0x10000, 0x1000, 0x100, 0xffff), 3000);
  let storage = null;
  if (options.initializeStorage && !espStorageRange(image, firmware, flashSize)) {
    throw new Error('Could not locate the ESP32 filesystem region in this firmware image');
  }
  // FLASH_BEGIN erases the target area; every chip but the classic ESP32 takes one extra word.
  const begin = espWords(image.length, blocks, blockSize, firmware.offset);
  const beginData = device.machine === 'ESP32' ? begin : Buffer.concat([begin, espWords(0)]);
  // FLASH_BEGIN can take a while on a large image while the chip erases.
  await espRomCommand(port, 0x02, beginData,
    Math.max(10000, Math.ceil(image.length / 1000000) * 40000));

  onProgress({ stage: 'writing', percent: 0 });
  for (let sequence = 0; sequence < blocks; sequence++) {
    const start = sequence * blockSize;
    const source = image.subarray(start, Math.min(start + blockSize, image.length));
    const block = source.length === blockSize ? source :
      Buffer.concat([source, Buffer.alloc(blockSize - source.length, 0xff)]);
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await espRomCommand(port, 0x03, espInstallBlock(block, sequence), 5000, espChecksum(block));
        lastError = null;
        break;
      } catch (error) { lastError = error; }
    }
    if (lastError) {
      const address = '0x' + (firmware.offset + start).toString(16).padStart(8, '0');
      throw new Error(String(lastError.message || lastError) +
        ', firmware block ' + (sequence + 1) + '/' + blocks +
        ', flash address ' + address + ', after 2 attempts', { cause: lastError });
    }
    onProgress({ stage: 'writing', percent: Math.round(((sequence + 1) / blocks) * 100) });
  }

  // SPI_FLASH_MD5 of the written area must match the image.
  onProgress({ stage: 'verifying', percent: 100 });
  const md5Reply = await espRomCommand(port, 0x13,
    espWords(firmware.offset, image.length, 0, 0),
    Math.max(10000, Math.ceil(image.length / 1000000) * 10000));
  const remoteMd5 = md5Reply.data.toString('ascii').replace(/\0/g, '').trim().toLowerCase();
  const localMd5 = crypto.createHash('md5').update(image).digest('hex');
  if (remoteMd5 !== localMd5) throw new Error('Firmware verification failed: flashed data does not match the download');

  if (options.initializeStorage) {
    storage = await initializeEspFlashStorage(port, device, firmware, image, flashSize, onProgress);
  }

  onProgress({ stage: 'rebooting', percent: 100 });
  const rebooted = await rebootEspAfterInstall(port, device, options.resetLines);
  return { imageInfo, md5: localMd5, rebooted, storage };
}

// Restarts the chip after an install, preferring a DTR/RTS hard reset over the ROM's
// run command, and pauses probing while MicroPython starts.
async function rebootEspAfterInstall(port, device, resetLines = resetEspLines) {
  // Native USB boards need their own reset sequence.
  const nativeUsb = espResetStrategies(device, port.dev)[0] === 'usb-jtag';
  let rebooted = false;
  if (process.platform === 'win32' && port.winPort && resetLines === resetEspLines) {
    try {
      await winResetEspLines(port, nativeUsb ? 'usb-normal' : 'normal');
      rebooted = true;
    } catch {}
  } else if (port.fd !== null || (process.platform === 'win32' && resetLines !== resetEspLines)) {
    try {
      // A hard reset restarts peripherals; a ROM jump into the application does not.
      await resetLines(port.fd || port.winPort, nativeUsb ? 'usb-normal' : 'normal');
      rebooted = true;
    } catch { /* Optional control-line support: fall back to the ROM command. */ }
  }
  if (!rebooted) {
    try {
      await espRomCommand(port, 0x04, espWords(0), 1200);
      rebooted = true;
    } catch (error) {
      const message = String(error.message || error);
      if (!/command 0x04 \(error 0x06\)|disconnected|timed out|No matching|ESP ROM did not respond/i.test(message)) throw error;
    }
  }
  // Preserve the serial session and defer probing through startup on both
  // native USB and external bridges; reopening can toggle their reset lines.
  port.rebootingUntil = Date.now() + 2000;
  port.info = null;
  port.probeFailure = null;
  return rebooted;
}

// The ESP32 install job: one per port, download and validate, then flash.
async function installEspFirmware(dev, download = downloadFirmware, onProgress = () => {}, options = {}) {
  if (!dev || !listDevs().includes(dev)) throw new Error('ESP32 is no longer connected');
  if (espInstalls.has(dev)) throw new Error('An ESP32 installation is already running on this port');
  // Marks the port busy so a Scan does not interrupt the install.
  espInstalls.add(dev);
  try {
    const port = getPort(dev);
    const device = port.info || await probe(dev);
    const firmware = assertEspInstallAllowed(device);
    onProgress({ stage: 'downloading', percent: 0 });
    // Download and validate before the board is touched.
    const image = await downloadEspFirmware(firmware, download);
    espImageInfo(image, firmware.chipId);
    onProgress({ stage: 'validating', percent: 0 });
    const flashed = await port.command(
      activePort => flashEspImage(activePort, device, firmware, image, onProgress, options),
      { rawRepl: false },
    );
    return {
      ok: true, firmware: firmware.name, build: firmware.build,
      bytes: image.length, address: firmware.offset, md5: flashed.md5,
      rebooted: flashed.rebooted, storageInitialized: !!flashed.storage,
    };
  } finally { espInstalls.delete(dev); }
}

// The Pico models a BOOTSEL chip can take (the W variant cannot be detected).
function bootselFirmwareOptions(chip) {
  return Object.entries(BOOTSEL_FIRMWARE)
    .filter(([, firmware]) => firmware.chip === chip)
    .map(([id, firmware]) => ({ id, name: firmware.name }));
}

// Downloads firmware over HTTPS from micropython.org only, following at most three
// redirects, up to 8 MB and 30 s.
function downloadFirmware(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    // Only HTTPS from micropython.org, including after a redirect.
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'micropython.org') {
      reject(new Error('Firmware download host is not allowed'));
      return;
    }
    const request = https.get(parsed, { headers: { 'User-Agent': 'pico-bay/' + VERSION } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects > 0) {
        response.resume();
        downloadFirmware(new URL(response.headers.location, parsed).href, redirects - 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error('Firmware download failed with HTTP ' + response.statusCode));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        // A firmware image never exceeds 8 MB.
        if (size > 8 * 1024 * 1024) {
          request.destroy(new Error('Firmware download is too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.setTimeout(30000, () => request.destroy(new Error('Firmware download timed out')));
    request.on('error', reject);
  });
}

// The mount point of a BOOTSEL drive, mounting it with udisksctl on Linux when needed.
async function mountedBootselRoot(device) {
  if (device.mountRoot) return device.mountRoot;
  if (process.platform !== 'linux' || !device.blockDevice) return null;
  try {
    await execFileText('udisksctl', [
      'mount', '--block-device', device.blockDevice, '--no-user-interaction',
    ], { timeout: 5000 });
  } catch (error) {
    if (/NotAuthorized/i.test(String(error.message || error))) {
      throw new Error('Raspberry Pi OS requires permission to mount this BOOTSEL volume. Run "udisksctl mount --block-device ' +
        device.blockDevice + '" on the Pi, then try again.');
    }
    throw error;
  }
  await sleep(200);
  const refreshed = (await bootselDevices()).find(item => item.dev === device.dev);
  return refreshed && refreshed.mountRoot;
}

// Validates a UF2 image for the chip before it is copied: block magic numbers, flash
// address range, family id, complete and non-overlapping blocks (the RP2350 prefix
// block is allowed).
function validateUf2Image(image, chip) {
  // UF2 family ids the chip accepts (RP2350: ARM secure, RISC-V, ARM non-secure).
  const families = chip === 'RP2040' ? [0xe48bff56] :
    chip === 'RP2350' ? [0xe48bff59, 0xe48bff5a, 0xe48bff5b] : [];
  const invalid = reason => { throw new Error('Invalid UF2 image: ' + reason); };
  if (!families.length) invalid('unsupported chip');
  if (!Buffer.isBuffer(image) || !image.length || image.length > 8 * 1024 * 1024 || image.length % 512) {
    invalid('size must be a nonzero multiple of 512 bytes, up to 8 MB');
  }
  // Blocks are grouped by family to check each is complete and non-overlapping.
  const groups = new Map();
  let absoluteBlock = false;
  for (let offset = 0; offset < image.length; offset += 512) {
    const block = image.subarray(offset, offset + 512);
    if (block.readUInt32LE(0) !== 0x0a324655 || block.readUInt32LE(4) !== 0x9e5d5157 ||
        block.readUInt32LE(508) !== 0x0ab16f30) invalid('bad block magic at byte ' + offset);
    const flags = block.readUInt32LE(8), address = block.readUInt32LE(12);
    const size = block.readUInt32LE(16), number = block.readUInt32LE(20);
    const count = block.readUInt32LE(24), family = block.readUInt32LE(28);
    if (!size || size > 476 || size % 4 || address % 4 ||
        address < 0x10000000 || address + size > 0x11000000) invalid('invalid flash payload');
    // RP2350-E10 prefix: one absolute block deliberately declares two blocks.
    // https://github.com/raspberrypi/picotool/blob/master/elf2uf2/elf2uf2.cpp
    if (chip === 'RP2350' && family === 0xe48bff57) {
      if (absoluteBlock || offset !== 0 || ![0x2000, 0xa000].includes(flags) ||
          size !== 256 || number !== 0 || count !== 2 || address % 256 ||
          !block.subarray(32, 288).every(byte => byte === 0xef) ||
          (flags === 0xa000 && block.readUInt32LE(288) !== 0x9957e304)) invalid('invalid RP2350 prefix');
      absoluteBlock = true;
      continue;
    }
    if (flags !== 0x2000) invalid('unsupported flags or missing family ID');
    if (!families.includes(family)) invalid('firmware family does not match ' + chip);
    if (!count || count > image.length / 512 || number >= count) invalid('invalid block count or number');
    let group = groups.get(family);
    if (!group) { group = { count, numbers: new Set(), ranges: [] }; groups.set(family, group); }
    if (group.count !== count || group.numbers.has(number)) invalid('inconsistent or duplicate blocks');
    group.numbers.add(number);
    group.ranges.push([address, address + size]);
  }
  if (!groups.size) invalid('no firmware blocks');
  for (const group of groups.values()) {
    if (group.numbers.size !== group.count) invalid('missing firmware blocks');
    group.ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < group.ranges.length; i++) {
      if (group.ranges[i][0] < group.ranges[i - 1][1]) invalid('overlapping flash payloads');
    }
  }
}

// Installs MicroPython on a BOOTSEL drive: checks the model matches the chip, mounts
// the drive if needed, downloads and validates the UF2, then copies it (the board
// reboots by itself once the copy completes).
async function installBootselFirmware(dev, firmwareId, download = downloadFirmware, onProgress = () => {}) {
  const firmware = BOOTSEL_FIRMWARE[firmwareId];
  if (!firmware) throw new Error('Unknown firmware selection');
  const device = (await bootselDevices()).find(item => item.dev === dev);
  if (!device) throw new Error('BOOTSEL device is no longer connected');
  if (device.machine !== firmware.chip) throw new Error('Firmware does not match this BOOTSEL device');
  const root = await mountedBootselRoot(device);
  if (!root) throw new Error('Could not mount the BOOTSEL volume');
  fs.accessSync(root, fs.constants.W_OK);
  onProgress({ stage: 'downloading', percent: 0 });
  const image = await download(firmware.url);
  onProgress({ stage: 'validating', percent: 0 });
  validateUf2Image(image, firmware.chip);
  onProgress({ stage: 'writing', percent: 0 });
  // Copying the UF2 is the whole install: the board flashes it and reboots.
  await fs.promises.writeFile(path.join(root, firmware.filename), image);
  onProgress({ stage: 'rebooting', percent: 100 });
  return { ok: true, firmware: firmware.name, bytes: image.length };
}

// On a Pi, mounts unmounted CIRCUITPY partitions with udisksctl and remembers the ones
// that need permission, for the UI to show the mount command.
async function autoMountCircuitPartitions() {
  if (!RASPBERRY_PI_HOST) return;
  unmountedCircuitVolumes = new Map();
  let output;
  try {
    output = await linuxBlockDevices();
  } catch { return; }
  unmountedCircuitVolumes = parseLinuxUnmountedCircuitVolumes(output);
  await Promise.all(parseLinuxCircuitPartitions(output).map(device =>
    execFileText('udisksctl', ['mount', '--block-device', device, '--no-user-interaction'], {
      timeout: 5000,
    }).catch(() => '')
  ));
}

// Matches volumes to boards by the UID line in each volume's boot_out.txt.
function bootOutCircuitVolumes(roots = circuitMountCandidates()) {
  const volumes = new Map();
  for (const root of roots) {
    try {
      const text = fs.readFileSync(path.join(root, 'boot_out.txt'), 'utf8');
      const uid = /^UID:\s*([0-9a-f]+)\s*$/im.exec(text);
      if (uid) volumes.set(uid[1].toLowerCase(), root);
    } catch { /* use the OS fallback */ }
  }
  return volumes;
}

// CIRCUITPY volumes by board UID: boot_out.txt first, then on macOS the USB serial
// numbers from ioreg for volumes it did not cover. One lookup runs at a time.
async function circuitVolumes() {
  if (circuitVolumeOverride) return circuitVolumeOverride;
  if (Date.now() < circuitVolumeCache.expires) return circuitVolumeCache.volumes;
  if (!circuitVolumePromise) circuitVolumePromise = (async () => {
    await autoMountCircuitPartitions();
    const roots = circuitMountCandidates();
    // boot_out.txt covers every volume on Linux and Windows; macOS may need ioreg too.
    const bootVolumes = bootOutCircuitVolumes(roots);
    if (bootVolumes.size === roots.length || process.platform !== 'darwin') {
      circuitVolumeCache = { expires: Date.now() + 3000, volumes: bootVolumes };
      return bootVolumes;
    }
    try {
      const [mountOutput, ioregOutput] = await Promise.all([
        execFileText('mount', []),
        execFileText('ioreg', ['-p', 'IOService', '-w', '0', '-l']),
      ]);
      const registryVolumes = parseDarwinCircuitVolumes(mountOutput, ioregOutput);
      for (const [uid, root] of registryVolumes) bootVolumes.set(uid, root);
      circuitVolumeCache = { expires: Date.now() + 3000, volumes: bootVolumes };
    } catch {
      circuitVolumeCache = { expires: Date.now() + 1000, volumes: bootVolumes };
    }
    return circuitVolumeCache.volumes;
  })().finally(() => { circuitVolumePromise = null; });
  return circuitVolumePromise;
}

// The mounted volume of a CircuitPython board, if it is still a directory.
async function circuitRootForInfo(info) {
  if (info.firmware !== 'circuitpython' || !info.uid) return null;
  const root = (await circuitVolumes()).get(info.uid.toLowerCase());
  if (!root) return null;
  try { return fs.statSync(root).isDirectory() ? root : null; }
  catch { return null; }
}

// The mounted volume of the board on `dev`, or null.
async function mountedCircuitRoot(dev) {
  return circuitRootForInfo(await probe(dev));
}

// True when this host may write to the mounted volume.
function mountedRootWritable(root) {
  try {
    fs.accessSync(root, fs.constants.W_OK);
    return true;
  } catch { return false; }
}

// A board path as a host path inside the mounted volume, or null when it would escape
// the volume (or, on Windows, use drive or stream syntax).
function mountedPath(root, devicePath, pathApi = path) {
  const clean = cleanPath(devicePath);
  if (!clean) return null;
  // Windows normalizes trailing dots/spaces and interprets colons as drive/stream syntax.
  // Windows trims trailing dots and spaces and reads colons as drive or stream syntax.
  if (pathApi.sep === '\\' && clean.split('/').some(part => /:|[. ]$/.test(part))) return null;
  // The result must stay strictly inside the volume.
  const resolvedRoot = pathApi.resolve(root);
  const target = pathApi.resolve(root, ...clean.split('/'));
  const prefix = resolvedRoot.endsWith(pathApi.sep) ? resolvedRoot : resolvedRoot + pathApi.sep;
  return target !== resolvedRoot && target.startsWith(prefix) ? target : null;
}

// Lists a mounted volume like listFiles does over serial: up to 8 levels deep, dot
// files hidden unless asked for, symbolic links skipped.
function listMountedFiles(root, includeSystemFiles = false) {
  const files = [];
  function walk(relative, depth) {
    const directory = relative ? mountedPath(root, relative) : root;
    if (!directory) return;
    let names;
    try { names = fs.readdirSync(directory).sort(); } catch { return; }
    for (const name of names) {
      // Hidden (dot) files are skipped unless asked for.
      if (!includeSystemFiles && name.startsWith('.')) continue;
      const child = relative ? relative + '/' + name : name;
      const absolute = mountedPath(root, child);
      if (!absolute) continue;
      let stat;
      try { stat = fs.lstatSync(absolute); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      const isDir = stat.isDirectory();
      files.push({
        path: child, name, dir: relative, isDir,
        size: isDir ? 0 : stat.size,
        mtime: Math.floor(stat.mtimeMs / 1000),
      });
      if (isDir && depth < 8) walk(child, depth + 1);
    }
  }
  walk('', 0);
  return files;
}

// Board-side code that walks the filesystem and prints one "PVF isdir size mtime path"
// line per entry.
function listCode(includeSystemFiles) {
  // Dot files are filtered on the board unless asked for.
  const hideSystemLine = includeSystemFiles ? '' : "        if n.startswith('.'):\n            continue\n";
  return `
import os
def _w(p, d):
    root = ('/' + p) if p else '/'
    try:
        es = os.listdir(root)
    except OSError:
        return
    for n in sorted(es):
${hideSystemLine}        f = (p + '/' + n) if p else n
        absolute = '/' + f
        try:
            st = os.stat(absolute)
        except OSError:
            continue
        isd = 1 if st[0] & 0x4000 else 0
        print('PVF', isd, st[6], st[8], f)
        if isd and d < 8:
            _w(f, d + 1)
_w('', 0)
`.trim();
}

// Every file and folder on the board, from the mounted volume when there is one.
async function listFiles(dev, includeSystemFiles = false) {
  const root = await mountedCircuitRoot(dev);
  if (root) {
    try { return listMountedFiles(root, includeSystemFiles); }
    catch { circuitVolumeCache.expires = 0; }
  }
  const p = getPort(dev);
  const { out, err } = await p.command(port => port.exec(listCode(includeSystemFiles), { timeout: 20000 }));
  if (err.trim()) throw new Error(pyError(err));
  return parseFileList(out);
}

// Turns PVF lines into file records.
function parseFileList(out) {
  const files = [];
  for (const line of cleanReplOutput(out).split(/\r?\n/)) {
    const m = /PVF ([01]) (\d+) (-?\d+) (.*)$/.exec(line);
    if (!m) continue;
    const full = m[4];
    files.push({
      path: full,
      name: full.split('/').pop(),
      dir: full.includes('/') ? full.slice(0, full.lastIndexOf('/')) : '',
      isDir: m[1] === '1',
      size: m[1] === '1' ? 0 : parseInt(m[2], 10),
      mtime: parseInt(m[3], 10),
    });
  }
  return files;
}

// Flash total/free and RAM free/allocated, after a garbage collection.
async function deviceStats(dev) {
  const p = getPort(dev);
  const { out, err } = await p.command(port => port.exec([
    'import os, gc',
    'gc.collect()',
    // statvfs gives block size and total/free blocks; gc reports RAM.
    "s = os.statvfs('/')",
    "print('PVS', s[0] * s[2], s[0] * s[3], gc.mem_free(), gc.mem_alloc())",
  ].join('\n'), { timeout: 8000 }));
  if (err.trim()) throw new Error(pyError(err));
  const m = /PVS\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(cleanReplOutput(out));
  if (!m) throw new Error('Could not read device storage statistics');
  const [total, free, memFree, memAlloc] = m.slice(1).map(Number);
  return { fsTotal: total, fsFree: free, memFree, memAlloc };
}

// Formats the "vfs" partition of an ESP32 whose filesystem was never created (LittleFS
// v2), mounts it at /, and reports the new size. Refused when storage already exists.
async function initializeEspStorage(dev) {
  const info = await probe(dev);
  if (info.firmware !== 'micropython' || !/ESP32(?:\b|-)/.test((info.machine || '') + ' ' + (info.label || ''))) {
    throw new Error('Storage initialization is available only for ESP32 boards running MicroPython');
  }
  const stats = await deviceStats(dev).catch(() => null);
  if (stats && stats.fsTotal > 0) {
    throw new Error('Board storage is already initialized');
  }
  const port = getPort(dev);
  const code = [
    'import os, esp32',
    // Board-side: find the vfs partition, format it as LittleFS v2, and mount it.
    "_parts = esp32.Partition.find(esp32.Partition.TYPE_DATA, label='vfs')",
    "if not _parts: raise OSError('VFS partition was not found')",
    '_part = _parts[0]',
    'os.VfsLfs2.mkfs(_part)',
    "os.mount(os.VfsLfs2(_part), '/')",
  ].join('\n');
  const { err } = await port.command(active => active.exec(code, { timeout: 10 * 60 * 1000 }));
  if (err.trim()) throw new Error(pyError(err));
  const ready = await deviceStats(dev);
  if (!ready.fsTotal) throw new Error('Board storage initialization did not complete');
  return { ok: true, initialized: true, fsTotal: ready.fsTotal, fsFree: ready.fsFree };
}

// Hex encoding preserves binary data through the text REPL.
async function readFile(dev, file) {
  const root = await mountedCircuitRoot(dev);
  // A mounted volume is read directly; a failure there drops the volume cache and
  // falls back to serial.
  const local = root && mountedPath(root, file);
  if (local) {
    try {
      const stat = fs.lstatSync(local);
      if (stat.isFile() && !stat.isSymbolicLink()) return fs.readFileSync(local);
    } catch { circuitVolumeCache.expires = 0; }
  }
  const p = getPort(dev);
  const code = [
    'import binascii',
    '_f = open(' + pyStr('/' + file) + ", 'rb')",
    'while True:',
    '    _b = _f.read(512)',
    '    if not _b: break',
    // Board-side: print the file as hex in 512-byte lines, joined back together below.
    "    print('PVD' + binascii.hexlify(_b).decode())",
    '_f.close()',
  ].join('\n');
  const { out, err } = await p.command(port => port.exec(code, { timeout: 60000 }));
  if (err.trim()) throw new Error(pyError(err));
  const hex = cleanReplOutput(out).split(/\r?\n/)
    .map(line => /PVD([0-9a-fA-F]*)/.exec(line))
    .filter(Boolean)
    .map(m => m[1])
    .join('');
  return Buffer.from(hex, 'hex');
}

// Writes a file through the mounted volume when possible, else over serial in 1 KB
// chunks, creating missing parent folders first.
async function writeFile(dev, file, buf) {
  const access = await requireWritable(dev);
  if (access.mode === 'mount') {
    const local = mountedPath(access.root, file);
    if (!local) throw new Error('Bad path');
    const parent = path.dirname(local);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(local, buf);
    return { ok: true, size: buf.length };
  }
  const p = getPort(dev);
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  return p.command(async (port) => {
    if (dir) {
      // Board-side: create each missing parent folder in turn.
      const mk = await port.exec([
        'import os',
        'p = ' + pyStr(dir),
        "acc = ''",
        "for part in p.split('/'):",
        "    acc = acc + '/' + part if acc else part",
        '    try:',
        '        os.mkdir(acc)',
        '    except OSError:',
        '        pass',
      ].join('\n'));
      if (mk.err.trim()) throw new Error(pyError(mk.err));
    }
    // Open once, send 1 KB bytes literals to its write method, then close.
    let r = await port.exec('_f = open(' + pyStr(file) + ", 'wb')\n_w = _f.write");
    if (r.err.trim()) throw new Error(pyError(r.err));
    for (let off = 0; off < buf.length; off += 1024) {
      r = await port.exec('_w(' + pyBytes(buf.subarray(off, off + 1024)) + ')', { timeout: 20000 });
      if (r.err.trim()) throw new Error(pyError(r.err));
    }
    r = await port.exec('_f.close()');
    if (r.err.trim()) throw new Error(pyError(r.err));
    return { ok: true, size: buf.length };
  });
}

// Board-side helper that deletes a file, or a folder and everything in it.
const RMTREE = [
  'import os',
  'def _rm(p):',
  '    if os.stat(p)[0] & 0x4000:',
  '        for n in os.listdir(p):',
  "            _rm(p + '/' + n)",
  '        os.rmdir(p)',
  '    else:',
  '        os.remove(p)',
].join('\n');

// Deletes a file, or a folder with everything in it. Symbolic links on a mounted
// volume are refused rather than followed.
async function removePath(dev, file) {
  const access = await requireWritable(dev);
  if (access.mode === 'mount') {
    const local = mountedPath(access.root, file);
    if (!local) throw new Error('Bad path');
    const stat = fs.lstatSync(local);
    if (stat.isSymbolicLink()) throw new Error('Refusing to remove a symbolic link');
    fs.rmSync(local, { recursive: stat.isDirectory(), force: false });
    return { ok: true };
  }
  const p = getPort(dev);
  const { err } = await p.command(port =>
    port.exec(RMTREE + '\n_rm(' + pyStr(file) + ')', { timeout: 30000 }));
  if (err.trim()) throw new Error(pyError(err));
  return { ok: true };
}

// Deletes every file and folder on the board and returns the list removed.
async function cleanAll(dev) {
  const access = await requireWritable(dev);
  if (access.mode === 'mount') {
    const removed = [];
    // Mounted volume: delete each top-level entry, skipping symbolic links.
    for (const name of fs.readdirSync(access.root)) {
      const local = mountedPath(access.root, name);
      if (!local) continue;
      const stat = fs.lstatSync(local);
      if (stat.isSymbolicLink()) continue;
      fs.rmSync(local, { recursive: stat.isDirectory(), force: false });
      removed.push(name);
    }
    return { ok: true, log: removed.map(name => 'removed ' + name).join('\n') };
  }
  const p = getPort(dev);
  const { out, err } = await p.command(port => port.exec(
    RMTREE + '\n' + [
      // Over serial: delete each top-level entry and report it.
      "for n in os.listdir('/'):",
      '    _rm(n)',
      "    print('removed', n)",
    ].join('\n'), { timeout: 60000 }));
  if (err.trim()) throw new Error(pyError(err));
  return { ok: true, log: out.trim() };
}

// Runs a short code snippet, throwing on a board error.
async function simpleOp(dev, code, timeout = 15000) {
  const p = getPort(dev);
  const { out, err } = await p.command(port => port.exec(code, { timeout }));
  if (err.trim()) throw new Error(pyError(err));
  return { ok: true, out };
}

// Which install mode a running board can be sent to: 'download' for an ESP32 on
// MicroPython, 'bootsel' for a Pico, null otherwise.
function bootloaderMode(info) {
  if (!info || info.bootMode || !['micropython', 'circuitpython'].includes(info.firmware)) return null;
  const model = (info.machine || '') + ' ' + (info.label || '');
  if (/ESP32/i.test(model)) return info.firmware === 'micropython' ? 'download' : null;
  return /RP2040|RP2350|Raspberry Pi Pico/i.test(model) ? 'bootsel' : null;
}

// DTR/RTS sequences to try, in order, to reach ESP download mode.
function espResetStrategies(info, dev) {
  const serial = ['tight', 'tight-slow', 'classic', 'classic-slow'];
  // Windows COM names do not distinguish native USB from UART bridges.
  // Try native USB on C3/S3 COM ports, retaining the UART fallbacks.
  const machine = info?.machine || '';
  const mayBeUsbJtag = (!machine || /ESP32-?[CS]3/i.test(machine)) &&
    /(?:usbmodem|ttyACM|^COM\d+$)/i.test(dev);
  return mayBeUsbJtag ? ['usb-jtag', ...serial] : serial;
}

// Sends a board to its install mode. An ESP32 is reset into ROM download mode by
// trying each DTR/RTS sequence until the ROM answers (falling back to manual
// instructions); a Pico runs machine.bootloader() (or CircuitPython's equivalent).
async function enterBootloader(dev, requestedMode = null) {
  let info = null;
  let probeErr = null;
  try {
    info = await probe(dev);
  } catch (err) {
    probeErr = err;
  }
  const mode = requestedMode || bootloaderMode(info);
  const isEspCandidate = mode === 'download' ||
    (!info && /watchdog resets|download bootloader|ESP/i.test(String(probeErr?.message || probeErr)));
  if (!mode && !isEspCandidate) {
    throw (probeErr || new Error('Firmware install mode is unavailable for this board'));
  }
  const effectiveMode = mode || (isEspCandidate ? 'download' : null);
  if (effectiveMode === 'download') {
    info = info || { dev, machine: '', firmware: 'unknown' };
    const port = getPort(dev);
    return port.command(async active => {
      const reset = mode => process.platform === 'win32' && active.winPort ?
        winResetEspLines(active, mode) : resetEspLines(active.fd, mode);
      // Reset invalidates the raw REPL halt state; cleanup must not soft-reset
      // a newly entered ROM loader.
      active.halted = false;
      try {
        // Try each reset sequence until the ROM answers SYNC.
        for (const mode of espResetStrategies(info, dev)) {
          await reset(mode);
          await sleep(100);
          const detected = await detectEspBootloader(active);
          if (detected) {
            if (info.uid && detected.uid && info.uid !== detected.uid) {
              throw new Error('The board identity changed during reset');
            }
            active.info = detected;
            active.probeFailure = null;
            return { ok: true, automatic: true, resetStrategy: mode, board: boardRecord(detected) };
          }
        }
        throw new Error('ESP ROM did not respond after automatic reset');
      } catch (error) {
        // Nothing answered: reset back to normal and let the user enter download mode by hand.
        await reset('normal').catch(() => {});
        active.info = null;
        active.probeFailure = null;
        return { ok: false, manual: true, reason: String(error.message || error) };
      }
    }, { rawRepl: false });
  }
  if (!info) throw (probeErr || new Error('Firmware install mode is unavailable for this board'));
  // A Pico enters BOOTSEL from its own firmware.
  const code = info.firmware === 'circuitpython'
    ? 'import microcontroller\nmicrocontroller.on_next_reset(microcontroller.RunMode.BOOTLOADER)\nmicrocontroller.reset()'
    : 'import machine\nmachine.bootloader()';
  await getPort(dev).command(async active => {
    // Only tolerate loss of the final prompt after entering raw REPL. A
    // failure to enter the REPL must not be reported as a successful reset.
    active.halted = false;
    try {
      const { err } = await active.exec(code, { timeout: 3000 });
      if (err.trim()) throw new Error(pyError(err));
    } catch (error) {
      if (!/timed out waiting for the board|Board disconnected/.test(String(error.message || error))) throw error;
    } finally {
      active.info = null;
      active.probeFailure = null;
    }
  });
  return { ok: true };
}

// Creates a folder and any missing parents; an existing folder is fine.
async function makeDirectory(dev, file) {
  const access = await requireWritable(dev);
  if (access.mode === 'mount') {
    const local = mountedPath(access.root, file);
    if (!local) throw new Error('Bad path');
    fs.mkdirSync(local, { recursive: true });
    return { ok: true };
  }
  const p = getPort(dev);
  return p.command(async (port) => {
    const { err } = await port.exec([
      'import os',
      'p = ' + pyStr(file),
      "acc = ''",
      "for part in p.split('/'):",
      "    acc = acc + '/' + part if acc else part",
      '    try:',
      '        os.mkdir(acc)',
      '    except OSError as e:',
      // Errno 17 (EEXIST) means the folder is already there.
      '        if e.args[0] != 17:',
      '            raise',
    ].join('\n'));
    if (err.trim()) throw new Error(pyError(err));
    return { ok: true };
  });
}

// Renames or moves a file or folder.
async function renamePath(dev, from, to) {
  const access = await requireWritable(dev);
  if (access.mode === 'mount') {
    const source = mountedPath(access.root, from);
    const target = mountedPath(access.root, to);
    if (!source || !target) throw new Error('Bad path');
    fs.renameSync(source, target);
    return { ok: true, out: '' };
  }
  return simpleOp(dev, 'import os\nos.rename(' + pyStr(from) + ', ' + pyStr(to) + ')');
}

// Runs a board file as __main__, or one console line, streaming its output to the
// console. A file that defines read() is called and its result printed as JSON;
// top-level code with a `return` is wrapped in a function so it still runs.
async function runPython(dev, options = {}) {
  const info = await probe(dev);
  // Exactly one of a file path or a code line, and only when the firmware allows it.
  const hasPath = options.path !== undefined;
  const hasCode = options.code !== undefined;
  if (hasPath === hasCode) throw new Error('Provide exactly one of path or code');
  if (hasPath && !info.capabilities.run) throw new Error('Running files is not supported for this firmware');
  if (hasCode && !info.capabilities.console) throw new Error('Console input is not supported for this firmware');

  const port = getPort(dev);
  let code;
  let banner;
  if (hasPath) {
    const file = cleanPath(options.path);
    if (!file) throw new Error('Bad path');
    const pyFilePath = pyStr(file);
    // Board-side: exec the file as __main__, call read() if it defines one, and print any
    // result as JSON (repr when it is not JSON-serializable).
    code = `_g = {'__name__': '__main__'}\n` +
      `_src = open(${pyFilePath}).read()\n` +
      `_res = None\n` +
      `try:\n` +
      `    exec(_src, _g)\n` +
      `    if 'read' in _g and callable(_g['read']):\n` +
      `        _res = _g['read']()\n` +
      `except SyntaxError:\n` +
      `    _wrapped = 'def __run__():\\n' + '\\n'.join('    ' + l for l in _src.splitlines()) + '\\n_res = __run__()'\n` +
      `    exec(_wrapped, _g)\n` +
      `    _res = _g.get('_res')\n` +
      `if _res is not None:\n` +
      `    try:\n` +
      `        import json\n` +
      `        print(json.dumps(_res))\n` +
      `    except Exception:\n` +
      `        print(repr(_res))\n`;
    banner = '>>> run ' + file + '\n';
  } else {
    code = String(options.code);
    banner = '>>> ' + code.split('\n')[0] + '\n';
  }
  if (!code.trim()) throw new Error('Nothing to run');

  // Echo what runs to the console, then stream its output there as it arrives.
  port._emit('sys', banner);
  const result = await port.command(async (pt) => {
    let carried = '';
    return pt.exec(code, {
      timeout: 10 * 60 * 1000,
      onChunk: (chunk) => { carried += chunk; port._emit('out', chunk); },
    }).then(r => { r.streamed = carried; return r; });
  });
  // Print whatever arrived after the last streamed chunk.
  if (result.out && result.out.length > (result.streamed ? result.streamed.length : 0)) {
    port._emit('out', result.out.slice(result.streamed ? result.streamed.length : 0));
  }
  if (result.err.trim()) port._emit('err', result.err);
  port._emit('sys', '[finished]\n');
  return { ok: !result.err.trim(), out: result.out, err: result.err };
}

// Sends Ctrl-C twice to stop a running program.
async function interruptBoard(dev) {
  const port = getPort(dev);
  if (port.fd !== null || port.winPort) await port.write('\r' + CTRL_C + CTRL_C);
  port._emit('sys', '[interrupt sent]\n');
  return { ok: true };
}

// A soft reset restarts main.py through the raw REPL; a hard reset runs the firmware's
// reset call and forgets the port, since the board drops off USB.
async function resetBoard(dev, hard = false) {
  const port = getPort(dev);
  if (hard) {
    const info = await probe(dev);
    // The board drops off USB during a hard reset, so the port is forgotten afterwards.
    const adapter = firmwareAdapter(info.firmware);
    if (!adapter.hardResetCode) throw new Error('Hard reset is not supported for this firmware');
    port.command(pt => pt.exec(adapter.hardResetCode, { timeout: 1500 })).catch(() => {});
    setTimeout(() => { port._close(); ports.delete(dev); }, 500);
    port._emit('sys', '[hard reset]\n');
    return { ok: true, hard: true };
  }
  // A soft reset is an empty command followed by an immediate release.
  await port.command(async () => {});
  await port.releaseNow();
  port._emit('sys', '[soft reset, program restarted]\n');
  return { ok: true };
}

// ── Console subscribers (Server-Sent Events) ────────────────────────────────
async function attachConsole(dev, res) {
  const p = getPort(dev);
  // Each console line goes to the browser as one Server-Sent Event.
  const send = (type, text) => {
    try { res.write('data: ' + JSON.stringify({ type, text }) + '\n\n'); } catch { /* gone */ }
  };
  // Subscribe first, so nothing printed in between is lost.
  await p.addMonitor(send);
  if (res.destroyed) { p.removeMonitor(send); return; }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
  });
  // The browser reconnects 2 s after a drop; a comment line every 15 s keeps it open.
  res.write('retry: 2000\n\n');
  send('sys', '[attached to ' + dev + ']\n');
  const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* gone */ } }, 15000);
  // Stop the keep-alive and unsubscribe when the browser goes away.
  const done = () => { clearInterval(ka); p.removeMonitor(send); };
  res.on('close', done);
  res.on('error', done);
}

// ── ZIP creation (uncompressed Store ZIP format) ─────────────────────────
// The CRC-32 a ZIP entry carries.
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Builds an uncompressed (Store) ZIP from { path, content, mtime } entries: a local
// header and data per file, then the central directory and its end record.
function createZipBuffer(entries) {
  const parts = [];
  const centralRecords = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.path, 'utf8');
    const dataBuf = entry.content || Buffer.alloc(0);
    const crc = crc32(dataBuf);
    const size = dataBuf.length;

    // DOS ZIP timestamps cannot represent dates before 1980.
    let dt = entry.mtime ? new Date(entry.mtime * 1000) : new Date();
    if (!Number.isFinite(dt.getTime()) || dt.getFullYear() < 1980) dt = new Date();
    const dosTime = ((dt.getHours() & 0x1f) << 11) | ((dt.getMinutes() & 0x3f) << 5) | ((dt.getSeconds() >> 1) & 0x1f);
    const dosDate = (((dt.getFullYear() - 1980) & 0x7f) << 9) | (((dt.getMonth() + 1) & 0x0f) << 5) | (dt.getDate() & 0x1f);

    // Local file header.
    const lhdr = Buffer.alloc(30);
    lhdr.writeUInt32LE(0x04034b50, 0);
    lhdr.writeUInt16LE(20, 4);
    lhdr.writeUInt16LE(0, 6);
    lhdr.writeUInt16LE(0, 8);
    lhdr.writeUInt16LE(dosTime, 10);
    lhdr.writeUInt16LE(dosDate, 12);
    lhdr.writeUInt32LE(crc, 14);
    lhdr.writeUInt32LE(size, 18);
    lhdr.writeUInt32LE(size, 22);
    lhdr.writeUInt16LE(nameBuf.length, 26);
    lhdr.writeUInt16LE(0, 28);

    parts.push(lhdr, nameBuf, dataBuf);

    // Central directory record pointing back at the local header.
    const chdr = Buffer.alloc(46);
    chdr.writeUInt32LE(0x02014b50, 0);
    chdr.writeUInt16LE(20, 4);
    chdr.writeUInt16LE(20, 6);
    chdr.writeUInt16LE(0, 8);
    chdr.writeUInt16LE(0, 10);
    chdr.writeUInt16LE(dosTime, 12);
    chdr.writeUInt16LE(dosDate, 14);
    chdr.writeUInt32LE(crc, 16);
    chdr.writeUInt32LE(size, 20);
    chdr.writeUInt32LE(size, 24);
    chdr.writeUInt16LE(nameBuf.length, 28);
    chdr.writeUInt16LE(0, 30);
    chdr.writeUInt16LE(0, 32);
    chdr.writeUInt16LE(0, 34);
    chdr.writeUInt16LE(0, 36);
    // External attributes: a regular file with 0644 permissions.
    chdr.writeUInt32LE(0x81a40000, 38);
    // Where this entry's local header starts.
    chdr.writeUInt32LE(offset, 42);

    centralRecords.push(chdr, nameBuf);

    offset += 30 + nameBuf.length + size;
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const buf of centralRecords) {
    centralSize += buf.length;
    parts.push(buf);
  }

  // End of central directory: entry count, size and offset of the directory.
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  parts.push(eocd);

  return Buffer.concat(parts);
}

// Parse Store and Deflate ZIP entries with strict safety limits.
function parseRestoreZip(buf) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 65557);
  // The end record sits in the last 64 KB (after a comment of up to 65535 bytes).
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Invalid ZIP: end record not found');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  if (count > 512) throw new Error('ZIP contains too many files (maximum 512)');
  const entries = [];
  const names = new Set();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) {
      throw new Error('Invalid ZIP central directory');
    }
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const expectedCrc = buf.readUInt32LE(at + 16);
    const compressedSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    // Only unencrypted Store or Deflate entries, 16 MB in total, with safe unique paths.
    if (flags & 1) throw new Error('Encrypted ZIP files are not supported');
    if (method !== 0 && method !== 8) throw new Error('Unsupported ZIP compression method: ' + method);
    if (method === 0 && compressedSize !== size) throw new Error('Invalid stored ZIP entry');
    if (size > 16 * 1024 * 1024 - total) throw new Error('ZIP contents exceed 16 MiB');
    const rawName = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    at += 46 + nameLen + extraLen + commentLen;
    // Folders are created along with their files.
    if (rawName.endsWith('/')) continue;
    const file = cleanPath(rawName);
    if (!file || file !== rawName || names.has(file)) throw new Error('Invalid ZIP path: ' + rawName);
    if (localAt + 30 > buf.length || buf.readUInt32LE(localAt) !== 0x04034b50) {
      throw new Error('Invalid ZIP entry: ' + file);
    }
    const localNameLen = buf.readUInt16LE(localAt + 26);
    const localExtraLen = buf.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + localNameLen + localExtraLen;
    if (dataAt + compressedSize > buf.length) throw new Error('Truncated ZIP entry: ' + file);
    const compressed = buf.subarray(dataAt, dataAt + compressedSize);
    let content;
    if (method === 0) {
      content = compressed;
    } else {
      try {
        // The output limit stops an entry inflating to more than it declares.
        content = zlib.inflateRawSync(compressed, { maxOutputLength: size + 1 });
      } catch {
        throw new Error('Could not decompress ZIP entry: ' + file);
      }
      if (content.length !== size) throw new Error('ZIP size mismatch: ' + file);
    }
    if (crc32(content) !== expectedCrc) throw new Error('ZIP checksum failed: ' + file);
    total += size;
    names.add(file);
    entries.push({ path: file, content });
  }
  if (!entries.length) throw new Error('ZIP contains no files');
  return entries;
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
// Sends a JSON reply that browsers never cache.
const sendJSON = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

// The whole request body, refused past `limit` bytes.
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Treat invalid UTF-8 and control bytes as binary.
function asText(buf) {
  if (buf.includes(0)) return null;
  const text = buf.toString('utf8');
  if (text.includes('�')) return null;
  if (/[\x01-\x08\x0e-\x1f]/.test(text)) return null;
  return text;
}

// ── Model Context Protocol ─────────────────────────────────────────────────
// The MCP revision served, the older ones still accepted on initialize, and the limits.
const MCP_PROTOCOL = '2026-07-28';
const MCP_LEGACY_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const MCP_SERVER_INFO = { name: 'pico-bay', version: VERSION };
const MCP_CAPABILITIES = { tools: { listChanged: false } };
const MCP_MAX_BODY = 12 * 1024 * 1024;

// An MCP tool result: the data as JSON text plus structuredContent, flagged on error.
function mcpToolResult(data, isError = false) {
  const text = isError
    ? (data && data.error ? String(data.error) : JSON.stringify(data))
    : JSON.stringify(data);
  const result = {
    content: [{ type: 'text', text }],
    structuredContent: isError && typeof data !== 'object' ? { error: String(data) } : data,
  };
  if (isError) result.isError = true;
  return result;
}

// Rejects tool arguments that are not an object, unknown, or missing.
function validateToolArgs(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Arguments must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error('Unknown argument: ' + key);
  }
  for (const key of required) {
    if (value[key] === undefined) throw new Error('Missing required argument: ' + key);
  }
  return value;
}

// A string argument, optionally allowed empty or limited to a set of values.
function stringArg(args, name, options = {}) {
  const value = args[name];
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== 'string' || (!options.allowEmpty && !value.length)) {
    throw new Error(name + ' must be a' + (options.allowEmpty ? '' : ' non-empty') + ' string');
  }
  if (options.values && !options.values.includes(value)) {
    throw new Error(name + ' must be one of: ' + options.values.join(', '));
  }
  return value;
}

// A boolean argument, with a default when absent.
function booleanArg(args, name, defaultValue = false) {
  if (args[name] === undefined) return defaultValue;
  if (typeof args[name] !== 'boolean') throw new Error(name + ' must be a boolean');
  return args[name];
}

// A board path argument, cleaned like every other path.
function cleanToolPath(args, name) {
  const value = cleanPath(stringArg(args, name));
  if (!value) throw new Error('Bad path: ' + name);
  return value;
}

// One board as MCP clients see it: stable board_id (UID, else the device path),
// firmware, model, capabilities, and install details for boards in install mode.
function boardRecord(device) {
  const record = {
    // The UID survives a board moving to another serial port; the device path does not.
    board_id: device.uid || device.dev,
    device: device.dev,
    connected: true,
    ok: device.ok,
    firmware: device.firmware || null,
    firmware_label: device.firmwareLabel || null,
    model: device.machine || device.label || null,
    version: device.release || null,
    uid: device.uid || null,
    // null when unknown (still identifying or failed).
    read_only: device.readOnly === undefined ? null : !!device.readOnly,
    capabilities: device.capabilities || null,
    error: device.error || null,
  };
  if (device.bootMode) {
    record.boot_mode = true;
    record.chip = device.machine;
    record.mounted = !!device.mountRoot;
    record.installable_firmware = device.bootloader === 'esp-rom'
      ? (device.bootDetails?.installSupported ? ['micropython'] : [])
      : ['micropython'];
    if (device.installFirmware) record.install_firmware = device.installFirmware;
    if (device.bootDetails) record.boot_details = device.bootDetails;
  }
  return record;
}

// The BOOTSEL drive a board_id names; errors when none or several match.
async function resolveBootselBoardId(boardId) {
  const wanted = String(boardId || '');
  if (!wanted) throw new Error('board_id must be a non-empty string');
  const matches = (await bootselDevices())
    .filter(device => device.dev === wanted || (device.uid && device.uid === wanted));
  if (!matches.length) throw new Error('BOOTSEL board not connected: ' + wanted);
  if (matches.length > 1) throw new Error('Ambiguous board_id: ' + wanted);
  return matches[0];
}

// pico_install "check" for a BOOTSEL drive: mounts it if possible (or returns the mount
// command for the user to run), then asks whether it is a W model.
async function checkBootselInstall(boardId, firmware) {
  if (firmware !== 'micropython') throw new Error('Unsupported firmware: ' + firmware);
  const device = await resolveBootselBoardId(boardId);
  let root = device.mountRoot;
  // Try to mount it; when the Pi needs permission, return the command for the user.
  if (!root && process.platform === 'linux' && !bootselDeviceOverride) {
    try { root = await mountedBootselRoot(device); }
    catch (error) {
      const command = /Run "([^"]+)" on the Pi/.exec(String(error.message || error));
      if (command) {
        return {
          status: 'needs_mount', firmware, chip: device.machine, command: command[1],
          message: 'Ask the user to run this command on the Pi, then call pico_install with action check again.',
        };
      }
      throw error;
    }
  }
  if (!root) {
    if (device.blockDevice) {
      return {
        status: 'needs_mount', firmware, chip: device.machine,
        command: 'udisksctl mount --block-device ' + device.blockDevice,
        message: 'Ask the user to run this command on the Pi, then call pico_install with action check again.',
      };
    }
    throw new Error('Could not mount the BOOTSEL volume');
  }
  fs.accessSync(root, fs.constants.W_OK);
  // Ready: the client must ask whether this is a W model.
  const models = bootselFirmwareOptions(device.machine).map(option => ({
    wifi: / W$/.test(option.name), name: option.name,
  }));
  if (!models.length) throw new Error('Unsupported BOOTSEL chip: ' + device.machine);
  return {
    status: 'ready', firmware, chip: device.machine, mounted: true,
    question: 'Is this a W model with Wi-Fi?', models,
  };
}

// The ESP32 in download mode a board_id names.
async function resolveEspDownloadBoardId(boardId) {
  const wanted = String(boardId || '');
  if (!wanted) throw new Error('board_id must be a non-empty string');
  const matches = (await scanDevices())
    .filter(device => device.bootloader === 'esp-rom' &&
      (device.dev === wanted || (device.uid && device.uid === wanted)));
  if (!matches.length) throw new Error('ESP32 download-mode board not connected: ' + wanted);
  if (matches.length > 1) throw new Error('Ambiguous board_id: ' + wanted);
  return matches[0];
}

// pico_install "check" for an ESP32: confirms the chip is supported and unprotected.
async function checkEspInstall(boardId, firmware) {
  if (firmware !== 'micropython') throw new Error('Unsupported firmware: ' + firmware);
  const device = await resolveEspDownloadBoardId(boardId);
  const selected = assertEspInstallAllowed(device);
  return {
    status: 'ready', firmware, chip: device.machine, bootloader: 'esp-rom',
    model: selected.name, build: selected.build, address: selected.offset,
  };
}

// The BOOTSEL firmware id for a chip and the W answer.
function micropythonFirmwareId(chip, wifi) {
  if (chip === 'RP2040') return wifi ? 'pico-w' : 'pico';
  if (chip === 'RP2350') return wifi ? 'pico2-w' : 'pico2';
  throw new Error('Unsupported BOOTSEL chip: ' + chip);
}

// The device path of a running, identified board named by board_id.
async function resolveBoardId(boardId) {
  const wanted = String(boardId || '');
  if (!wanted) throw new Error('board_id must be a non-empty string');
  const devices = await scanDevices();
  const matches = devices.filter(device => device.dev === wanted || (device.uid && device.uid === wanted));
  if (!matches.length) throw new Error("Board not connected: " + wanted);
  if (matches.length > 1) throw new Error("Ambiguous board_id: " + wanted);
  if (!matches[0].ok) throw new Error(matches[0].error || 'Board identification failed');
  if (matches[0].bootMode) throw new Error('Board is in BOOTSEL firmware-install mode');
  return matches[0].dev;
}

// File content from a tool call: UTF-8 text, or strictly valid base64.
function decodeMcpContent(content, encoding) {
  if (encoding === 'utf8') return Buffer.from(content, 'utf8');
  if (content.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
    throw new Error('content is not valid base64');
  }
  return Buffer.from(content, 'base64');
}

// Shared JSON Schema pieces and annotations for the tool definitions below.
const boardIdProperty = {
  type: 'string',
  description: 'Stable board UID returned by pico_boards_list, or its current serial device path.',
};
const boardPathProperty = {
  type: 'string',
  description: 'Path on the board filesystem, relative to its root.',
};
const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const additiveAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const destructiveAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

// The MCP tools: name, schema and annotations for tools/list, and the handler that
// validates arguments and calls the same functions the web API uses.
const MCP_TOOLS = [
  {
    // Every connected board, including boards in install mode.
    name: 'pico_boards_list',
    title: 'List connected boards',
    description: 'List connected Raspberry Pi Pico and ESP32 boards with MicroPython or CircuitPython and report their capabilities. Use board_id from this result in every other tool.',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: readOnlyAnnotations,
    handler: async (raw) => {
      validateToolArgs(raw, []);
      return mcpToolResult({ boards: (await scanDevices()).map(boardRecord) });
    },
  },
  {
    // MicroPython install for a BOOTSEL Pico or an ESP32 in download mode: "check" reports
    // readiness (mount command, W question), "install" needs confirmed=true.
    name: 'pico_install',
    title: 'Install firmware on a bootloader-mode board',
    description: 'Install MicroPython on a Pico in BOOTSEL mode or a supported ESP32 in DOWNLOAD mode. Always call action check first. A Pico may require mounting and a Wi-Fi model choice. An ESP32 uses the detected chip-specific generic build. Obtain explicit confirmation before calling action install.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        board_id: boardIdProperty,
        action: { type: 'string', enum: ['check', 'install'] },
        firmware: { type: 'string', enum: ['micropython'] },
        wifi: { type: 'boolean', description: 'Whether a Pico is a W model with Wi-Fi. Required only for Pico installation.' },
        initialize_storage: { type: 'boolean', description: 'Erase and initialize ESP32 filesystem storage during installation. Defaults to true for ESP32.' },
        confirmed: { type: 'boolean', description: 'Must be true after the user explicitly confirms installation.' },
      },
      required: ['board_id', 'action', 'firmware'],
    },
    annotations: destructiveAnnotations,
    handler: async (raw) => {
      const args = validateToolArgs(
        raw, ['board_id', 'action', 'firmware', 'wifi', 'initialize_storage', 'confirmed'],
        ['board_id', 'action', 'firmware'],
      );
      const boardId = stringArg(args, 'board_id');
      const action = stringArg(args, 'action', { values: ['check', 'install'] });
      const firmware = stringArg(args, 'firmware', { values: ['micropython'] });
      let bootselDevice = null;
      // A board_id that is not a BOOTSEL drive is looked up as an ESP32 in download mode.
      try { bootselDevice = await resolveBootselBoardId(boardId); }
      catch { /* The requested board may be an ESP serial bootloader. */ }
      // Check first; install only when the check says ready.
      const readiness = bootselDevice
        ? await checkBootselInstall(boardId, firmware)
        : await checkEspInstall(boardId, firmware);
      if (action === 'check' || readiness.status !== 'ready') {
        return mcpToolResult({ board_id: boardId, ...readiness });
      }
      // Installing replaces the firmware, so the client must confirm with the user first.
      if (args.confirmed !== true) throw new Error('confirmed must be true after explicit user confirmation');
      if (readiness.bootloader === 'esp-rom') {
        const device = await resolveEspDownloadBoardId(boardId);
        // ESP32: erase the filesystem too unless the client said not to.
        const install = espInstallOverride || installEspFirmware;
        const initializeStorage = args.initialize_storage === undefined
          ? true : booleanArg(args, 'initialize_storage');
        const result = await install(
          device.dev, downloadFirmware, () => {}, { initializeStorage },
        );
        return mcpToolResult({
          board_id: boardId, status: 'installed', firmware,
          model: readiness.model, build: readiness.build,
          bytes: result.bytes, storage_initialized: initializeStorage,
          message: 'Firmware was verified and installed. The board should reboot and reconnect automatically.',
        });
      }
      // A Pico's W variant cannot be detected, so the client must say which it is.
      if (args.wifi === undefined) throw new Error('wifi is required for Pico action install');
      const wifi = booleanArg(args, 'wifi');
      // Pico: install the UF2 for the chip and W answer.
      const firmwareId = micropythonFirmwareId(readiness.chip, wifi);
      const install = bootselInstallOverride || installBootselFirmware;
      const device = await resolveBootselBoardId(boardId);
      const result = await install(device.dev, firmwareId);
      return mcpToolResult({
        board_id: boardId, status: 'installed', firmware,
        model: BOOTSEL_FIRMWARE[firmwareId].name,
        bytes: result.bytes,
        message: 'Firmware was installed. The board should reboot and reconnect automatically.',
      });
    },
  },
  {
    // The file tree plus Flash and RAM usage.
    name: 'pico_files_list',
    title: 'List board files',
    description: 'List the complete board filesystem and report Flash and RAM usage. Hidden system files are omitted unless include_system is true.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { board_id: boardIdProperty, include_system: { type: 'boolean', default: false } },
      required: ['board_id'],
    },
    annotations: readOnlyAnnotations,
    handler: async (raw) => {
      const args = validateToolArgs(raw, ['board_id', 'include_system'], ['board_id']);
      const dev = await resolveBoardId(stringArg(args, 'board_id'));
      // Usage is best-effort: a board that cannot report it still lists its files.
      const files = await listFiles(dev, booleanArg(args, 'include_system'));
      const stats = await deviceStats(dev).catch(() => null);
      return mcpToolResult({ board_id: args.board_id, files, stats });
    },
  },
  {
    // One file, as UTF-8 text when it is text, else base64.
    name: 'pico_file_read',
    title: 'Read a board file',
    description: 'Read one board file. auto returns UTF-8 text when safe and base64 for binary data; utf8 forces text; base64 always returns base64.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        board_id: boardIdProperty,
        path: boardPathProperty,
        encoding: { type: 'string', enum: ['auto', 'utf8', 'base64'], default: 'auto' },
      },
      required: ['board_id', 'path'],
    },
    annotations: readOnlyAnnotations,
    handler: async (raw) => {
      const args = validateToolArgs(raw, ['board_id', 'path', 'encoding'], ['board_id', 'path']);
      const dev = await resolveBoardId(stringArg(args, 'board_id'));
      const file = cleanToolPath(args, 'path');
      const encoding = stringArg(args, 'encoding', { optional: true, values: ['auto', 'utf8', 'base64'] }) || 'auto';
      const buf = await readFile(dev, file);
      // "auto" returns text only when the file really is text.
      const text = encoding === 'base64' ? null : asText(buf);
      const binary = encoding === 'base64' || (encoding === 'auto' && text === null);
      return mcpToolResult({
        board_id: args.board_id, path: file, size: buf.length, binary,
        encoding: binary ? 'base64' : 'utf8',
        content: binary ? buf.toString('base64') : (text === null ? buf.toString('utf8') : text),
      });
    },
  },
  {
    // Creates or overwrites one file, up to 8 MB.
    name: 'pico_file_write',
    title: 'Write a board file',
    description: 'Create or overwrite one board file, creating missing parent directories. content may be UTF-8 text or base64 and is limited to 8 MB decoded.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        board_id: boardIdProperty,
        path: boardPathProperty,
        content: { type: 'string' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
      },
      required: ['board_id', 'path', 'content'],
    },
    annotations: destructiveAnnotations,
    handler: async (raw) => {
      const args = validateToolArgs(raw, ['board_id', 'path', 'content', 'encoding'], ['board_id', 'path', 'content']);
      const dev = await resolveBoardId(stringArg(args, 'board_id'));
      const file = cleanToolPath(args, 'path');
      const content = stringArg(args, 'content', { allowEmpty: true });
      const encoding = stringArg(args, 'encoding', { optional: true, values: ['utf8', 'base64'] }) || 'utf8';
      // The decoded size counts against the 8 MB limit, not the encoded length.
      const buf = decodeMcpContent(content, encoding);
      if (buf.length > 8 * 1024 * 1024) throw new Error('content exceeds the 8 MB write limit');
      const result = await writeFile(dev, file, buf);
      return mcpToolResult({ board_id: args.board_id, path: file, ...result });
    },
  },
  {
    // Creates one folder.
    name: 'pico_directory_create',
    title: 'Create a board directory',
    description: 'Create one directory on the selected board.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { board_id: boardIdProperty, path: boardPathProperty },
      required: ['board_id', 'path'],
    },
    annotations: additiveAnnotations,
    handler: async (raw) => {
      const args = validateToolArgs(raw, ['board_id', 'path'], ['board_id', 'path']);
      const dev = await resolveBoardId(stringArg(args, 'board_id'));
      const file = cleanToolPath(args, 'path');
      const result = await makeDirectory(dev, file);
      return mcpToolResult({ board_id: args.board_id, path: file, ...result });
    },
  },
  {
    // Renames or moves a file or folder.
    name: 'pico_path_rename',
    title: 'Rename or move a board path',
    description: 'Rename or move one file or directory on the selected board.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { board_id: boardIdProperty, from: boardPathProperty, to: boardPathProperty },
      required: ['board_id', 'from', 'to'],
    },
    annotations: destructiveAnnotations,
    handler: async (raw) => {
      const args = validateToolArgs(raw, ['board_id', 'from', 'to'], ['board_id', 'from', 'to']);
      const dev = await resolveBoardId(stringArg(args, 'board_id'));
      const from = cleanToolPath(args, 'from');
      const to = cleanToolPath(args, 'to');
      const result = await renamePath(dev, from, to);
      return mcpToolResult({ board_id: args.board_id, from, to, ...result });
    },
  },
  {
    // Deletes a file, or a folder and its contents.
    name: 'pico_path_delete',
    title: 'Delete a board path',
    description: 'Permanently delete one file or recursively delete one directory from the selected board.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { board_id: boardIdProperty, path: boardPathProperty },
      required: ['board_id', 'path'],
    },
    annotations: destructiveAnnotations,
    handler: async (raw) => {
      const args = validateToolArgs(raw, ['board_id', 'path'], ['board_id', 'path']);
      const dev = await resolveBoardId(stringArg(args, 'board_id'));
      const file = cleanToolPath(args, 'path');
      const result = await removePath(dev, file);
      return mcpToolResult({ board_id: args.board_id, path: file, ...result });
    },
  },
  {
    // Runs a file as __main__, or a code snippet, and returns its output.
    name: 'pico_python_run',
    title: 'Run Python on a board',
    description: 'Run a Python file as __main__ or execute Python code. Provide exactly one of path or code. This can change any state accessible to code on the board.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { board_id: boardIdProperty, path: boardPathProperty, code: { type: 'string' } },
      required: ['board_id'],
    },
    annotations: destructiveAnnotations,
    handler: async (raw) => {
      const args = validateToolArgs(raw, ['board_id', 'path', 'code'], ['board_id']);
      const dev = await resolveBoardId(stringArg(args, 'board_id'));
      const hasPath = args.path !== undefined;
      const hasCode = args.code !== undefined;
      if (hasPath === hasCode) throw new Error('Provide exactly one of path or code');
      const options = hasPath
        ? { path: cleanToolPath(args, 'path') }
        : { code: stringArg(args, 'code', { allowEmpty: true }) };
      const result = await runPython(dev, options);
      return mcpToolResult({ board_id: args.board_id, ...result }, !result.ok);
    },
  },
  {
    // Ctrl-C for a running program.
    name: 'pico_board_interrupt',
    title: 'Interrupt a board program',
    description: 'Send Ctrl-C to interrupt the program currently running on the selected board.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { board_id: boardIdProperty }, required: ['board_id'],
    },
    annotations: destructiveAnnotations,
    handler: async (raw) => {
      const args = validateToolArgs(raw, ['board_id'], ['board_id']);
      const dev = await resolveBoardId(stringArg(args, 'board_id'));
      return mcpToolResult({ board_id: args.board_id, ...await interruptBoard(dev) });
    },
  },
  {
    // Soft or hard reset.
    name: 'pico_board_reset',
    title: 'Reset a board',
    description: 'Soft-reset the selected board, or hard-reset it when the firmware supports hard reset.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { board_id: boardIdProperty, mode: { type: 'string', enum: ['soft', 'hard'], default: 'soft' } },
      required: ['board_id'],
    },
    annotations: destructiveAnnotations,
    handler: async (raw) => {
      const args = validateToolArgs(raw, ['board_id', 'mode'], ['board_id']);
      const dev = await resolveBoardId(stringArg(args, 'board_id'));
      // Soft by default.
      const mode = stringArg(args, 'mode', { optional: true, values: ['soft', 'hard'] }) || 'soft';
      return mcpToolResult({ board_id: args.board_id, mode, ...await resetBoard(dev, mode === 'hard') });
    },
  },
];

// True when a request carries the current protocol revision in its _meta.
function modernMcpRequest(msg) {
  return msg && msg.params && msg.params._meta &&
    msg.params._meta['io.modelcontextprotocol/protocolVersion'] === MCP_PROTOCOL;
}

// Current-revision replies are marked complete and carry the server info.
function completeMcpResult(result, modern) {
  if (!modern) return result;
  return {
    resultType: 'complete',
    ...result,
    _meta: { ...(result._meta || {}), 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
  };
}

// Handles one JSON-RPC message for either transport: server/discover, initialize,
// ping, tools/list and tools/call. Returns the reply, or null for a notification.
async function dispatchMcp(msg) {
  const id = msg && msg.id;
  const isRequest = id !== undefined && id !== null;
  const ok = result => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message, data) => ({
    jsonrpc: '2.0', id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });

  // Not JSON-RPC 2.0 at all.
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return isRequest ? fail(-32600, 'Invalid Request') : null;
  }
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  const metadata = params._meta && typeof params._meta === 'object' ? params._meta : {};
  // A current-revision request names its version and the client's capabilities in _meta.
  const requestedVersion = metadata['io.modelcontextprotocol/protocolVersion'];
  const modern = msg.method === 'server/discover' || modernMcpRequest(msg);
  if (requestedVersion && requestedVersion !== MCP_PROTOCOL) {
    return isRequest ? fail(-32022, 'Unsupported protocol version', { supported: [MCP_PROTOCOL] }) : null;
  }
  if (modern && (!metadata['io.modelcontextprotocol/clientCapabilities'] ||
      typeof metadata['io.modelcontextprotocol/clientCapabilities'] !== 'object')) {
    return isRequest ? fail(-32602, 'Modern MCP requests require clientCapabilities metadata') : null;
  }
  try {
    // Current revision: what this server supports, cacheable for 5 minutes.
    if (msg.method === 'server/discover') {
      return ok({
        resultType: 'complete',
        supportedVersions: [MCP_PROTOCOL],
        capabilities: MCP_CAPABILITIES,
        instructions: 'Manage connected Raspberry Pi Pico and ESP32 boards with MicroPython or CircuitPython. Call pico_boards_list before using a board-specific tool.',
        ttlMs: 300000,
        cacheScope: 'public',
        _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
      });
    }
    // Older revisions: answer with the client's version when supported, else the newest.
    if (msg.method === 'initialize') {
      const requested = params.protocolVersion;
      const protocolVersion = MCP_LEGACY_PROTOCOLS.includes(requested) ? requested : MCP_LEGACY_PROTOCOLS[0];
      return ok({
        protocolVersion,
        capabilities: MCP_CAPABILITIES,
        serverInfo: MCP_SERVER_INFO,
        instructions: 'Call pico_boards_list before using a board-specific tool.',
      });
    }
    if (msg.method === 'ping') return ok(completeMcpResult({}, modern));
    if (msg.method === 'tools/list') {
      // pico_install is listed last.
      const tools = MCP_TOOLS
        .filter(tool => tool.name !== 'pico_install')
        .concat(MCP_TOOLS.filter(tool => tool.name === 'pico_install'))
        .map(({ handler, ...tool }) => tool);
      return ok(completeMcpResult({ tools, ttlMs: 300000, cacheScope: 'public' }, modern));
    }
    // Runs one tool by name.
    if (msg.method === 'tools/call') {
      if (typeof params.name !== 'string') return isRequest ? fail(-32602, 'Tool name is required') : null;
      const tool = MCP_TOOLS.find(entry => entry.name === params.name);
      if (!tool) return isRequest ? fail(-32602, 'Unknown tool: ' + params.name) : null;
      let result;
      try {
        // A tool error becomes an isError result, not a protocol error.
        result = await tool.handler(params.arguments || {});
      } catch (error) {
        result = mcpToolResult({ error: String(error.message || error) }, true);
      }
      return ok(completeMcpResult(result, modern));
    }
    // Notifications such as notifications/initialized and notifications/cancelled need no response.
    return isRequest ? fail(-32601, 'Method not found: ' + msg.method) : null;
  } catch (error) {
    return isRequest ? fail(-32603, 'Internal error: ' + String(error.message || error)) : null;
  }
}

// MCP over stdio: one JSON message per line, replies written in order, and shutdown
// once stdin closes and every pending call has answered.
function runMcpStdio() {
  // stdout belongs exclusively to MCP. Redirect incidental informational output to stderr.
  // Anything logged goes to stderr instead.
  console.log = (...values) => console.error(...values);
  console.info = (...values) => console.error(...values);
  const rl = readline.createInterface({ input: process.stdin });
  const active = new Set();
  let writes = Promise.resolve();
  // Replies are written one at a time, in the order they finish.
  const write = response => {
    if (!response) return;
    writes = writes.then(() => new Promise(resolve => {
      process.stdout.write(JSON.stringify(response) + '\n', resolve);
    }));
  };
  rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const task = dispatchMcp(msg).then(write).catch(error => {
      if (msg.id !== undefined && msg.id !== null) {
        write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error: ' + error.message } });
      }
    }).finally(() => active.delete(task));
    active.add(task);
  });
  // stdin closed: let pending calls answer, then exit.
  rl.on('close', async () => {
    await Promise.allSettled([...active]);
    await writes;
    shutdown();
  });
}

// An Mcp-Name header value, which may be sent base64-encoded as =?base64?...?=.
function decodeMcpHeader(value) {
  if (typeof value !== 'string') return null;
  const encoded = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(value);
  if (!encoded) return value;
  try { return Buffer.from(encoded[1], 'base64').toString('utf8'); }
  catch { return null; }
}

function validMcpOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // Native MCP clients normally omit Origin.
  try { return new URL(origin).host === req.headers.host; }
  catch { return false; }
}

// An HTTP error carrying a JSON-RPC error body.
function mcpHttpError(res, status, id, code, message, data) {
  sendJSON(res, status, {
    jsonrpc: '2.0', id: id === undefined ? null : id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

let mcpHttpActive = 0;

// Streamable HTTP MCP at POST /mcp: checks Origin and body size, requires the
// current revision's Mcp-* headers to match the body, accepts the older revisions,
// allows at most 8 tool calls at once, and answers plain JSON (no SSE).
async function handleMcpHttp(req, res) {
  if (!validMcpOrigin(req)) {
    mcpHttpError(res, 403, null, -32020, 'Invalid Origin header');
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' });
    res.end();
    return;
  }
  let msg;
  try { msg = JSON.parse((await readBody(req, MCP_MAX_BODY)).toString('utf8')); }
  catch (error) {
    const oversized = String(error.message || error) === 'body too large';
    mcpHttpError(res, oversized ? 413 : 400, null, -32700, oversized ? 'Request body too large' : 'Parse error');
    return;
  }

  // The current revision repeats the method and name in headers; they must match the body.
  const version = req.headers['mcp-protocol-version'];
  const bodyVersion = msg && msg.params && msg.params._meta &&
    msg.params._meta['io.modelcontextprotocol/protocolVersion'];
  const modern = version === MCP_PROTOCOL || bodyVersion === MCP_PROTOCOL;
  if (modern) {
    const methodHeader = req.headers['mcp-method'];
    const nameHeader = decodeMcpHeader(req.headers['mcp-name']);
    const bodyName = msg && msg.params && (msg.params.name ?? msg.params.uri);
    if (version !== MCP_PROTOCOL || bodyVersion !== MCP_PROTOCOL || methodHeader !== msg.method ||
        (bodyName !== undefined && nameHeader !== bodyName) || (bodyName === undefined && req.headers['mcp-name'] !== undefined)) {
      mcpHttpError(res, 400, msg && msg.id, -32020, 'MCP request headers do not match the JSON-RPC body');
      return;
    }
  } else if ((version && !MCP_LEGACY_PROTOCOLS.includes(version)) ||
      (bodyVersion && !MCP_LEGACY_PROTOCOLS.includes(bodyVersion))) {
    mcpHttpError(res, 400, msg && msg.id, -32022, 'Unsupported protocol version', {
      supported: [MCP_PROTOCOL, ...MCP_LEGACY_PROTOCOLS],
    });
    return;
  }

  // At most 8 tool calls run at once; more get 429.
  const toolCall = msg && msg.method === 'tools/call';
  if (toolCall && mcpHttpActive >= 8) {
    mcpHttpError(res, 429, msg.id, -32000, 'Too many concurrent MCP tool calls');
    return;
  }
  if (toolCall) mcpHttpActive++;
  let response;
  try { response = await dispatchMcp(msg); }
  finally { if (toolCall) mcpHttpActive--; }
  if (!response) {
    res.writeHead(202);
    res.end();
    return;
  }
  // The current revision answers an unknown method with 404.
  const unknownModernMethod = modern && response.error && response.error.code === -32601;
  sendJSON(res, unknownModernMethod ? 404 : 200, response);
}

// ── ctrlPi API install ──────────────────────────────────────────────────────────
// "Install ctrlPi API" puts pico-gpio-api on a Pico W / Pico 2 W: main.py from the
// project's GitHub release branch, plus config.json, wifi.txt and a sample sensor.

const CTRLPI_MAIN_URL = 'https://raw.githubusercontent.com/ctrlpi/pico-gpio-api/main/main.py';
const CTRLPI_CPU_TEMP = `# CPU temperature in degrees Celsius, as a bare number (e.g. 23.4), not JSON.
# Use it as a sensor: POST /sensor/config/cpu_temp {"script": "cpu-temp.py"}
import machine

def read():
    v = machine.ADC(4).read_u16() * 3.3 / 65535
    return round(27 - (v - 0.706) / 0.001721, 1)
`;

// An Error that the HTTP handler answers with `status` instead of 500.
function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// The files the install writes besides main.py, as [path, text] pairs. An existing
// config.json keeps every setting (pins, sensors, bridges) and only takes the new key
// and name; scripts/cpu-temp.py is written only when the board has none.
function ctrlpiInstallFiles(form, existing = {}) {
  // The form's fields; key and SSID are required, and none may contain a line break.
  const key = String(form?.key ?? '').trim();
  const name = String(form?.name ?? '').trim();
  const ssid = String(form?.ssid ?? '');
  const pass = String(form?.pass ?? '');
  if (!key) throw httpError(400, 'API key is required');
  if (!ssid) throw httpError(400, 'WiFi SSID is required');
  for (const [label, value] of [['API key', key], ['Agent name', name], ['WiFi SSID', ssid], ['WiFi password', pass]]) {
    if (/[\r\n]/.test(value)) throw httpError(400, label + ' cannot contain a line break');
  }
  // Start from the board's own config when it parses as a JSON object.
  let config = {};
  if (existing.config != null) {
    try {
      const parsed = JSON.parse(existing.config);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
    } catch { /* unreadable config: start a fresh one */ }
  }
  config.api_key = key;
  if (name) config.name = name;
  else delete config.name;  // a blank name means the agent's own pico-<serial4> default
  const files = [
    ['config.json', JSON.stringify(config, null, 2) + '\n'],
    ['wifi.txt', 'SSID = ' + ssid + '\nPASSWORD = ' + pass + '\n'],
  ];
  if (!existing.hasCpuTemp) files.push(['scripts/cpu-temp.py', CTRLPI_CPU_TEMP]);
  return files;
}

// The checks the agent's own /upgrade makes on a downloaded main.py; null when it passes.
function ctrlpiMainError(text) {
  if (text.length < 10 * 1024 || text.length > 512 * 1024) return 'unexpected size (' + text.length + ' bytes)';
  const head = text.slice(0, 256);
  if (!head.includes('main.py') || !head.includes('import')) return 'banner or imports missing';
  if (text.includes('\0')) return 'binary data in file';
  if (!/\nmain\(\)\s*$/.test(text)) return 'trailing main() call missing';
  return null;
}

// Downloads pico-gpio-api's main.py, with a 30 s limit, and checks it.
async function downloadCtrlpiMain() {
  const response = await fetch(CTRLPI_MAIN_URL, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw httpError(502, 'main.py download failed (HTTP ' + response.status + ')');
  const text = await response.text();
  const problem = ctrlpiMainError(text);
  if (problem) throw httpError(502, 'Downloaded main.py failed its check: ' + problem);
  return text;
}

// ── Routing ─────────────────────────────────────────────────────────────────
// The web UI, the JSON API used by page.html, and /mcp when HTTP MCP is enabled.
function createServer(options = {}) {
  const logDevices = options.logDevices !== false;
  // Logs a failed request with the board it was for (silent under stdio MCP).
  const reportError = (operation, dev, error) => {
    if (mcpStdio || options.logErrors === false) return;
    const machine = ports.get(dev)?.info?.machine;
    const context = [machine, dev].filter(Boolean).join(' · ');
    const line = operation + ' failed: ' + (context ? context + ' · ' : '') +
      String(error.message || error);
    (options.errorLogger || console.error)(line.replace(/[\r\n]+/g, ' '));
  };
  // The UI can switch HTTP MCP on and off while running. The installers and the main.py
  // download can be replaced through options, which is how the tests run without boards.
  let enableMcp = options.mcpHttp === true;
  const installBootsel = options.installBootsel || installBootselFirmware;
  const installEsp = options.installEsp || installEspFirmware;
  const initializeStorage = options.initializeStorage || initializeEspStorage;
  const fetchCtrlpiMain = options.fetchCtrlpiMain || downloadCtrlpiMain;
  const allowHosts = options.allowHosts || ALLOW_HOSTS;
  // Background install jobs by id, and the running job per device (one at a time).
  const bootselJobs = new Map();
  const bootselJobByDevice = new Map();
  const espJobs = new Map();
  const espJobByDevice = new Map();

  // The fields of an install job the UI polls for.
  const publicInstallJob = job => ({
    id: job.id, dev: job.dev, status: job.status, stage: job.stage,
    percent: job.percent, firmwareId: job.firmwareId || null,
    firmwareName: job.firmwareName || null,
    initializeStorage: !!job.initializeStorage,
    error: job.error || null, result: job.result || null,
  });
  // A finished job frees its device and is kept 10 minutes for the UI to read its result.
  const finishJob = (jobs, jobsByDevice, job) => {
    jobsByDevice.delete(job.dev);
    const cleanup = setTimeout(() => jobs.delete(job.id), 10 * 60 * 1000);
    cleanup.unref?.();
  };
  // Starts a BOOTSEL install in the background (or returns the one already running) and
  // records its stage and percent as it goes.
  const startBootselJob = (dev, firmwareId, firmwareName) => {
    // A second request while one install runs just returns that job.
    const activeId = bootselJobByDevice.get(dev);
    const active = activeId && bootselJobs.get(activeId);
    if (active && active.status === 'running') return active;
    const job = {
      id: crypto.randomUUID(), dev, firmwareId, firmwareName,
      status: 'running', stage: 'queued', percent: 0,
      error: null, result: null, updatedAt: Date.now(),
    };
    bootselJobs.set(job.id, job);
    bootselJobByDevice.set(dev, job.id);
    const update = progress => {
      if (job.status !== 'running') return;
      job.stage = String(progress.stage || job.stage);
      job.percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
      job.updatedAt = Date.now();
    };
    // The install runs in the background; the route returns the job at once.
    void Promise.resolve().then(() => installBootsel(dev, firmwareId, downloadFirmware, update)).then(result => {
      job.status = 'complete';
      job.stage = 'complete';
      job.percent = 100;
      job.result = result;
      job.updatedAt = Date.now();
      finishJob(bootselJobs, bootselJobByDevice, job);
    }, error => {
      reportError('BOOTSEL installation (' + job.stage + ')', dev, error);
      job.status = 'failed';
      job.stage = 'failed';
      job.error = String(error.message || error);
      job.updatedAt = Date.now();
      finishJob(bootselJobs, bootselJobByDevice, job);
    });
    return job;
  };
  // The same for an ESP32 install, optionally erasing the filesystem afterwards.
  const startEspJob = (dev, initializeStorage) => {
    // A second request while one install runs just returns that job.
    const activeId = espJobByDevice.get(dev);
    const active = activeId && espJobs.get(activeId);
    if (active && active.status === 'running') return active;
    const job = {
      id: crypto.randomUUID(), dev, initializeStorage,
      status: 'running', stage: 'queued',
      percent: 0, error: null, result: null, updatedAt: Date.now(),
    };
    espJobs.set(job.id, job);
    espJobByDevice.set(dev, job.id);
    const update = progress => {
      if (job.status !== 'running') return;
      job.stage = String(progress.stage || job.stage);
      job.percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
      job.updatedAt = Date.now();
    };
    // The install runs in the background; the route returns the job at once.
    void Promise.resolve().then(() => installEsp(
      dev, downloadFirmware, update, { initializeStorage },
    )).then(result => {
      job.status = 'complete';
      job.stage = 'complete';
      job.percent = 100;
      job.result = result;
      job.updatedAt = Date.now();
      finishJob(espJobs, espJobByDevice, job);
    }, error => {
      reportError('ESP32 installation (' + job.stage + ')', dev, error);
      job.status = 'failed';
      job.stage = 'failed';
      job.error = String(error.message || error);
      job.updatedAt = Date.now();
      finishJob(espJobs, espJobByDevice, job);
    });
    return job;
  };
  return http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://localhost');
  const p = parsed.pathname;
  const q = Object.fromEntries(parsed.searchParams);

  try {
    // Every route, MCP included, answers only requests addressed to an allowed host.
    if (!hostAllowed(req.headers.host, allowHosts)) {
      const name = String(req.headers.host || '').replace(/:\d+$/, '').slice(0, 100);
      sendJSON(res, 403, {
        error: 'Host not allowed: ' + name + '. Open pico-bay by IP address, or start it with --allow-host ' + name,
      });
      return;
    }

    // Streamable HTTP MCP, when enabled.
    if (p === '/mcp' && enableMcp) {
      await handleMcpHttp(req, res);
      return;
    }

    // Reject cross-origin browser writes to the local API.
    if (p.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      let foreignOrigin = req.headers['sec-fetch-site'] === 'cross-site';
      if (origin) {
        try { foreignOrigin = new URL(origin).host !== req.headers.host; }
        catch { foreignOrigin = true; }
      }
      if (foreignOrigin) { sendJSON(res, 403, { error: 'Cross-origin request rejected' }); return; }
    }

    // The single-page UI, the README for its full-screen view, and the license.
    if (p === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }

    if (p === '/api/readme' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(README);
      return;
    }

    if (p === '/LICENSE' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(LICENSE);
      return;
    }

    // The device list the UI polls. A manual Scan first clears cached probes so every
    // running board is identified again (boards in install mode and installs are kept).
    if (p === '/api/devices') {
      if (q.manual === '1') {
        console.log('scanning for devices…');
        for (const port of ports.values()) {
          if (port instanceof PicoPort && !port.busy && !port.probePromise && !espInstalls.has(port.dev)) {
            if (port.info?.bootMode) continue;
            port.info = null;
            port.probeFailure = null;
          }
        }
      }
      const list = await scanDevices({ waitForProbes: false });
      if (logDevices) logDeviceChanges(list);
      sendJSON(res, 200, {
        // Each device carries its install mode and any running install job.
        devices: list.map(device => {
          device = { ...device, bootloaderMode: bootloaderMode(device) };
          const job = bootselJobs.get(bootselJobByDevice.get(device.dev)) ||
            espJobs.get(espJobByDevice.get(device.dev));
          return job ? { ...device, installJob: publicInstallJob(job) } : device;
        }),
        hostWarning: raspberryPiPowerWarning(),
        raspberryPiHost: RASPBERRY_PI_HOST,
        usbAutomountSetupAvailable: USB_AUTOMOUNT_SETUP_AVAILABLE,
        mcpEnabled: enableMcp,
        serverInstance: SERVER_INSTANCE,
      });
      return;
    }

    // Switches HTTP MCP on (enabled=1) or off (enabled=0).
    if (p === '/api/mcp' && req.method === 'POST') {
      if (!['0', '1'].includes(q.enabled)) {
        sendJSON(res, 400, { error: 'enabled must be 0 or 1' });
        return;
      }
      enableMcp = q.enabled === '1';
      sendJSON(res, 200, { enabled: enableMcp });
      return;
    }

    // Starts a MicroPython install on a BOOTSEL drive; the UI polls the status route.
    if (p === '/api/bootsel/install' && req.method === 'POST') {
      // The device must still be present.
      if (!q.dev) {
        sendJSON(res, 404, { error: 'BOOTSEL device is no longer connected' });
        return;
      }
      // The firmware id must be one of the known Pico models.
      const firmware = BOOTSEL_FIRMWARE[q.firmware];
      if (!firmware) {
        sendJSON(res, 400, { error: 'Unknown firmware selection' });
        return;
      }
      sendJSON(res, 202, publicInstallJob(startBootselJob(q.dev, q.firmware, firmware.name)));
      return;
    }

    if (p === '/api/bootsel/install/status' && req.method === 'GET') {
      // Install progress for the page to poll.
      const job = bootselJobs.get(q.id);
      if (!job) {
        sendJSON(res, 404, { error: 'BOOTSEL installation job was not found' });
        return;
      }
      sendJSON(res, 200, publicInstallJob(job));
      return;
    }

    // Starts a MicroPython install on an ESP32 in download mode; polled the same way.
    if (p === '/api/esp/install' && req.method === 'POST') {
      if (q.confirmed !== '1') {
        sendJSON(res, 400, { error: 'Installation must be confirmed' });
        return;
      }
      if (!q.dev || !listDevs().includes(q.dev)) {
        sendJSON(res, 404, { error: 'ESP32 is no longer connected' });
        return;
      }
      sendJSON(res, 202, publicInstallJob(startEspJob(q.dev, q.initialize === '1')));
      return;
    }

    if (p === '/api/esp/install/status' && req.method === 'GET') {
      // Install progress for the page to poll.
      const job = espJobs.get(q.id);
      if (!job) {
        sendJSON(res, 404, { error: 'ESP32 installation job was not found' });
        return;
      }
      sendJSON(res, 200, publicInstallJob(job));
      return;
    }

    // The live console as Server-Sent Events.
    if (p === '/api/console') {
      const dev = q.dev;
      // The console needs a connected board.
      if (!dev || !listDevs().includes(dev)) { res.writeHead(404); res.end(); return; }
      await attachConsole(dev, res);
      return;
    }

    // Everything below needs a live board.
    const dev = q.dev;
    // Every route below works on a connected board named by ?dev=.
    if (p.startsWith('/api/')) {
      if (!dev || !listDevs().includes(dev)) { sendJSON(res, 404, { error: 'Board not connected' }); return; }
    }

    // The board's file tree with Flash and RAM usage.
    if (p === '/api/files') {
      const [files, stats] = [await listFiles(dev, q.system === '1'), await deviceStats(dev).catch(() => null)];
      sendJSON(res, 200, { files, stats });
      return;
    }

    // Creates the filesystem on an ESP32 whose storage was never initialized.
    if (p === '/api/storage/initialize' && req.method === 'POST') {
      if (q.confirmed !== '1') {
        sendJSON(res, 400, { error: 'Storage initialization must be confirmed' });
        return;
      }
      sendJSON(res, 200, await initializeStorage(dev));
      return;
    }

    // Reads a file: as a download, or as JSON with its text (binary files flagged).
    if (p === '/api/file' && req.method === 'GET') {
      const file = cleanPath(q.path);
      if (!file) { sendJSON(res, 400, { error: 'Bad path' }); return; }
      const buf = await readFile(dev, file);
      if (q.download === '1') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="' + file.split('/').pop().replace(/"/g, '') + '"',
          'Content-Length': buf.length,
          'Cache-Control': 'no-store',
        });
        res.end(buf);
        return;
      }
      const text = asText(buf);
      sendJSON(res, 200, { path: file, size: buf.length, binary: text === null, text: text || '' });
      return;
    }

    // Writes the request body to a file (upload, editor save).
    if (p === '/api/file' && (req.method === 'PUT' || req.method === 'POST')) {
      await requireWritable(dev);
      const file = cleanPath(q.path);
      if (!file) { sendJSON(res, 400, { error: 'Bad path' }); return; }
      const body = await readBody(req);
      sendJSON(res, 200, await writeFile(dev, file, body));
      return;
    }

    // Deletes a file or folder.
    if (p === '/api/file' && req.method === 'DELETE') {
      await requireWritable(dev);
      const file = cleanPath(q.path);
      if (!file) { sendJSON(res, 400, { error: 'Bad path' }); return; }
      sendJSON(res, 200, await removePath(dev, file));
      return;
    }

    // Creates a folder and any missing parents.
    if (p === '/api/mkdir' && req.method === 'POST') {
      await requireWritable(dev);
      const file = cleanPath(q.path);
      if (!file) { sendJSON(res, 400, { error: 'Bad path' }); return; }
      sendJSON(res, 200, await makeDirectory(dev, file));
      return;
    }

    // Creates an empty file.
    if (p === '/api/touch' && req.method === 'POST') {
      await requireWritable(dev);
      const file = cleanPath(q.path);
      if (!file) { sendJSON(res, 400, { error: 'Bad path' }); return; }
      sendJSON(res, 200, await writeFile(dev, file, Buffer.alloc(0)));
      return;
    }

    // Renames or moves a file or folder.
    if (p === '/api/rename' && req.method === 'POST') {
      await requireWritable(dev);
      const from = cleanPath(q.path), to = cleanPath(q.to);
      if (!from || !to) { sendJSON(res, 400, { error: 'Bad path' }); return; }
      sendJSON(res, 200, await renamePath(dev, from, to));
      return;
    }

    // Downloads every file on the board as one ZIP named after the board and the date.
    if (p === '/api/zip' || p === '/api/download-all') {
      // Read every file, including hidden ones, into the archive.
      const files = await listFiles(dev, true);
      const entries = [];
      for (const f of files) {
        if (!f.isDir) {
          const buf = await readFile(dev, f.path);
          entries.push({ path: f.path, content: buf, mtime: f.mtime });
        }
      }
      const zipBuf = createZipBuffer(entries);

      let devName = 'pico';
      try {
        const probed = await probe(dev);
        if (probed && (probed.label || probed.machine)) {
          devName = (probed.label || probed.machine).replace(/[^a-zA-Z0-9_-]/g, '_');
        }
      } catch {
        devName = path.basename(dev).replace(/[^a-zA-Z0-9_-]/g, '_');
      }
      // Named after the board and today's date, e.g. Pico_W_2026-10-18.zip.
      const today = new Date().toISOString().slice(0, 10);
      const zipName = devName + '_' + today + '.zip';

      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="' + zipName + '"',
        'Content-Length': zipBuf.length,
        'Cache-Control': 'no-store',
      });
      res.end(zipBuf);
      return;
    }

    // Writes every file of an uploaded ZIP to the board (other files are left alone).
    if (p === '/api/restore' && req.method === 'POST') {
      await requireWritable(dev);
      // The archive is checked in full before the first file is written.
      const entries = parseRestoreZip(await readBody(req, 16 * 1024 * 1024));
      const restored = [];
      for (const entry of entries) {
        await writeFile(dev, entry.path, entry.content);
        restored.push(entry.path);
      }
      sendJSON(res, 200, { ok: true, restored: restored.length, files: restored });
      return;
    }

    // Deletes every file on the board ("Delete all files").
    if (p === '/api/clean' && req.method === 'POST') {
      await requireWritable(dev);
      sendJSON(res, 200, await cleanAll(dev));
      return;
    }

    // Runs a file (?path=) or the posted console line, streaming to the console.
    if (p === '/api/run' && req.method === 'POST') {
      // A file to run (?path=), or the posted body as one console line.
      const options = q.path
        ? { path: q.path }
        : { code: (await readBody(req)).toString('utf8') };
      sendJSON(res, 200, await runPython(dev, options));
      return;
    }

    // Sends Ctrl-C to the running program.
    if (p === '/api/interrupt' && req.method === 'POST') {
      sendJSON(res, 200, await interruptBoard(dev));
      return;
    }

    // "Install ctrlPi API" (see ctrlpiInstallFiles).
    if (p === '/api/ctrlpi/install' && req.method === 'POST') {
      await requireWritable(dev);
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { throw httpError(400, 'Invalid JSON body'); }
      // What the board already has: its config is kept, its sensor script is not replaced.
      const existingPaths = new Set((await listFiles(dev, true)).map(f => String(f.path).replace(/^\//, '')));
      const existing = {
        config: existingPaths.has('config.json') ? (await readFile(dev, 'config.json')).toString('utf8') : null,
        hasCpuTemp: existingPaths.has('scripts/cpu-temp.py'),
      };
      // Validate the form and fetch main.py before anything on the board is written.
      const files = ctrlpiInstallFiles(body, existing);
      const mainPy = await fetchCtrlpiMain();
      await writeFile(dev, 'main.py', Buffer.from(mainPy));
      for (const [file, text] of files) await writeFile(dev, file, Buffer.from(text));
      await resetBoard(dev, false);
      sendJSON(res, 200, { ok: true, keptConfig: existing.config !== null });
      return;
    }

    // Soft reset, or hard reset with ?hard=1.
    if (p === '/api/reset' && req.method === 'POST') {
      sendJSON(res, 200, await resetBoard(dev, q.hard === '1'));
      return;
    }

    // Sends the board to BOOTSEL or ESP download mode.
    if (p === '/api/bootloader' && req.method === 'POST') {
      sendJSON(res, 200, await enterBootloader(dev, q.mode));
      return;
    }

    // Anything else is unknown.
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    if (p !== '/mcp') reportError(req.method + ' ' + p, q.dev, e);
    if (!res.headersSent) sendJSON(res, e.status || 500, { error: String(e.message || e) });
    else try { res.end(); } catch { /* already closed */ }
  }
  });
}

// Opens the UI in the default browser.
function openBrowser(url) {
  const plat = process.platform;
  if (plat === 'darwin') {
    execFile('open', [url], () => {});
  } else if (plat === 'win32') {
    execFile('cmd.exe', ['/c', 'start', '""', url], () => {});
  } else {
    execFile('xdg-open', [url], () => {});
  }
}

// The process listening on a TCP port (netstat on Windows, lsof elsewhere), for the
// "port in use" message.
function findPortOwner(port) {
  if (process.platform === 'win32') {
    try {
      const netstat = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'netstat.exe') : 'netstat';
      const output = execFileSync(netstat, ['-ano', '-p', 'tcp'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      const match = new RegExp(`:${port}\\s+.*LISTENING\\s+(\\d+)`, 'i').exec(output);
      return match ? { pid: match[1], command: 'process' } : null;
    } catch { return null; }
  }
  try {
    const output = execFileSync('lsof', [
      '-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-Fpct',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const pid = /^p(\d+)$/m.exec(output);
    const command = /^c(.+)$/m.exec(output);
    return pid ? { pid: pid[1], command: command ? command[1] : 'process' } : null;
  } catch { return null; }
}

// Startup message for a busy port: who holds it, how to stop it, or another port to use.
function portInUseLines(host, port, owner) {
  const lines = ['Port is already in use: ' + host + ':' + port];
  if (owner) {
    lines.push('Used by: ' + owner.command + ' (PID ' + owner.pid + ')');
    lines.push('Stop it: ' + (process.platform === 'win32'
      ? 'taskkill /PID ' + owner.pid + ' /F'
      : 'kill ' + owner.pid));
  } else if (process.platform !== 'win32') {
    lines.push('Find the process: lsof -nP -iTCP:' + port + ' -sTCP:LISTEN');
  }
  lines.push('Or choose another port: pico-bay --port ' + (port + 1));
  lines.push('From this source folder: npm start -- --port ' + (port + 1));
  return lines;
}

// The addresses to print at startup: localhost, the given host, or every LAN IPv4
// address when listening on all interfaces.
function startupUrls(host, port, interfaces = os.networkInterfaces()) {
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (loopback) return ['http://localhost:' + port];
  if (host !== '0.0.0.0' && host !== '::') {
    return ['http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + port];
  }
  const addresses = [];
  for (const entries of Object.values(interfaces || {})) {
    for (const entry of entries || []) {
      if ((entry.family === 'IPv4' || entry.family === 4) && !entry.internal) addresses.push(entry.address);
    }
  }
  const unique = [...new Set(addresses)].sort();
  return unique.length
    ? unique.map(address => 'http://' + address + ':' + port)
    : ['http://localhost:' + port];
}

// Starts the web server, prints where it listens, scans once for boards, and opens the
// browser unless that is disabled.
function startServer(options = {}) {
  const server = createServer(options);
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      const owner = findPortOwner(PORT);
      console.error('\n' + portInUseLines(HOST, PORT, owner).join('\n') + '\n');
      process.exitCode = 1;
      return;
    }
    console.error('Could not start pico-bay: ' + String(error.message || error));
    process.exitCode = 1;
  });
  server.listen(PORT, HOST, () => {
  // Print every address the UI can be opened at.
  const actualPort = server.address().port;
  const localAddr = 'http://localhost:' + actualPort;
  const addresses = startupUrls(HOST, actualPort);
  const bar = '-'.repeat(Math.max(...addresses.map(address => address.length)));
  console.log('pico-bay started on → ');
  console.log(bar);
  for (const address of addresses) console.log(address);
  console.log(bar);
  if (options.mcpHttp) console.log('MCP endpoint: ' + addresses[0] + '/mcp');
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    console.log('listening on ' + HOST + '; ensure this interface is trusted');
  }
  // Log the boards present at startup.
  scanDevices().then(logDeviceChanges).catch(e => {
    console.log('device scan failed: ' + String(e.message || e));
  });
  if (shouldOpenBrowser(noOpen, RASPBERRY_PI_HOST)) {
    openBrowser(localAddr);
  }
  });
  return server;
}

// Attempt to resume boards before shutdown.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const port of ports.values()) {
    if (port.fd === null) continue;
    try {
      // Ctrl-C, leave the raw REPL, soft reset: the board's own program starts again.
      fs.writeSync(port.fd, Buffer.from('\r' + CTRL_C + CTRL_B + CTRL_D, 'binary'));
      port._close();
    } catch { /* Board disconnected or unresponsive during shutdown. */ }
  }
  process.exit(0);
}
// Run as a program: one MCP transport at most, then stdio MCP or the web server.
if (require.main === module) {
  if (conflictingMcpFlags) {
    console.error('Do not combine --no-mcp with --mcp-stdio or --mcp-http');
    process.exitCode = 1;
  } else if (mcpStdio && mcpHttp) {
    console.error('Choose one MCP transport: --mcp-stdio or --mcp-http');
    process.exitCode = 1;
  } else if (mcpStdio) {
    runMcpStdio();
  } else {
    startServer({ mcpHttp });
  }
  // Ctrl-C or a service stop resets the boards before exiting.
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Exported for the test suite.
module.exports = {
  hostAllowed,
  ctrlpiInstallFiles,
  ctrlpiMainError,
  validateUf2Image,
  espSlipEncode,
  espSlipDecode,
  espRomCommand,
  detectEspBootloader,
  espFirmwareForChip,
  resolveEspFirmwareUrl,
  downloadEspFirmware,
  espImageInfo,
  espChecksum,
  espInstallBlock,
  espStorageRange,
  flashEspImage,
  installEspFirmware,
  FIRMWARE_ADAPTERS,
  cleanPath,
  cleanReplOutput,
  createServer,
  crc32,
  createZipBuffer,
  deviceStats,
  initializeEspStorage,
  firmwareAdapter,
  getPort,
  isRaspberryPi,
  listDevs,
  listFiles,
  makeDirectory,
  parseFileList,
  parseDarwinCircuitVolumes,
  parseLinuxCircuitPartitions,
  linuxBlockDevices,
  parseLinuxUnmountedCircuitVolumes,
  parseBootselBlockDevices,
  parseDarwinBootselVolumes,
  bootselFirmwareOptions,
  installBootselFirmware,
  bootOutCircuitVolumes,
  listMountedFiles,
  MCP_TOOLS,
  parseRestoreZip,
  parseProbeOutput,
  parseRaspberryPiThrottle,
  portInUseLines,
  probe,
  readFile,
  renamePath,
  removePath,
  requireWritable,
  scanDevices,
  espResetStrategies,
  enterBootloader,
  rebootEspAfterInstall,
  selectMcpTransports,
  shouldOpenBrowser,
  startupUrls,
  simpleOp,
  dispatchMcp,
  handleMcpHttp,
  writeFile,
  _test: {
    mountedPath,
    winResetEspLines,
    resetEspLines,
    initializeEspFlashStorage,
    clearDevices() {
      ports.clear();
      espInstalls.clear();
      deviceListOverride = null;
      circuitVolumeOverride = null;
      circuitVolumePromise = null;
      bootselDeviceOverride = null;
      bootselInstallOverride = null;
      espInstallOverride = null;
    },
    setBootselDevices(entries) { bootselDeviceOverride = entries; },
    setBootselInstaller(handler) { bootselInstallOverride = handler; },
    setEspInstaller(handler) { espInstallOverride = handler; },
    setCircuitVolumes(entries) { circuitVolumeOverride = new Map(entries); },
    setDevices(entries) {
      ports.clear();
      deviceListOverride = entries.map(entry => entry.dev);
      for (const entry of entries) ports.set(entry.dev, entry.port);
    },
  },
};
