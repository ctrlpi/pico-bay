#!/usr/bin/env node
'use strict';

/* Manage Raspberry Pi Pico and ESP32 boards with MicroPython or CircuitPython over USB. */

// Set before async filesystem work starts.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '12';

const http = require('http');
const https = require('https');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');

let winSerialHelperPath = null;
if (process.platform === 'win32') {
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
  --no-open           Do not open a browser
  --mcp-stdio         Run MCP over stdio
  --mcp-http          Enable MCP over HTTP
  --no-mcp            Disable MCP
  --help              Show this help
  --version           Show the version`);
  process.exit(0);
}
let portArg = null;
let holdArg = null;
let hostArg = null;
let noOpen = envEnabled(process.env.PICO_NO_OPEN);
let cliMcpStdio = false;
let cliMcpHttp = false;
let cliNoMcp = envEnabled(process.env.PICO_NO_MCP);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') portArg = args[++i];
  else if (args[i] === '--hold') holdArg = args[++i];
  else if (args[i] === '--host') hostArg = args[++i];
  else if (args[i] === '--no-open') noOpen = true;
  else if (args[i] === '--mcp-stdio') cliMcpStdio = true;
  else if (args[i] === '--mcp-http') cliMcpHttp = true;
  else if (args[i] === '--no-mcp') cliNoMcp = true;
}
const PORT = parseInt(portArg || process.env.PICO_PORT || '7426', 10);
const RASPBERRY_PI_HOST = isRaspberryPi();
const HOST = hostArg || process.env.PICO_HOST || (RASPBERRY_PI_HOST ? '0.0.0.0' : '127.0.0.1');

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
const conflictingMcpFlags = cliNoMcp && (cliMcpStdio || cliMcpHttp);

// Delay before leaving raw REPL and restarting main.py. Zero resets immediately.
const HOLD_MS = parseInt(holdArg || process.env.PICO_HOLD_MS || '900', 10);
const README = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
const LICENSE = fs.readFileSync(path.join(__dirname, 'LICENSE'), 'utf8');
const SERVER_INSTANCE = process.pid + '-' + Date.now();
const USB_AUTOMOUNT_SETUP_AVAILABLE = fs.existsSync(path.join(__dirname, 'usb-automount.sh'));
const PAGE = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8')
  .split('{{VERSION}}').join(VERSION);

// macOS callout devices open without waiting for carrier detect.
const DEV_DIR = '/dev';
const STTY_FLAG = process.platform === 'darwin' ? '-f' : '-F';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const execFileText = (file, argv, options = {}) => new Promise((resolve, reject) => {
  execFile(file, argv, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
});

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

async function winResetEspLines(winPort, mode) {
  if (!winPort || !winPort.winPortControl) throw new Error('Serial control pipe is unavailable');
  const delay = mode.endsWith('-slow') ? 550 : 50;
  const set = (dtr, rts) => new Promise((resolve, reject) => {
    const control = winPort.winPortControl;
    if (!control || control.destroyed) return reject(new Error('Serial control pipe is unavailable'));
    control.write(`dtr:${dtr ? '1' : '0'}\nrts:${rts ? '1' : '0'}\n`, error => error ? reject(error) : resolve());
  });
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

function isRaspberryPi(platform = process.platform, model = null) {
  if (platform !== 'linux') return false;
  if (model === null) {
    try { model = fs.readFileSync('/proc/device-tree/model', 'utf8'); }
    catch { return false; }
  }
  return /raspberry pi/i.test(String(model));
}

function shouldOpenBrowser(disabled, raspberryPiHost) {
  return !disabled && !raspberryPiHost;
}

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
  async _waitForClose(timeout = 1500) {
    const deadline = Date.now() + timeout;
    while (this.closing && Date.now() < deadline) await sleep(20);
    if (this.closing) throw new Error('USB serial port is still closing. Reconnect the board, then Scan.');
  }

  async _open() {
    if (this.fd !== null || this.winPort !== null) return;
    if (this.closing) throw new Error('USB serial port is still closing. Reconnect the board, then Scan.');
    try {
      this.connectionGeneration++;
      if (process.platform === 'win32') {
        const generation = this.connectionGeneration;
        this.winPortPipeBase = 'picobay_' + crypto.randomBytes(8).toString('hex');
        this.winPortPipe = '\\\\.\\pipe\\' + this.winPortPipeBase;
        const srv = require('net').createServer();
        this.winPortServer = srv;
        await new Promise((resolve, reject) => {
          const fail = error => {
            clearTimeout(timer);
            if (generation === this.connectionGeneration) {
              this._disconnected();
              this._emit('sys', '— board disconnected —\n');
            }
            reject(error);
          };
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
          this._emit('sys', '— board disconnected —\n');
          break;
        }
        if (generation === this.connectionGeneration && n > 0) this._onData(buf.subarray(0, n).toString('binary'));
      }
    } finally {
      this.pumping = false;
    }
  }

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

  readUntil(needle, timeoutMs = 10000, onChunk = null) {
    return this._read({ needle }, timeoutMs, onChunk);
  }

  readN(want, timeoutMs = 5000) {
    return this._read({ want }, timeoutMs, null);
  }

  // Retry until startup code becomes interruptible.
  async _enterRaw(budgetMs = 8000) {
    const deadline = Date.now() + budgetMs;
    let lastErr;
    do {
      try {
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
    await this.readUntil('\x04', 10000);   // end-of-data acknowledgement
    return true;
  }

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
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  _cancelIdle() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

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

  releaseNow() {
    const next = this.chain.then(() => this._release(true), () => this._release(true));
    this.chain = next.catch(() => {});
    return next;
  }

  async addMonitor(fn) {
    await this._waitForClose();
    await this._open();
    this.monitors.add(fn);
  }
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

function firmwareAdapter(name) {
  return FIRMWARE_ADAPTERS[name] || FIRMWARE_ADAPTERS.unknown;
}

function cleanReplOutput(text) {
  return String(text)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function parseProbeOutput(out) {
  const values = {};
  for (const line of cleanReplOutput(out).split(/\r?\n/)) {
    const m = /PVI_(IMPL|MACHINE|RELEASE|UID)\s+(.*)$/.exec(line);
    if (m) values[m[1].toLowerCase()] = m[2].trim();
  }
  return values;
}

function listDevs(platform = process.platform) {
  if (deviceListOverride) return [...deviceListOverride];
  if (platform === 'win32') {
    try {
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

function deviceIdentity(dev) {
  try {
    const stat = fs.statSync(dev);
    return String(stat.ino) + ':' + String(stat.rdev);
  } catch {
    return process.platform === 'win32' && /^COM\d+$/i.test(dev) ? dev : null;
  }
}

function getPort(dev) {
  if (!ports.has(dev)) ports.set(dev, new PicoPort(dev));
  return ports.get(dev);
}

// Espressif ROM serial protocol. Detection uses only read-only commands; the
// flash commands below are reached only by an explicitly confirmed install.
// https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/serial-protocol.html
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

const ESP_ROM_COMMANDS = new Set([0x02, 0x03, 0x04, 0x08, 0x0a, 0x0b, 0x0d, 0x10, 0x11, 0x12, 0x13, 0x14]);

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
    if (frame.length > 4096) throw new Error('Oversized ESP response');
    let reply;
    try { reply = espSlipDecode(Buffer.from(frame.slice(0, -1), 'binary')); }
    catch { continue; }
    if (reply.length < 10 || reply[0] !== 1 || reply[1] !== opcode) continue;
    const size = reply.readUInt16LE(2);
    if (reply.length !== 8 + size || size < 2) continue;
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

async function detectEspBootloader(port) {
  port.rx = '';
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
      const magic = await readReg(0x40001000);
      details.magic = '0x' + magic.toString(16).padStart(8, '0');
      chip = ({ [0x00f01d83]: 'ESP32', [0x000007c6]: 'ESP32-S2' })[magic] || null;
    } catch { /* Restricted ROMs can deny register reads. */ }
  }
  if (chip === 'ESP32') {
    try {
      const low = await readReg(0x3ff5a004);
      const high = await readReg(0x3ff5a008);
      const mac = Buffer.alloc(6);
      mac.writeUInt16BE(high & 0xffff, 0);
      mac.writeUInt32BE(low, 2);
      details.mac = [...mac].map(byte => byte.toString(16).padStart(2, '0')).join(':');
    } catch { /* Keep the confirmed chip even if optional identity is unavailable. */ }
    try {
      const security0 = await readReg(0x3ff5a000);
      const security6 = await readReg(0x3ff5a018);
      const cryptCount = (security0 >>> 20) & 0x7f;
      details.flashCryptCount = cryptCount;
      details.flashEncryption = (cryptCount.toString(2).replace(/0/g, '').length & 1) === 1;
      details.secureBoot = !!(security6 & 0x30);
      details.securityChecked = true;
    } catch { /* Security registers are best-effort during identification. */ }
  }
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

async function probeDetails(port, firmware, attempts = 6) {
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
  if (Date.now() < (p.rebootingUntil || 0)) await sleep(p.rebootingUntil - Date.now());
  if (p.info) return p.info;
  if (p.probePromise) return p.probePromise;
  if (p.probeFailure && Date.now() < p.probeFailure.retryAt) throw p.probeFailure.error;
  const oldFailure = p.probeFailure;
  p.probeFailure = null;
  const identify = async () => {
    const detected = await probeRecord(
      p,
      'IMPL',
      "import sys;print('PVI_IMPL',getattr(sys.implementation,'name','micropython'))",
      1,
    );
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

const loggedDevices = new Map();
let loggedNoDevices = false;

async function scanDevices({ waitForProbes = true } = {}) {
  const devs = listDevs();
  const bootDevices = deviceListOverride ? Promise.resolve(bootselDeviceOverride || []) : bootselDevices();
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
  return serialDevices.concat(await bootDevices)
    .sort((a, b) => Number(!!a.bootMode) - Number(!!b.bootMode) ||
      String(a.label || a.machine || a.dev).localeCompare(String(b.label || b.machine || b.dev)) ||
      String(a.dev).localeCompare(String(b.dev)));
}

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

function pyError(err) {
  const lines = cleanReplOutput(err).trim().split(/\r?\n/).filter(l => l.trim());
  return lines.length ? lines[lines.length - 1].trim() : 'Board reported an error';
}

const pyStr = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

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

let circuitVolumeCache = { expires: 0, volumes: new Map() };
let circuitVolumeOverride = null; // test seam
let circuitVolumePromise = null;
let unmountedCircuitVolumes = new Map();
let bootselDeviceOverride = null;
let bootselInstallOverride = null;
let espInstallOverride = null;

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

function blockMountpoints(device) {
  return (Array.isArray(device.mountpoints) ? device.mountpoints : [device.mountpoint]).filter(Boolean);
}

async function linuxBlockDevices(run = execFileText) {
  // Newly attached USB disks can exist before udev has populated LABEL/SERIAL.
  // Bound the wait and still scan if udevadm is missing or its queue is busy.
  await run('udevadm', ['settle', '--timeout=2'], { timeout: 2500 }).catch(() => {});
  return run('lsblk', [
    '--json', '--paths', '--tree', '--output', 'PATH,PKNAME,LABEL,FSTYPE,SERIAL,MOUNTPOINT',
  ], { timeout: 3000 });
}

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

let bootselDiscoveryError = '';
async function bootselDevices() {
  if (bootselDeviceOverride) return bootselDeviceOverride;
  if (process.platform === 'win32') {
    try {
      const fsutil = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'fsutil.exe') : 'fsutil';
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
      return parseDarwinBootselVolumes(await execFileText('mount', [], { timeout: 2000 }));
    } catch { return []; }
  }
  return [];
}

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

function espFirmwareForChip(chip) {
  const firmware = ESP_FIRMWARE[chip];
  return firmware ? { ...firmware } : null;
}

function resolveEspFirmwareUrl(firmware, pageHtml) {
  const links = [...String(pageHtml).matchAll(/href=["']([^"']+\.bin)["']/gi)]
    .map(match => new URL(match[1], firmware.page))
    .filter(url => url.hostname === 'micropython.org' &&
      path.posix.basename(url.pathname).startsWith(firmware.build + '-') &&
      !url.pathname.endsWith('.app-bin'));
  if (!links.length) throw new Error('Could not find the latest MicroPython .bin download');
  return links[0].href;
}

async function downloadEspFirmware(firmware, download = downloadFirmware) {
  const page = await download(firmware.page);
  const url = resolveEspFirmwareUrl(firmware, page.toString('utf8'));
  return download(url);
}

function espImageInfo(image, expectedChipId) {
  if (!Buffer.isBuffer(image) || image.length < 48 || image.length > 8 * 1024 * 1024) {
    throw new Error('Downloaded ESP firmware has an invalid size');
  }
  if (image[0] !== 0xe9) throw new Error('Downloaded file is not an ESP firmware image');
  const segmentCount = image[1];
  if (!segmentCount || segmentCount > 16) throw new Error('ESP firmware has an invalid segment count');
  const chipId = image.readUInt16LE(12);
  if (chipId !== expectedChipId) {
    throw new Error('Downloaded firmware is for a different ESP32 chip');
  }
  let checksum = 0xef;
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
  const hasSha256 = image[23] === 1;
  if (hasSha256) {
    const digestOffset = checksumOffset + 1;
    if (digestOffset + 32 > image.length ||
        !crypto.createHash('sha256').update(image.subarray(0, digestOffset)).digest()
          .equals(image.subarray(digestOffset, digestOffset + 32))) {
      throw new Error('ESP firmware SHA-256 digest is invalid');
    }
  }
  const flashSizeCode = image[3] >> 4;
  const flashSize = ({ 0: 1, 1: 2, 2: 4, 3: 8, 4: 16, 5: 32, 6: 64, 7: 128 })[flashSizeCode];
  return { chipId, segmentCount, flashSize: flashSize ? flashSize * 1024 * 1024 : null, hasSha256 };
}

function espWords(...values) {
  const data = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => data.writeUInt32LE(value >>> 0, index * 4));
  return data;
}

function espChecksum(data) {
  let checksum = 0xef;
  for (const byte of data) checksum ^= byte;
  return checksum;
}

function espInstallBlock(data, sequence) {
  return Buffer.concat([espWords(data.length, sequence, 0, 0), data]);
}

function espStorageRange(image, firmware, flashSize) {
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

async function initializeEspFlashStorage(port, device, firmware, image, flashSize, onProgress) {
  const storage = espStorageRange(image, firmware, flashSize);
  if (!storage) throw new Error('Could not locate the ESP32 filesystem region in this firmware image');
  onProgress({ stage: 'initializing', percent: 0 });
  const blockSize = 0x400;
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
  await espRomCommand(port, 0x0d, espWords(0, 0), 3000);
  await espRomCommand(port, 0x0b, espWords(0, flashSize, 0x10000, 0x1000, 0x100, 0xffff), 3000);
  let storage = null;
  if (options.initializeStorage && !espStorageRange(image, firmware, flashSize)) {
    throw new Error('Could not locate the ESP32 filesystem region in this firmware image');
  }
  const begin = espWords(image.length, blocks, blockSize, firmware.offset);
  const beginData = device.machine === 'ESP32' ? begin : Buffer.concat([begin, espWords(0)]);
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
        ' — firmware block ' + (sequence + 1) + '/' + blocks +
        ', flash address ' + address + ', after 2 attempts', { cause: lastError });
    }
    onProgress({ stage: 'writing', percent: Math.round(((sequence + 1) / blocks) * 100) });
  }

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

async function rebootEspAfterInstall(port, device, resetLines = resetEspLines) {
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

async function installEspFirmware(dev, download = downloadFirmware, onProgress = () => {}, options = {}) {
  if (!dev || !listDevs().includes(dev)) throw new Error('ESP32 is no longer connected');
  if (espInstalls.has(dev)) throw new Error('An ESP32 installation is already running on this port');
  espInstalls.add(dev);
  try {
    const port = getPort(dev);
    const device = port.info || await probe(dev);
    const firmware = assertEspInstallAllowed(device);
    onProgress({ stage: 'downloading', percent: 0 });
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

function bootselFirmwareOptions(chip) {
  return Object.entries(BOOTSEL_FIRMWARE)
    .filter(([, firmware]) => firmware.chip === chip)
    .map(([id, firmware]) => ({ id, name: firmware.name }));
}

function downloadFirmware(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
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

function validateUf2Image(image, chip) {
  const families = chip === 'RP2040' ? [0xe48bff56] :
    chip === 'RP2350' ? [0xe48bff59, 0xe48bff5a, 0xe48bff5b] : [];
  const invalid = reason => { throw new Error('Invalid UF2 image: ' + reason); };
  if (!families.length) invalid('unsupported chip');
  if (!Buffer.isBuffer(image) || !image.length || image.length > 8 * 1024 * 1024 || image.length % 512) {
    invalid('size must be a nonzero multiple of 512 bytes, up to 8 MB');
  }
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
  await fs.promises.writeFile(path.join(root, firmware.filename), image);
  onProgress({ stage: 'rebooting', percent: 100 });
  return { ok: true, firmware: firmware.name, bytes: image.length };
}

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

async function circuitVolumes() {
  if (circuitVolumeOverride) return circuitVolumeOverride;
  if (Date.now() < circuitVolumeCache.expires) return circuitVolumeCache.volumes;
  if (!circuitVolumePromise) circuitVolumePromise = (async () => {
    await autoMountCircuitPartitions();
    const roots = circuitMountCandidates();
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

async function circuitRootForInfo(info) {
  if (info.firmware !== 'circuitpython' || !info.uid) return null;
  const root = (await circuitVolumes()).get(info.uid.toLowerCase());
  if (!root) return null;
  try { return fs.statSync(root).isDirectory() ? root : null; }
  catch { return null; }
}

async function mountedCircuitRoot(dev) {
  return circuitRootForInfo(await probe(dev));
}

function mountedRootWritable(root) {
  try {
    fs.accessSync(root, fs.constants.W_OK);
    return true;
  } catch { return false; }
}

function mountedPath(root, devicePath, pathApi = path) {
  const clean = cleanPath(devicePath);
  if (!clean) return null;
  // Windows normalizes trailing dots/spaces and interprets colons as drive/stream syntax.
  if (pathApi.sep === '\\' && clean.split('/').some(part => /:|[. ]$/.test(part))) return null;
  const resolvedRoot = pathApi.resolve(root);
  const target = pathApi.resolve(root, ...clean.split('/'));
  const prefix = resolvedRoot.endsWith(pathApi.sep) ? resolvedRoot : resolvedRoot + pathApi.sep;
  return target !== resolvedRoot && target.startsWith(prefix) ? target : null;
}

function listMountedFiles(root, includeSystemFiles = false) {
  const files = [];
  function walk(relative, depth) {
    const directory = relative ? mountedPath(root, relative) : root;
    if (!directory) return;
    let names;
    try { names = fs.readdirSync(directory).sort(); } catch { return; }
    for (const name of names) {
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

function listCode(includeSystemFiles) {
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

async function deviceStats(dev) {
  const p = getPort(dev);
  const { out, err } = await p.command(port => port.exec([
    'import os, gc',
    'gc.collect()',
    "s = os.statvfs('/')",
    "print('PVS', s[0] * s[2], s[0] * s[3], gc.mem_free(), gc.mem_alloc())",
  ].join('\n'), { timeout: 8000 }));
  if (err.trim()) throw new Error(pyError(err));
  const m = /PVS\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(cleanReplOutput(out));
  if (!m) throw new Error('Could not read device storage statistics');
  const [total, free, memFree, memAlloc] = m.slice(1).map(Number);
  return { fsTotal: total, fsFree: free, memFree, memAlloc };
}

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

async function cleanAll(dev) {
  const access = await requireWritable(dev);
  if (access.mode === 'mount') {
    const removed = [];
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
      "for n in os.listdir('/'):",
      '    _rm(n)',
      "    print('removed', n)",
    ].join('\n'), { timeout: 60000 }));
  if (err.trim()) throw new Error(pyError(err));
  return { ok: true, log: out.trim() };
}

async function simpleOp(dev, code, timeout = 15000) {
  const p = getPort(dev);
  const { out, err } = await p.command(port => port.exec(code, { timeout }));
  if (err.trim()) throw new Error(pyError(err));
  return { ok: true, out };
}

function bootloaderMode(info) {
  if (!info || info.bootMode || !['micropython', 'circuitpython'].includes(info.firmware)) return null;
  const model = (info.machine || '') + ' ' + (info.label || '');
  if (/ESP32/i.test(model)) return info.firmware === 'micropython' ? 'download' : null;
  return /RP2040|RP2350|Raspberry Pi Pico/i.test(model) ? 'bootsel' : null;
}

function espResetStrategies(info, dev) {
  const serial = ['tight', 'tight-slow', 'classic', 'classic-slow'];
  // Windows COM names do not distinguish native USB from UART bridges.
  // Try native USB on C3/S3 COM ports, retaining the UART fallbacks.
  return /ESP32-?[CS]3/i.test(info.machine || '') && /(?:usbmodem|ttyACM|^COM\d+$)/i.test(dev)
    ? ['usb-jtag', ...serial] : serial;
}

async function enterBootloader(dev) {
  const info = await probe(dev);
  const mode = bootloaderMode(info);
  if (!mode) throw new Error('Firmware install mode is unavailable for this board');
  if (mode === 'download') {
    const port = getPort(dev);
    return port.command(async active => {
      const reset = mode => process.platform === 'win32' && active.winPort ?
        winResetEspLines(active, mode) : resetEspLines(active.fd, mode);
      // Reset invalidates the raw REPL halt state; cleanup must not soft-reset
      // a newly entered ROM loader.
      active.halted = false;
      try {
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
        await reset('normal').catch(() => {});
        active.info = null;
        active.probeFailure = null;
        return { ok: false, manual: true, reason: String(error.message || error) };
      }
    }, { rawRepl: false });
  }
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
      '        if e.args[0] != 17:',
      '            raise',
    ].join('\n'));
    if (err.trim()) throw new Error(pyError(err));
    return { ok: true };
  });
}

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

async function runPython(dev, options = {}) {
  const info = await probe(dev);
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

  port._emit('sys', banner);
  const result = await port.command(async (pt) => {
    let carried = '';
    return pt.exec(code, {
      timeout: 10 * 60 * 1000,
      onChunk: (chunk) => { carried += chunk; port._emit('out', chunk); },
    }).then(r => { r.streamed = carried; return r; });
  });
  if (result.out && result.out.length > (result.streamed ? result.streamed.length : 0)) {
    port._emit('out', result.out.slice(result.streamed ? result.streamed.length : 0));
  }
  if (result.err.trim()) port._emit('err', result.err);
  port._emit('sys', '— finished —\n');
  return { ok: !result.err.trim(), out: result.out, err: result.err };
}

async function interruptBoard(dev) {
  const port = getPort(dev);
  if (port.fd !== null || port.winPort) await port.write('\r' + CTRL_C + CTRL_C);
  port._emit('sys', '— interrupt sent —\n');
  return { ok: true };
}

async function resetBoard(dev, hard = false) {
  const port = getPort(dev);
  if (hard) {
    const info = await probe(dev);
    const adapter = firmwareAdapter(info.firmware);
    if (!adapter.hardResetCode) throw new Error('Hard reset is not supported for this firmware');
    port.command(pt => pt.exec(adapter.hardResetCode, { timeout: 1500 })).catch(() => {});
    setTimeout(() => { port._close(); ports.delete(dev); }, 500);
    port._emit('sys', '— hard reset —\n');
    return { ok: true, hard: true };
  }
  await port.command(async () => {});
  await port.releaseNow();
  port._emit('sys', '— soft reset, program restarted —\n');
  return { ok: true };
}

// ── Console subscribers (Server-Sent Events) ────────────────────────────────
async function attachConsole(dev, res) {
  const p = getPort(dev);
  const send = (type, text) => {
    try { res.write('data: ' + JSON.stringify({ type, text }) + '\n\n'); } catch { /* gone */ }
  };
  await p.addMonitor(send);
  if (res.destroyed) { p.removeMonitor(send); return; }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  send('sys', '— attached to ' + dev + ' —\n');
  const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* gone */ } }, 15000);
  const done = () => { clearInterval(ka); p.removeMonitor(send); };
  res.on('close', done);
  res.on('error', done);
}

// ── ZIP creation (uncompressed Store ZIP format) ─────────────────────────
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
    chdr.writeUInt32LE(0x81a40000, 38);
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
    if (flags & 1) throw new Error('Encrypted ZIP files are not supported');
    if (method !== 0 && method !== 8) throw new Error('Unsupported ZIP compression method: ' + method);
    if (method === 0 && compressedSize !== size) throw new Error('Invalid stored ZIP entry');
    if (size > 16 * 1024 * 1024 - total) throw new Error('ZIP contents exceed 16 MiB');
    const rawName = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    at += 46 + nameLen + extraLen + commentLen;
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
const sendJSON = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

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
const MCP_PROTOCOL = '2026-07-28';
const MCP_LEGACY_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const MCP_SERVER_INFO = { name: 'pico-bay', version: VERSION };
const MCP_CAPABILITIES = { tools: { listChanged: false } };
const MCP_MAX_BODY = 12 * 1024 * 1024;

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

function booleanArg(args, name, defaultValue = false) {
  if (args[name] === undefined) return defaultValue;
  if (typeof args[name] !== 'boolean') throw new Error(name + ' must be a boolean');
  return args[name];
}

function cleanToolPath(args, name) {
  const value = cleanPath(stringArg(args, name));
  if (!value) throw new Error('Bad path: ' + name);
  return value;
}

function boardRecord(device) {
  const record = {
    board_id: device.uid || device.dev,
    device: device.dev,
    connected: true,
    ok: device.ok,
    firmware: device.firmware || null,
    firmware_label: device.firmwareLabel || null,
    model: device.machine || device.label || null,
    version: device.release || null,
    uid: device.uid || null,
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

async function resolveBootselBoardId(boardId) {
  const wanted = String(boardId || '');
  if (!wanted) throw new Error('board_id must be a non-empty string');
  const matches = (await bootselDevices())
    .filter(device => device.dev === wanted || (device.uid && device.uid === wanted));
  if (!matches.length) throw new Error('BOOTSEL board not connected: ' + wanted);
  if (matches.length > 1) throw new Error('Ambiguous board_id: ' + wanted);
  return matches[0];
}

async function checkBootselInstall(boardId, firmware) {
  if (firmware !== 'micropython') throw new Error('Unsupported firmware: ' + firmware);
  const device = await resolveBootselBoardId(boardId);
  let root = device.mountRoot;
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
  const models = bootselFirmwareOptions(device.machine).map(option => ({
    wifi: / W$/.test(option.name), name: option.name,
  }));
  if (!models.length) throw new Error('Unsupported BOOTSEL chip: ' + device.machine);
  return {
    status: 'ready', firmware, chip: device.machine, mounted: true,
    question: 'Is this a W model with Wi-Fi?', models,
  };
}

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

async function checkEspInstall(boardId, firmware) {
  if (firmware !== 'micropython') throw new Error('Unsupported firmware: ' + firmware);
  const device = await resolveEspDownloadBoardId(boardId);
  const selected = assertEspInstallAllowed(device);
  return {
    status: 'ready', firmware, chip: device.machine, bootloader: 'esp-rom',
    model: selected.name, build: selected.build, address: selected.offset,
  };
}

function micropythonFirmwareId(chip, wifi) {
  if (chip === 'RP2040') return wifi ? 'pico-w' : 'pico';
  if (chip === 'RP2350') return wifi ? 'pico2-w' : 'pico2';
  throw new Error('Unsupported BOOTSEL chip: ' + chip);
}

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

function decodeMcpContent(content, encoding) {
  if (encoding === 'utf8') return Buffer.from(content, 'utf8');
  if (content.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
    throw new Error('content is not valid base64');
  }
  return Buffer.from(content, 'base64');
}

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

const MCP_TOOLS = [
  {
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
      try { bootselDevice = await resolveBootselBoardId(boardId); }
      catch { /* The requested board may be an ESP serial bootloader. */ }
      const readiness = bootselDevice
        ? await checkBootselInstall(boardId, firmware)
        : await checkEspInstall(boardId, firmware);
      if (action === 'check' || readiness.status !== 'ready') {
        return mcpToolResult({ board_id: boardId, ...readiness });
      }
      if (args.confirmed !== true) throw new Error('confirmed must be true after explicit user confirmation');
      if (readiness.bootloader === 'esp-rom') {
        const device = await resolveEspDownloadBoardId(boardId);
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
      if (args.wifi === undefined) throw new Error('wifi is required for Pico action install');
      const wifi = booleanArg(args, 'wifi');
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
      const files = await listFiles(dev, booleanArg(args, 'include_system'));
      const stats = await deviceStats(dev).catch(() => null);
      return mcpToolResult({ board_id: args.board_id, files, stats });
    },
  },
  {
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
      const buf = decodeMcpContent(content, encoding);
      if (buf.length > 8 * 1024 * 1024) throw new Error('content exceeds the 8 MB write limit');
      const result = await writeFile(dev, file, buf);
      return mcpToolResult({ board_id: args.board_id, path: file, ...result });
    },
  },
  {
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
      const mode = stringArg(args, 'mode', { optional: true, values: ['soft', 'hard'] }) || 'soft';
      return mcpToolResult({ board_id: args.board_id, mode, ...await resetBoard(dev, mode === 'hard') });
    },
  },
];

function modernMcpRequest(msg) {
  return msg && msg.params && msg.params._meta &&
    msg.params._meta['io.modelcontextprotocol/protocolVersion'] === MCP_PROTOCOL;
}

function completeMcpResult(result, modern) {
  if (!modern) return result;
  return {
    resultType: 'complete',
    ...result,
    _meta: { ...(result._meta || {}), 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
  };
}

async function dispatchMcp(msg) {
  const id = msg && msg.id;
  const isRequest = id !== undefined && id !== null;
  const ok = result => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message, data) => ({
    jsonrpc: '2.0', id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });

  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return isRequest ? fail(-32600, 'Invalid Request') : null;
  }
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  const metadata = params._meta && typeof params._meta === 'object' ? params._meta : {};
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
      const tools = MCP_TOOLS
        .filter(tool => tool.name !== 'pico_install')
        .concat(MCP_TOOLS.filter(tool => tool.name === 'pico_install'))
        .map(({ handler, ...tool }) => tool);
      return ok(completeMcpResult({ tools, ttlMs: 300000, cacheScope: 'public' }, modern));
    }
    if (msg.method === 'tools/call') {
      if (typeof params.name !== 'string') return isRequest ? fail(-32602, 'Tool name is required') : null;
      const tool = MCP_TOOLS.find(entry => entry.name === params.name);
      if (!tool) return isRequest ? fail(-32602, 'Unknown tool: ' + params.name) : null;
      let result;
      try {
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

function runMcpStdio() {
  // stdout belongs exclusively to MCP. Redirect incidental informational output to stderr.
  console.log = (...values) => console.error(...values);
  console.info = (...values) => console.error(...values);
  const rl = readline.createInterface({ input: process.stdin });
  const active = new Set();
  let writes = Promise.resolve();
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
  rl.on('close', async () => {
    await Promise.allSettled([...active]);
    await writes;
    shutdown();
  });
}

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

function mcpHttpError(res, status, id, code, message, data) {
  sendJSON(res, status, {
    jsonrpc: '2.0', id: id === undefined ? null : id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

let mcpHttpActive = 0;

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
  const unknownModernMethod = modern && response.error && response.error.code === -32601;
  sendJSON(res, unknownModernMethod ? 404 : 200, response);
}

// ── Routing ─────────────────────────────────────────────────────────────────
function createServer(options = {}) {
  const logDevices = options.logDevices !== false;
  const reportError = (operation, dev, error) => {
    if (mcpStdio || options.logErrors === false) return;
    const machine = ports.get(dev)?.info?.machine;
    const context = [machine, dev].filter(Boolean).join(' · ');
    const line = operation + ' failed: ' + (context ? context + ' · ' : '') +
      String(error.message || error);
    (options.errorLogger || console.error)(line.replace(/[\r\n]+/g, ' '));
  };
  let enableMcp = options.mcpHttp === true;
  const installBootsel = options.installBootsel || installBootselFirmware;
  const installEsp = options.installEsp || installEspFirmware;
  const initializeStorage = options.initializeStorage || initializeEspStorage;
  const bootselJobs = new Map();
  const bootselJobByDevice = new Map();
  const espJobs = new Map();
  const espJobByDevice = new Map();

  const publicInstallJob = job => ({
    id: job.id, dev: job.dev, status: job.status, stage: job.stage,
    percent: job.percent, firmwareId: job.firmwareId || null,
    firmwareName: job.firmwareName || null,
    initializeStorage: !!job.initializeStorage,
    error: job.error || null, result: job.result || null,
  });
  const finishJob = (jobs, jobsByDevice, job) => {
    jobsByDevice.delete(job.dev);
    const cleanup = setTimeout(() => jobs.delete(job.id), 10 * 60 * 1000);
    cleanup.unref?.();
  };
  const startBootselJob = (dev, firmwareId, firmwareName) => {
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
  const startEspJob = (dev, initializeStorage) => {
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

    if (p === '/api/mcp' && req.method === 'POST') {
      if (!['0', '1'].includes(q.enabled)) {
        sendJSON(res, 400, { error: 'enabled must be 0 or 1' });
        return;
      }
      enableMcp = q.enabled === '1';
      sendJSON(res, 200, { enabled: enableMcp });
      return;
    }

    if (p === '/api/bootsel/install' && req.method === 'POST') {
      if (!q.dev) {
        sendJSON(res, 404, { error: 'BOOTSEL device is no longer connected' });
        return;
      }
      const firmware = BOOTSEL_FIRMWARE[q.firmware];
      if (!firmware) {
        sendJSON(res, 400, { error: 'Unknown firmware selection' });
        return;
      }
      sendJSON(res, 202, publicInstallJob(startBootselJob(q.dev, q.firmware, firmware.name)));
      return;
    }

    if (p === '/api/bootsel/install/status' && req.method === 'GET') {
      const job = bootselJobs.get(q.id);
      if (!job) {
        sendJSON(res, 404, { error: 'BOOTSEL installation job was not found' });
        return;
      }
      sendJSON(res, 200, publicInstallJob(job));
      return;
    }

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
      const job = espJobs.get(q.id);
      if (!job) {
        sendJSON(res, 404, { error: 'ESP32 installation job was not found' });
        return;
      }
      sendJSON(res, 200, publicInstallJob(job));
      return;
    }

    if (p === '/api/console') {
      const dev = q.dev;
      if (!dev || !listDevs().includes(dev)) { res.writeHead(404); res.end(); return; }
      await attachConsole(dev, res);
      return;
    }

    // Everything below needs a live board.
    const dev = q.dev;
    if (p.startsWith('/api/')) {
      if (!dev || !listDevs().includes(dev)) { sendJSON(res, 404, { error: 'Board not connected' }); return; }
    }

    if (p === '/api/files') {
      const [files, stats] = [await listFiles(dev, q.system === '1'), await deviceStats(dev).catch(() => null)];
      sendJSON(res, 200, { files, stats });
      return;
    }

    if (p === '/api/storage/initialize' && req.method === 'POST') {
      if (q.confirmed !== '1') {
        sendJSON(res, 400, { error: 'Storage initialization must be confirmed' });
        return;
      }
      sendJSON(res, 200, await initializeStorage(dev));
      return;
    }

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

    if (p === '/api/file' && (req.method === 'PUT' || req.method === 'POST')) {
      await requireWritable(dev);
      const file = cleanPath(q.path);
      if (!file) { sendJSON(res, 400, { error: 'Bad path' }); return; }
      const body = await readBody(req);
      sendJSON(res, 200, await writeFile(dev, file, body));
      return;
    }

    if (p === '/api/file' && req.method === 'DELETE') {
      await requireWritable(dev);
      const file = cleanPath(q.path);
      if (!file) { sendJSON(res, 400, { error: 'Bad path' }); return; }
      sendJSON(res, 200, await removePath(dev, file));
      return;
    }

    if (p === '/api/mkdir' && req.method === 'POST') {
      await requireWritable(dev);
      const file = cleanPath(q.path);
      if (!file) { sendJSON(res, 400, { error: 'Bad path' }); return; }
      sendJSON(res, 200, await makeDirectory(dev, file));
      return;
    }

    if (p === '/api/touch' && req.method === 'POST') {
      await requireWritable(dev);
      const file = cleanPath(q.path);
      if (!file) { sendJSON(res, 400, { error: 'Bad path' }); return; }
      sendJSON(res, 200, await writeFile(dev, file, Buffer.alloc(0)));
      return;
    }

    if (p === '/api/rename' && req.method === 'POST') {
      await requireWritable(dev);
      const from = cleanPath(q.path), to = cleanPath(q.to);
      if (!from || !to) { sendJSON(res, 400, { error: 'Bad path' }); return; }
      sendJSON(res, 200, await renamePath(dev, from, to));
      return;
    }

    if (p === '/api/zip' || p === '/api/download-all') {
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

    if (p === '/api/restore' && req.method === 'POST') {
      await requireWritable(dev);
      const entries = parseRestoreZip(await readBody(req, 16 * 1024 * 1024));
      const restored = [];
      for (const entry of entries) {
        await writeFile(dev, entry.path, entry.content);
        restored.push(entry.path);
      }
      sendJSON(res, 200, { ok: true, restored: restored.length, files: restored });
      return;
    }

    if (p === '/api/clean' && req.method === 'POST') {
      await requireWritable(dev);
      sendJSON(res, 200, await cleanAll(dev));
      return;
    }

    if (p === '/api/run' && req.method === 'POST') {
      const options = q.path
        ? { path: q.path }
        : { code: (await readBody(req)).toString('utf8') };
      sendJSON(res, 200, await runPython(dev, options));
      return;
    }

    if (p === '/api/interrupt' && req.method === 'POST') {
      sendJSON(res, 200, await interruptBoard(dev));
      return;
    }

    if (p === '/api/ctrlpi/install' && req.method === 'POST') {
      await requireWritable(dev);
      const body = JSON.parse(await readBody(req));
      
      const configJson = `{\n  "api_key": "${body.key}",\n  "name": "${body.name || ''}"\n}`;
      const wifiTxt = `SSID = ${body.ssid}\nPASSWORD = ${body.pass}\n`;
      const cpuTempScript = `# CPU temperature in degrees Celsius, as a bare number (e.g. 23.4), not JSON.
# Use it as a sensor: POST /sensor/config/cpu_temp {"script": "cpu-temp.py"}
import machine

def read():
    v = machine.ADC(4).read_u16() * 3.3 / 65535
    return round(27 - (v - 0.706) / 0.001721, 1)
`;

      const response = await fetch('https://npm.ctrlpi.com/ctrlpi/pico-gpio-api/main.py');
      if (!response.ok) throw new Error('Failed to download main.py from server (HTTP ' + response.status + ')');
      const mainPy = await response.text();

      await writeFile(dev, 'main.py', Buffer.from(mainPy));
      await writeFile(dev, 'config.json', Buffer.from(configJson));
      await writeFile(dev, 'wifi.txt', Buffer.from(wifiTxt));
      
      try {
        await mkdir(dev, 'scripts');
      } catch(e) {}
      await writeFile(dev, 'scripts/cpu-temp.py', Buffer.from(cpuTempScript));
      
      await resetBoard(dev, false);
      sendJSON(res, 200, { ok: true });
      return;
    }

    if (p === '/api/reset' && req.method === 'POST') {
      sendJSON(res, 200, await resetBoard(dev, q.hard === '1'));
      return;
    }

    if (p === '/api/bootloader' && req.method === 'POST') {
      sendJSON(res, 200, await enterBootloader(dev));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    if (p !== '/mcp') reportError(req.method + ' ' + p, q.dev, e);
    if (!res.headersSent) sendJSON(res, 500, { error: String(e.message || e) });
    else try { res.end(); } catch { /* already closed */ }
  }
  });
}

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
    console.log('listening on ' + HOST + ' — ensure this interface is trusted');
  }
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
      fs.writeSync(port.fd, Buffer.from('\r' + CTRL_C + CTRL_B + CTRL_D, 'binary'));
      port._close();
    } catch { /* Board disconnected or unresponsive during shutdown. */ }
  }
  process.exit(0);
}
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
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = {
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
