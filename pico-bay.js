#!/usr/bin/env node
'use strict';

/* Browse MicroPython and CircuitPython boards over USB. */

// Set before async filesystem work starts.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '12';

const http = require('http');
const https = require('https');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');
const { execFile, execFileSync } = require('child_process');

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
const DEV_MATCH = process.platform === 'darwin'
  ? /^cu\.usbmodem/
  : /^ttyACM|^ttyUSB/;
const STTY_FLAG = process.platform === 'darwin' ? '-f' : '-F';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const execFileText = (file, argv, options = {}) => new Promise((resolve, reject) => {
  execFile(file, argv, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
});

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
    this.chain = Promise.resolve();
    this.rx = '';           // bytes received during a command, not yet consumed
    this.inCommand = false;
    this.capture = null;    // in-flight readUntil, if any
    this.monitors = new Set();
    this.pumping = false;
    this.info = null;       // cached probe result
    this.probePromise = null; // coalesces overlapping hot-plug polls
    this.busy = false;
    this.halted = false;    // true while the board sits in the raw REPL
    this.idleTimer = null;
  }

  // ── Port lifecycle ──
  _open() {
    if (this.fd !== null) return;
    try {
      this.fd = fs.openSync(this.dev, fs.constants.O_RDWR | fs.constants.O_NOCTTY);
      // Return reads after 100 ms instead of blocking indefinitely.
      execFileSync('stty', [STTY_FLAG, this.dev, 'raw', '-echo', '115200', 'min', '0', 'time', '1'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch (error) {
      this._disconnected();
      const failure = new Error('Board disconnected: ' + this.dev);
      failure.code = error.code;
      throw failure;
    }
    this._pump();
  }

  _close() {
    if (this.fd === null) return;
    try { fs.closeSync(this.fd); } catch { /* already gone */ }
    this.fd = null;
  }

  _disconnected() {
    const capture = this.capture;
    this.capture = null;
    this._close();
    this.halted = false;
    this.info = null;
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
        let n = 0;
        try {
          n = await new Promise((res, rej) =>
            fs.read(fd, buf, 0, buf.length, null, (e, cnt) => (e ? rej(e) : res(cnt))));
        } catch (e) {
          if (e.code === 'EAGAIN' || e.code === 'EINTR') { await sleep(20); continue; }
          // Drop disconnected descriptors before the next command.
          this._disconnected();
          this._emit('sys', '— board disconnected —\n');
          break;
        }
        if (n > 0) this._onData(buf.subarray(0, n).toString('binary'));
      }
    } finally {
      this.pumping = false;
    }
  }

  _onData(chunk) {
    // Buffer all bytes while a command is active.
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
    let done = 0;
    while (done < len) {
      if (this.fd === null) throw new Error('port closed');
      done += fs.writeSync(this.fd, buf, off + done, len - done);
    }
  }

  // Feed plain raw REPL in small chunks because it lacks flow control.
  async write(data) {
    const buf = Buffer.from(data, 'binary');
    if (buf.length <= 256) { this._writeAll(buf, 0, buf.length); return; }
    for (let off = 0; off < buf.length; off += 256) {
      this._writeAll(buf, off, Math.min(256, buf.length - off));
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
        await this.write('\r' + CTRL_C + CTRL_C);
        await sleep(30);
        this.capture = null;                     // discard the interrupt traceback
        this.rx = '';
        const p = this.readUntil(RAW_BANNER, 400);
        await this.write(CTRL_A);
        await p;
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
      // Wait for more credit only when the current window is exhausted.
      while (remain === 0 || this.rx.length) {
        const b = this.rx.length ? this._takeByte() : await this.readN(1, 30000);
        if (b === '\x01') remain += windowSize;
        else if (b === '\x04') { await this.write(CTRL_D); return true; }  // board gave up
      }
      const n = Math.min(remain, buf.length - i);
      this._writeAll(buf, i, n);
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
        this._writeAll(buf, off, 1);
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
  command(fn) {
    const run = async () => {
      this._cancelIdle();
      this.busy = true;
      this.inCommand = true;
      try {
        this._open();
        if (!this.halted) {
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
  async _release() {
    this._cancelIdle();
    if (this.busy) return;
    this.inCommand = false;
    this.capture = null;
    this.rx = '';
    if (this.halted) { await this._resume(); this.halted = false; }
    if (this.monitors.size === 0) this._close();
  }

  releaseNow() {
    const next = this.chain.then(() => this._release(), () => this._release());
    this.chain = next.catch(() => {});
    return next;
  }

  addMonitor(fn) { this.monitors.add(fn); this._open(); }
  removeMonitor(fn) {
    this.monitors.delete(fn);
    if (this.monitors.size === 0 && !this.busy) this._close();
  }
}

// ── Device registry ─────────────────────────────────────────────────────────
const ports = new Map(); // dev path -> PicoPort
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

// Strip terminal control sequences before parsing output.
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

function listDevs() {
  if (deviceListOverride) return [...deviceListOverride];
  try {
    return fs.readdirSync(DEV_DIR)
      .filter(n => DEV_MATCH.test(n))
      .map(n => path.join(DEV_DIR, n))
      .sort();
  } catch { return []; }
}

function deviceIdentity(dev) {
  try {
    const stat = fs.statSync(dev);
    return String(stat.ino) + ':' + String(stat.rdev);
  } catch { return null; }
}

function getPort(dev) {
  if (!ports.has(dev)) ports.set(dev, new PicoPort(dev));
  return ports.get(dev);
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
  if (p.info) return p.info;
  if (p.probePromise) return p.probePromise;
  p.probePromise = (async () => {
    const detected = await probeRecord(
      p,
      'IMPL',
      "import sys;print('PVI_IMPL',getattr(sys.implementation,'name','micropython'))",
      10,
    );
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
  })();
  try { return await p.probePromise; }
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
  const m = machine.replace(/^Raspberry Pi\s+/i, '').split(/\s+with\s+/i)[0].trim();
  return m || machine;
}

const loggedDevices = new Map();
let loggedNoDevices = false;

async function scanDevices() {
  const devs = listDevs();
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
      return {
        dev, ok: false, error: String(e.message || e),
        machine: '', release: '', uid: '',
        label: path.basename(dev), serial: path.basename(dev).slice(-4),
      };
    }
  }));
  return serialDevices.concat(deviceListOverride ? [] : await bootselDevices());
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
    const signature = [device.ok, device.firmware, device.machine, device.release, device.uid, device.error].join('|');
    if (loggedDevices.get(device.dev) === signature) continue;
    loggedDevices.set(device.dev, signature);
    if (device.bootMode) {
      console.log('device found: ' + device.machine + ' · BOOTSEL firmware-install mode');
    } else if (device.ok) {
      console.log('device found: ' + (device.machine || device.label) +
        ' · ' + device.firmwareLabel + ' ' + device.release + ' · serial ' + (device.uid || device.serial) +
        ' · ' + device.dev);
    } else {
      console.log('device found: ' + device.dev + ' · identification failed: ' + device.error);
    }
  }
}

// ── On-device operations ────────────────────────────────────────────────────

// Return the actionable final traceback line.
function pyError(err) {
  const lines = cleanReplOutput(err).trim().split(/\r?\n/).filter(l => l.trim());
  return lines.length ? lines[lines.length - 1].trim() : 'Board reported an error';
}

// Escape a device path as a Python string.
const pyStr = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

// Escape bytes as a Python literal.
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

// Reject paths that can escape the filesystem root.
function cleanPath(p) {
  if (typeof p !== 'string' || !p) return null;
  const parts = p.replace(/^\/+/, '').split('/').filter(Boolean);
  if (parts.some(s => s === '.' || s === '..' || /[\x00-\x1f]/.test(s))) return null;
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

function circuitMountCandidates() {
  const found = new Set();
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

function parseLinuxCircuitPartitions(output) {
  let parsed;
  try { parsed = JSON.parse(String(output)); } catch { return []; }
  const partitions = [];
  function visit(device) {
    const mounts = Array.isArray(device.mountpoints) ? device.mountpoints.filter(Boolean) : [];
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
    const mounts = Array.isArray(device.mountpoints) ? device.mountpoints.filter(Boolean) : [];
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
        mountRoot: (Array.isArray(device.mountpoints) ? device.mountpoints : []).find(Boolean) || null,
        capabilities: { read: false, write: false, run: false, console: false },
      });
    }
    for (const child of device.children || []) visit(child, device);
  }
  for (const device of parsed.blockdevices || []) visit(device);
  return devices;
}

async function bootselDevices() {
  if (bootselDeviceOverride) return bootselDeviceOverride;
  if (process.platform === 'linux') {
    try {
      const output = await execFileText('lsblk', [
        '--json', '--paths', '--output', 'PATH,LABEL,MODEL,SERIAL,MOUNTPOINTS',
      ], { timeout: 2000 });
      return parseBootselBlockDevices(output);
    } catch { return []; }
  }
  if (process.platform === 'darwin') {
    try {
      return fs.readdirSync('/Volumes', { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^(RPI-RP2|RP2350)$/i.test(entry.name))
        .map(entry => {
          const chip = /^RPI-RP2$/i.test(entry.name) ? 'RP2040' : 'RP2350';
          return {
            dev: 'bootsel:' + path.join('/Volumes', entry.name), ok: true, bootMode: true,
            firmware: 'bootsel', firmwareLabel: 'BOOTSEL', machine: chip, release: '', uid: '',
            label: chip, serial: '', readOnly: true,
            blockDevice: null, mountRoot: path.join('/Volumes', entry.name),
            capabilities: { read: false, write: false, run: false, console: false },
          };
        });
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

async function installBootselFirmware(dev, firmwareId, download = downloadFirmware) {
  const firmware = BOOTSEL_FIRMWARE[firmwareId];
  if (!firmware) throw new Error('Unknown firmware selection');
  const device = (await bootselDevices()).find(item => item.dev === dev);
  if (!device) throw new Error('BOOTSEL device is no longer connected');
  if (device.machine !== firmware.chip) throw new Error('Firmware does not match this BOOTSEL device');
  const root = await mountedBootselRoot(device);
  if (!root) throw new Error('Could not mount the BOOTSEL volume');
  fs.accessSync(root, fs.constants.W_OK);
  const image = await download(firmware.url);
  if (image.length < 512 || image.readUInt32LE(0) !== 0x0A324655 || image.readUInt32LE(4) !== 0x9E5D5157) {
    throw new Error('Downloaded file is not a valid UF2 image');
  }
  await fs.promises.writeFile(path.join(root, firmware.filename), image);
  return { ok: true, firmware: firmware.name, bytes: image.length };
}

async function autoMountCircuitPartitions() {
  if (!RASPBERRY_PI_HOST) return;
  unmountedCircuitVolumes = new Map();
  let output;
  try {
    output = await execFileText('lsblk', ['--json', '--paths', '--output', 'PATH,PKNAME,LABEL,FSTYPE,MOUNTPOINTS,SERIAL'], {
      timeout: 2000,
    });
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

function mountedPath(root, devicePath) {
  const clean = cleanPath(devicePath);
  if (!clean) return null;
  const target = path.resolve(root, ...clean.split('/'));
  return target.startsWith(path.resolve(root) + path.sep) ? target : null;
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

// Read Flash and RAM usage.
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

// Write in 1 KiB chunks.
async function writeFile(dev, file, buf) {
  const access = await requireWritable(dev);
  if (access.mode === 'mount') {
    const local = mountedPath(access.root, file);
    if (!local) throw new Error('Bad path');
    fs.mkdirSync(path.dirname(local), { recursive: true });
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

async function makeDirectory(dev, file) {
  const access = await requireWritable(dev);
  if (access.mode === 'mount') {
    const local = mountedPath(access.root, file);
    if (!local) throw new Error('Bad path');
    fs.mkdirSync(local);
    return { ok: true, out: '' };
  }
  return simpleOp(dev, 'import os\nos.mkdir(' + pyStr(file) + ')');
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
  if (port.fd !== null) await port.write('\r' + CTRL_C + CTRL_C);
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
function attachConsole(dev, res) {
  const p = getPort(dev);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  const send = (type, text) => {
    try { res.write('data: ' + JSON.stringify({ type, text }) + '\n\n'); } catch { /* gone */ }
  };
  send('sys', '— attached to ' + dev + ' —\n');
  p.addMonitor(send);
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
    record.installable_firmware = ['micropython'];
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
    title: 'List connected Pico boards',
    description: 'List connected MicroPython and CircuitPython boards and their capabilities. Use board_id from this result in every other tool.',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: readOnlyAnnotations,
    handler: async (raw) => {
      validateToolArgs(raw, []);
      return mcpToolResult({ boards: (await scanDevices()).map(boardRecord) });
    },
  },
  {
    name: 'pico_install',
    title: 'Install firmware on a BOOTSEL board',
    description: 'Install firmware on a Pico in BOOTSEL mode. Always call action check first. If it returns needs_mount, ask the user to run the command and wait before checking again. When ready, ask whether the board is a W model with Wi-Fi and obtain explicit confirmation before calling action install. Only MicroPython is currently supported.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        board_id: boardIdProperty,
        action: { type: 'string', enum: ['check', 'install'] },
        firmware: { type: 'string', enum: ['micropython'] },
        wifi: { type: 'boolean', description: 'Whether this is a W model with Wi-Fi. Required for install.' },
        confirmed: { type: 'boolean', description: 'Must be true after the user explicitly confirms installation.' },
      },
      required: ['board_id', 'action', 'firmware'],
    },
    annotations: destructiveAnnotations,
    handler: async (raw) => {
      const args = validateToolArgs(
        raw, ['board_id', 'action', 'firmware', 'wifi', 'confirmed'],
        ['board_id', 'action', 'firmware'],
      );
      const boardId = stringArg(args, 'board_id');
      const action = stringArg(args, 'action', { values: ['check', 'install'] });
      const firmware = stringArg(args, 'firmware', { values: ['micropython'] });
      const readiness = await checkBootselInstall(boardId, firmware);
      if (action === 'check' || readiness.status !== 'ready') {
        return mcpToolResult({ board_id: boardId, ...readiness });
      }
      if (args.wifi === undefined) throw new Error('wifi is required for action install');
      if (args.confirmed !== true) throw new Error('confirmed must be true after explicit user confirmation');
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
        instructions: 'Manage locally connected MicroPython and CircuitPython boards. Call pico_boards_list before using a board-specific tool.',
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
  let enableMcp = options.mcpHttp === true;
  const installBootsel = options.installBootsel || installBootselFirmware;
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

    // Return cached metadata for attached boards.
    if (p === '/api/devices') {
      if (q.manual === '1') console.log('scanning for devices…');
      const list = await scanDevices();
      if (logDevices) logDeviceChanges(list);
      sendJSON(res, 200, {
        devices: list,
        hostWarning: raspberryPiPowerWarning(),
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
      sendJSON(res, 200, await installBootsel(q.dev, q.firmware));
      return;
    }

    if (p === '/api/console') {
      const dev = q.dev;
      if (!dev || !listDevs().includes(dev)) { res.writeHead(404); res.end(); return; }
      attachConsole(dev, res);
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
          const buf = await readFile(dev, f.path).catch(() => Buffer.alloc(0));
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

    // Run a file or console input and stream its output.
    if (p === '/api/run' && req.method === 'POST') {
      const options = q.path
        ? { path: q.path }
        : { code: (await readBody(req)).toString('utf8') };
      sendJSON(res, 200, await runPython(dev, options));
      return;
    }

    // Interrupt a running script without a full reset.
    if (p === '/api/interrupt' && req.method === 'POST') {
      sendJSON(res, 200, await interruptBoard(dev));
      return;
    }

    if (p === '/api/reset' && req.method === 'POST') {
      sendJSON(res, 200, await resetBoard(dev, q.hard === '1'));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
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
  if (process.platform === 'win32') return null;
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

// Never leave a board halted in raw REPL.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const port of ports.values()) {
    if (port.fd === null) continue;
    try {
      fs.writeSync(port.fd, Buffer.from('\r' + CTRL_C + CTRL_B + CTRL_D, 'binary'));
      port._close();
    } catch { /* nothing more we can do on the way out */ }
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
  FIRMWARE_ADAPTERS,
  cleanPath,
  cleanReplOutput,
  createServer,
  crc32,
  createZipBuffer,
  deviceStats,
  firmwareAdapter,
  getPort,
  isRaspberryPi,
  listDevs,
  listFiles,
  makeDirectory,
  parseFileList,
  parseDarwinCircuitVolumes,
  parseLinuxCircuitPartitions,
  parseLinuxUnmountedCircuitVolumes,
  parseBootselBlockDevices,
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
  selectMcpTransports,
  shouldOpenBrowser,
  startupUrls,
  simpleOp,
  dispatchMcp,
  handleMcpHttp,
  writeFile,
  _test: {
    clearDevices() {
      ports.clear();
      deviceListOverride = null;
      circuitVolumeOverride = null;
      circuitVolumePromise = null;
      bootselDeviceOverride = null;
      bootselInstallOverride = null;
    },
    setBootselDevices(entries) { bootselDeviceOverride = entries; },
    setBootselInstaller(handler) { bootselInstallOverride = handler; },
    setCircuitVolumes(entries) { circuitVolumeOverride = new Map(entries); },
    setDevices(entries) {
      ports.clear();
      deviceListOverride = entries.map(entry => entry.dev);
      for (const entry of entries) ports.set(entry.dev, entry.port);
    },
  },
};
