'use strict';

const { spec } = require('node:test/reporters');
const { Readable } = require('node:stream');

function formatMilliseconds(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return String(value);
  if (milliseconds >= 1) return String(Math.round(milliseconds));
  if (milliseconds <= 0) return '0';
  return milliseconds.toPrecision(1);
}

if (require.main !== module) {
  module.exports = async function* roundedSpecReporter(source) {
    const reporter = spec();
    Readable.from(source).pipe(reporter);
    for await (const chunk of reporter) {
      yield String(chunk)
        .replace(/(\()([0-9]+(?:\.[0-9]+)?)ms\)/g,
          (_match, opening, value) => opening + formatMilliseconds(value) + 'ms)')
        .replace(/(duration_ms\s+)([0-9]+(?:\.[0-9]+)?)/g,
          (_match, _label, value) => 'duration ' + formatMilliseconds(value) + ' ms');
    }
  };
} else {
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { after, before, describe, test } = require('node:test');
const zlib = require('node:zlib');

const viewer = require('./pico-bay.js');

function makeZipEntry(name, content, deflate = false) {
  const nameBuf = Buffer.from(name);
  const data = Buffer.from(content);
  const packed = deflate ? zlib.deflateRawSync(data) : data;
  const method = deflate ? 8 : 0;
  const crc = viewer.crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);

  const centralOffset = local.length + nameBuf.length + packed.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBuf, packed, central, nameBuf, eocd]);
}

function firmwareInfo(firmware, readOnly) {
  const label = firmware === 'circuitpython' ? 'CircuitPython' : 'MicroPython';
  return {
    dev: '/dev/test-' + firmware,
    ok: true,
    firmware,
    firmwareLabel: label,
    readOnly,
    capabilities: { read: true, write: !readOnly, run: true, console: true },
    machine: 'Test Board',
    release: '1.0.0',
    uid: firmware + '-uid',
    label: 'Test Board',
    serial: '-uid',
  };
}

function fakePort(info) {
  return {
    info,
    calls: [],
    fd: null,
    probePromise: null,
    async command(fn) { return fn(this); },
    async releaseNow() {},
    async write(data) { this.calls.push(data); },
    _close() { this.fd = null; },
    async exec(code) {
      this.calls.push(code);
      if (code.includes("print('PVF'")) {
        return { out: 'PVF 0 7 0 code.py\r\n', err: '' };
      }
      if (code.includes("print('PVD'")) {
        return { out: 'PVD7072696e74283129\r\n', err: '' };
      }
      return { out: 'ok\r\n', err: '' };
    },
    _emit() {},
  };
}

describe('serial discovery', () => {
  test('discovers macOS USB modem and USB serial callout ports, and Linux USB ports', t => {
    t.mock.method(fs, 'readdirSync', directory => {
      assert.equal(directory, '/dev');
      return [
        'cu.usbserial-110', 'cu.usbmodem123',
        'tty.usbserial-110', 'tty.usbmodem123',
        'cu.Bluetooth-Incoming-Port', 'cu.debug-console',
        'ttyUSB0', 'ttyACM0', 'ttyS0',
      ];
    });
    assert.deepEqual(viewer.listDevs('darwin'), [
      '/dev/cu.usbmodem123', '/dev/cu.usbserial-110',
    ]);
    assert.deepEqual(viewer.listDevs('linux'), ['/dev/ttyACM0', '/dev/ttyUSB0']);
  });
});

describe('ESP ROM detection', () => {
  after(() => viewer._test.clearDevices());

  function romPort({ modernId, magic = 0x00f01d83, denyMac = false, stub = false } = {}) {
    const port = viewer.getPort('/dev/test-esp-' + Math.random());
    const requests = [];
    port._open = () => {};
    port._close = () => {};
    port._enterRaw = async () => { throw new Error('not a Python REPL'); };
    port.write = async wire => {
      const request = viewer.espSlipDecode(Buffer.from(wire, 'binary').subarray(1, -1));
      requests.push(request);
      assert.equal(request[0], 0);
      assert.equal(request.readUInt16LE(2), request.length - 8);
      assert.equal(request.readUInt32LE(4), 0);
      const opcode = request[1];
      assert.ok([8, 10, 20].includes(opcode), 'only read-only bootloader commands');
      let value = 0;
      let payload = Buffer.alloc(0);
      let error = false;
      if (opcode === 8) {
        assert.equal(request.subarray(8).toString('hex'), '07071220' + '55'.repeat(32));
        value = stub ? 0 : 0x20120707;
      } else if (opcode === 20) {
        error = modernId === undefined;
        if (!error) { payload = Buffer.alloc(20); payload.writeUInt32LE(modernId, 12); }
      } else {
        const address = request.readUInt32LE(8);
        if (address === 0x40001000) value = magic;
        else if (address === 0x3ff5a004) { value = 0x12c0db34; error = denyMac; }
        else if (address === 0x3ff5a008) value = 0x0000246f;
        else assert.fail('unexpected register read');
      }
      const response = Buffer.alloc(12 + payload.length);
      response[0] = 1;
      response[1] = opcode;
      response.writeUInt16LE(payload.length + 4, 2);
      response.writeUInt32LE(value, 4);
      payload.copy(response, 8);
      if (error) { response[response.length - 4] = 1; response[response.length - 3] = 5; }
      const framed = viewer.espSlipEncode(response).toString('binary');
      // Exercise the real receive buffer with noise, empty delimiters, and split replies.
      port._onData('boot log\r\n\xc0' + framed.slice(0, 5));
      setImmediate(() => port._onData(framed.slice(5) + (opcode === 8 ? framed.repeat(7) : '')));
    };
    return { port, requests };
  }

  test('encodes SLIP bytes and rejects invalid escapes', () => {
    assert.equal(viewer.espSlipEncode(Buffer.from([0xc0, 0xdb, 1])).toString('hex'), 'c0dbdcdbdd01c0');
    assert.deepEqual(viewer.espSlipDecode(Buffer.from('dbdcdbdd01', 'hex')), Buffer.from([0xc0, 0xdb, 1]));
    assert.throws(() => viewer.espSlipDecode(Buffer.from([0xdb])));
    assert.throws(() => viewer.espSlipDecode(Buffer.from([0xdb, 0])));
  });

  test('falls back from Python to ROM detection, retains MAC bytes, and caches the result', async () => {
    const { port, requests } = romPort();
    const board = await viewer.probe(port.dev);
    assert.equal(board.machine, 'ESP32');
    assert.equal(board.bootMode, true);
    assert.equal(board.bootDetails.mac, '24:6f:12:c0:db:34');
    assert.deepEqual(board.capabilities, { read: false, write: false, run: false, console: false });
    const count = requests.length;
    assert.equal(await viewer.probe(port.dev), board);
    assert.equal(requests.length, count, 'polls must not keep probing a cached board');
    assert.equal(port.busy, false);
    assert.equal(port.inCommand, false);
    assert.equal(port.halted, false);
    viewer._test.setDevices([{ dev: port.dev, port }]);
    try {
      const response = await viewer.dispatchMcp({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'pico_boards_list', arguments: {} },
      });
      const record = response.result.structuredContent.boards[0];
      assert.equal(record.boot_mode, true);
      assert.deepEqual(record.installable_firmware, []);
      assert.equal(record.boot_details.mac, board.bootDetails.mac);
    } finally { viewer._test.clearDevices(); }
  });

  test('identifies S2, C3, and S3 and preserves unknown chip IDs without guessing', async () => {
    for (const [options, name] of [
      [{ magic: 0x000007c6 }, 'ESP32-S2'],
      [{ modernId: 5 }, 'ESP32-C3'],
      [{ modernId: 9 }, 'ESP32-S3'],
      [{ modernId: 999 }, 'Espressif chip (unidentified)'],
    ]) {
      const { port } = romPort(options);
      const board = await port.command(viewer.detectEspBootloader, { rawRepl: false });
      assert.equal(board.machine, name);
      if (options.modernId !== undefined) assert.equal(board.bootDetails.chipId, options.modernId);
    }
  });

  test('retains identification when optional reads fail and rejects a running stub', async () => {
    const { port } = romPort({ denyMac: true });
    const board = await port.command(viewer.detectEspBootloader, { rawRepl: false });
    assert.equal(board.machine, 'ESP32');
    assert.equal(board.bootDetails.mac, undefined);
    const stub = romPort({ stub: true }).port;
    assert.equal(await stub.command(viewer.detectEspBootloader, { rawRepl: false }), null);
  });

  test('stops repeated Python retries and caches failed identification', async () => {
    const { port } = romPort({ stub: true });
    let attempts = 0;
    port._enterRaw = async () => { attempts++; throw new Error('RTCWDT_RTC_RESET'); };
    await assert.rejects(viewer.probe(port.dev), /watchdog resets/);
    await assert.rejects(viewer.probe(port.dev), /watchdog resets/);
    assert.equal(attempts, 1);
    assert.equal(port.probePromise, null);
    port.probeFailure.retryAt = 0;
    await assert.rejects(viewer.probe(port.dev), /watchdog resets/);
    assert.equal(attempts, 2);
  });

  test('returns healthy boards while another probe is pending and coalesces polls', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let commands = 0;
    const slow = {
      info: null, probePromise: null,
      async command(fn) { commands++; await gate; return fn(this); },
      async exec(code) {
        return { out: code.includes('PVI_IMPL') ? 'PVI_IMPL micropython\r\n'
          : 'PVI_DETAILS 4553503332 1.28.0 aabbccdd 1\r\n', err: '' };
      },
    };
    const healthy = firmwareInfo('micropython', false);
    viewer._test.setDevices([
      { dev: healthy.dev, port: fakePort(healthy) },
      { dev: '/dev/slow', port: slow },
    ]);
    try {
      for (let i = 0; i < 2; i++) {
        const devices = await viewer.scanDevices({ waitForProbes: false });
        assert.equal(devices.find(device => device.dev === healthy.dev).ok, true);
        assert.equal(devices.find(device => device.dev === '/dev/slow').probing, true);
      }
      assert.equal(commands, 1);
      release();
      await viewer.probe('/dev/slow');
      const devices = await viewer.scanDevices({ waitForProbes: false });
      const identified = devices.find(device => device.dev === '/dev/slow');
      assert.equal(identified.ok, true);
      assert.equal(identified.machine, 'ESP32');
    } finally { release(); viewer._test.clearDevices(); }
  });

  test('ignores malformed, echoed and wrong-opcode packets; times out and rejects mutations', async () => {
    const port = viewer.getPort('/dev/test-esp-malformed');
    port.inCommand = true;
    port.write = async () => port._onData('\xc0\xdb\x00\xc0\x00\x08\x02\x00\x00\x00\x00\x00\x00\x00\xc0\x01\x0a\x02\x00\x00\x00\x00\x00\x00\x00\xc0');
    await assert.rejects(viewer.espRomCommand(port, 8, Buffer.alloc(0), 20), /timed out|No matching/);
    assert.equal(port.capture, null);
    await assert.rejects(viewer.espRomCommand(port, 2), /Unsupported/);
    port.inCommand = false;
  });
});

describe('pure helpers', () => {
  test('prints CLI help and version without starting the server', () => {
    const help = spawnSync(process.execPath, ['pico-bay.js', '--help'], {
      cwd: __dirname, encoding: 'utf8',
    });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^Usage: pico-bay \[options\]/);
    assert.equal(help.stderr, '');

    const version = spawnSync(process.execPath, ['pico-bay.js', '--version'], {
      cwd: __dirname, encoding: 'utf8',
    });
    assert.equal(version.status, 0);
    assert.equal(version.stdout.trim(), require('./package.json').version);
    assert.equal(version.stderr, '');
  });

  test('formats test durations without noisy precision', () => {
    assert.equal(formatMilliseconds(12.71), '13');
    assert.equal(formatMilliseconds(1), '1');
    assert.equal(formatMilliseconds(0.31), '0.3');
    assert.equal(formatMilliseconds(0.052), '0.05');
    assert.equal(formatMilliseconds(0), '0');
  });

  test('detects firmware records despite CircuitPython status sequences', () => {
    const esc = '\x1b';
    const out = esc + ']0;status\x07' +
      'PVI_IMPL circuitpython\r\n' +
      'PVI_MACHINE Raspberry Pi Pico\r\n' +
      esc + '[2K' + 'PVI_RELEASE 10.2.1\r\n' +
      'PVI_UID 0123456789abcdef\r\n';
    assert.deepEqual(viewer.parseProbeOutput(out), {
      impl: 'circuitpython',
      machine: 'Raspberry Pi Pico',
      release: '10.2.1',
      uid: '0123456789abcdef',
    });
  });

  test('parses folders including system paths for UI filtering', () => {
    const files = viewer.parseFileList([
      'PVF 1 0 0 lib',
      'PVF 0 42 946684800 lib/code.py',
      'PVF 1 0 0 .Trashes',
      'PVF 0 9 0 .Trashes/data',
      'PVF 0 5 0 lib/.hidden.py',
      'PVF 0 7 946684800 code.py',
    ].join('\r\n'));
    assert.deepEqual(files.map(file => file.path), [
      'lib', 'lib/code.py', '.Trashes', '.Trashes/data', 'lib/.hidden.py', 'code.py',
    ]);
    assert.equal(files[0].isDir, true);
    assert.equal(files[1].dir, 'lib');
  });

  test('validates device paths', () => {
    assert.equal(viewer.cleanPath('/lib/code.py'), 'lib/code.py');
    assert.equal(viewer.cleanPath('../secret'), null);
    assert.equal(viewer.cleanPath('lib/./secret'), null);
    assert.equal(viewer.cleanPath('bad\0name'), null);
  });

  test('detects Raspberry Pi hosts from the Linux model string', () => {
    assert.equal(viewer.isRaspberryPi('linux', 'Raspberry Pi 5 Model B Rev 1.0'), true);
    assert.equal(viewer.isRaspberryPi('linux', 'Generic PC'), false);
    assert.equal(viewer.isRaspberryPi('darwin', 'Raspberry Pi'), false);
  });

  test('does not open a browser on Raspberry Pi hosts', () => {
    assert.equal(viewer.shouldOpenBrowser(false, true), false);
    assert.equal(viewer.shouldOpenBrowser(false, false), true);
    assert.equal(viewer.shouldOpenBrowser(true, false), false);
  });

  test('enables HTTP MCP by default only on Raspberry Pi hosts', () => {
    const defaults = { noMcp: false, cliStdio: false, cliHttp: false };
    assert.deepEqual(viewer.selectMcpTransports({ ...defaults, raspberryPiHost: true }), {
      stdio: false, http: true,
    });
    assert.deepEqual(viewer.selectMcpTransports({ ...defaults, raspberryPiHost: false }), {
      stdio: false, http: false,
    });
    assert.deepEqual(viewer.selectMcpTransports({
      ...defaults, raspberryPiHost: true, cliStdio: true,
    }), { stdio: true, http: false });
    assert.deepEqual(viewer.selectMcpTransports({
      ...defaults, raspberryPiHost: true, noMcp: true,
    }), { stdio: false, http: false });
  });

  test('recognizes Raspberry Pi undervoltage warnings', () => {
    const current = viewer.parseRaspberryPiThrottle('throttled=0x50005');
    assert.equal(current.code, 'throttled=0x50005');
    assert.equal(current.current, true);
    assert.match(current.message, /powered USB hub/i);
    const historical = viewer.parseRaspberryPiThrottle('throttled=0x50000');
    assert.equal(historical.current, false);
    assert.equal(viewer.parseRaspberryPiThrottle('throttled=0x0'), null);
    assert.equal(viewer.parseRaspberryPiThrottle('invalid'), null);
  });

  test('prints reachable startup URLs with the selected port', () => {
    const interfaces = {
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      eth0: [{ address: '192.168.1.42', family: 'IPv4', internal: false }],
      wlan0: [{ address: '10.0.0.8', family: 4, internal: false }],
    };
    assert.deepEqual(viewer.startupUrls('127.0.0.1', 8123, interfaces), [
      'http://localhost:8123',
    ]);
    assert.deepEqual(viewer.startupUrls('0.0.0.0', 9000, interfaces), [
      'http://10.0.0.8:9000',
      'http://192.168.1.42:9000',
    ]);
    assert.deepEqual(viewer.startupUrls('192.168.2.5', 7654, interfaces), [
      'http://192.168.2.5:7654',
    ]);
  });

  test('matches multiple CircuitPython volumes by USB serial, not mount order', () => {
    const mounts = [
      '/dev/disk6s1 on /Volumes/CIRCUITPY (msdos, local, read-only)',
      '/dev/disk9s1 on /Volumes/CIRCUITPY 1 (msdos, local, read-only)',
    ].join('\n');
    const registry = [
      '"kUSBSerialNumberString" = "AAAA1111"',
      '"BSD Name" = "disk9"',
      '"BSD Name" = "disk9s1"',
      '"kUSBSerialNumberString" = "BBBB2222"',
      '"BSD Name" = "disk6"',
      '"BSD Name" = "disk6s1"',
    ].join('\n');
    assert.deepEqual([...viewer.parseDarwinCircuitVolumes(mounts, registry)], [
      ['bbbb2222', '/Volumes/CIRCUITPY'],
      ['aaaa1111', '/Volumes/CIRCUITPY 1'],
    ]);
  });

  test('finds unmounted Linux CircuitPython partitions', () => {
    const output = JSON.stringify({ blockdevices: [
      { path: '/dev/sda', serial: 'AABBCCDD' },
      { path: '/dev/sda1', pkname: '/dev/sda', label: 'CIRCUITPY', fstype: 'vfat', mountpoints: [null] },
      { path: '/dev/sdc1', label: 'CIRCUITPY', fstype: 'vfat', mountpoints: ['/media/pi/CIRCUITPY'] },
      { path: '/dev/mmcblk0p1', label: 'bootfs', fstype: 'vfat', mountpoints: ['/boot/firmware'] },
    ] });
    assert.deepEqual(viewer.parseLinuxCircuitPartitions(output), ['/dev/sda1']);
    assert.deepEqual([...viewer.parseLinuxUnmountedCircuitVolumes(output)], [['aabbccdd', '/dev/sda1']]);
    assert.deepEqual(viewer.parseLinuxCircuitPartitions('invalid'), []);
  });

  test('identifies RP2040 and RP2350 BOOTSEL storage', () => {
    const output = JSON.stringify({ blockdevices: [
      { path: '/dev/sda', serial: 'RP2040-ID', children: [
        { path: '/dev/sda1', label: 'RPI-RP2' },
      ] },
      { path: '/dev/sdb1', label: 'RP2350', serial: 'RP2350-ID' },
      { path: '/dev/sdc1', label: 'CIRCUITPY' },
    ] });
    const devices = viewer.parseBootselBlockDevices(output);
    assert.deepEqual(devices.map(device => [device.machine, device.uid]), [
      ['RP2040', 'RP2040-ID'], ['RP2350', 'RP2350-ID'],
    ]);
    assert.ok(devices.every(device => device.bootMode && !device.capabilities.read));
    assert.deepEqual(viewer.bootselFirmwareOptions('RP2040').map(option => option.id), ['pico', 'pico-w']);
    assert.deepEqual(viewer.bootselFirmwareOptions('RP2350').map(option => option.id), ['pico2', 'pico2-w']);
  });

  test('sorts connected boards by name with bootloader devices last', async () => {
    const normalA = { ...firmwareInfo('micropython', false), dev: '/dev/z', label: 'Alpha', machine: 'Alpha' };
    const normalZ = { ...firmwareInfo('circuitpython', true), dev: '/dev/a', label: 'Zulu', machine: 'Zulu' };
    const bootA = {
      ...normalA, dev: '/dev/boot-a', label: 'ESP32', machine: 'ESP32',
      bootMode: true, bootloader: 'esp-rom', firmware: 'esp-bootloader',
    };
    const bootZ = {
      ...normalA, dev: 'bootsel:/dev/z', label: 'RP2350', machine: 'RP2350',
      bootMode: true, firmware: 'bootsel',
    };
    viewer._test.setDevices([
      { dev: bootZ.dev, port: fakePort(bootZ) },
      { dev: normalZ.dev, port: fakePort(normalZ) },
      { dev: bootA.dev, port: fakePort(bootA) },
      { dev: normalA.dev, port: fakePort(normalA) },
    ]);
    try {
      assert.deepEqual((await viewer.scanDevices()).map(device => device.label), [
        'Alpha', 'Zulu', 'ESP32', 'RP2350',
      ]);
    } finally { viewer._test.clearDevices(); }
  });

  test('matches mounted CircuitPython folders from their boot UID', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pico-bay-mounts-'));
    const first = path.join(base, 'CIRCUITPY');
    const second = path.join(base, 'CIRCUITPY 1');
    try {
      fs.mkdirSync(first);
      fs.mkdirSync(second);
      fs.writeFileSync(path.join(first, 'boot_out.txt'), 'Board ID:test\nUID:BBBB2222\n');
      fs.writeFileSync(path.join(second, 'boot_out.txt'), 'UID:AAAA1111\n');
      assert.deepEqual([...viewer.bootOutCircuitVolumes([first, second])], [
        ['bbbb2222', first],
        ['aaaa1111', second],
      ]);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('lists and reads mounted CircuitPython files without following links', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pico-bay-volume-'));
    try {
      fs.mkdirSync(path.join(root, 'lib'));
      fs.writeFileSync(path.join(root, 'code.py'), 'print(1)');
      fs.writeFileSync(path.join(root, 'lib', 'helper.py'), 'value = 1');
      fs.writeFileSync(path.join(root, '.hidden'), 'system');
      fs.symlinkSync(os.tmpdir(), path.join(root, 'outside'));
      assert.deepEqual(viewer.listMountedFiles(root).map(file => file.path), [
        'code.py', 'lib', 'lib/helper.py',
      ]);
      assert.ok(viewer.listMountedFiles(root, true).some(file => file.path === '.hidden'));
      assert.ok(!viewer.listMountedFiles(root, true).some(file => file.path === 'outside'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses a matched writable CIRCUITPY mount when the board side is read-only', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pico-bay-write-mount-'));
    const info = firmwareInfo('circuitpython', true);
    info.serialReadOnly = true;
    const port = fakePort(info);
    viewer._test.setDevices([{ dev: info.dev, port }]);
    viewer._test.setCircuitVolumes([[info.uid, root]]);
    try {
      const [device] = await viewer.scanDevices();
      assert.equal(device.readOnly, false);
      assert.equal(device.capabilities.write, true);
      assert.equal(device.mountWritable, true);
      await viewer.writeFile(info.dev, 'lib/original.py', Buffer.from('value = 1'));
      assert.equal(fs.readFileSync(path.join(root, 'lib', 'original.py'), 'utf8'), 'value = 1');
      await viewer.renamePath(info.dev, 'lib/original.py', 'lib/renamed.py');
      await viewer.makeDirectory(info.dev, 'data');
      assert.equal(fs.existsSync(path.join(root, 'lib', 'renamed.py')), true);
      assert.equal(fs.statSync(path.join(root, 'data')).isDirectory(), true);
      await viewer.removePath(info.dev, 'lib');
      assert.equal(fs.existsSync(path.join(root, 'lib')), false);
      assert.equal(port.calls.length, 0);
    } finally {
      viewer._test.clearDevices();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('explains how to resolve an occupied server port', () => {
    const lines = viewer.portInUseLines('127.0.0.1', 7426, { command: 'node', pid: '1234' });
    assert.equal(lines[0], 'Port is already in use: 127.0.0.1:7426');
    assert.ok(lines.includes('Used by: node (PID 1234)'));
    assert.ok(lines.some(line => line.includes('1234')));
    assert.ok(lines.includes('Or choose another port: pico-bay --port 7427'));
    assert.ok(lines.includes('From this source folder: npm start -- --port 7427'));
  });

  test('cleans up immediately when a serial device disappears before opening', async () => {
    const port = viewer.getPort('/dev/pico-bay-test-disconnected');
    await assert.rejects(port.command(async () => {}), /Board disconnected/);
    assert.equal(port.fd, null);
    assert.equal(port.info, null);
    assert.equal(port.capture, null);
    viewer._test.clearDevices();
  });

  test('round-trips stored ZIP backups', () => {
    const zip = viewer.createZipBuffer([{ path: 'code.py', content: Buffer.from('print(1)') }]);
    const entries = viewer.parseRestoreZip(zip);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].path, 'code.py');
    assert.equal(entries[0].content.toString(), 'print(1)');
  });

  test('reads standard Deflate ZIP entries', () => {
    const entries = viewer.parseRestoreZip(makeZipEntry('lib/code.py', 'hello', true));
    assert.equal(entries[0].path, 'lib/code.py');
    assert.equal(entries[0].content.toString(), 'hello');
  });

  test('rejects unsafe and corrupt ZIP entries', () => {
    assert.throws(() => viewer.parseRestoreZip(makeZipEntry('../escape.py', 'bad')), /Invalid ZIP path/);
    const corrupt = makeZipEntry('code.py', 'good');
    corrupt[corrupt.indexOf(Buffer.from('good'))] ^= 0xff;
    assert.throws(() => viewer.parseRestoreZip(corrupt), /checksum failed/);
  });

  test('probes multiple boards in parallel and keeps their metadata separate', async () => {
    let active = 0;
    let maxActive = 0;
    function probePort(firmware, machine, release, uid, writable = false) {
      return {
        info: null,
        probePromise: null,
        async command(fn) {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise(resolve => setTimeout(resolve, 10));
          try { return await fn(this); }
          finally { active--; }
        },
        async exec(code) {
          if (code.includes('PVI_IMPL')) return { out: 'PVI_IMPL ' + firmware + '\r\n', err: '' };
          if (code.includes('PVI_DETAILS')) {
            return {
              out: 'PVI_DETAILS ' + Buffer.from(machine).toString('hex') + ' ' + release + ' ' + uid + ' ' + (writable ? '1' : '0') + '\r\n',
              err: '',
            };
          }
          if (code.includes('PVI_MACHINE') && code.includes('PVI_RELEASE') && code.includes('PVI_UID')) {
            return {
              out: 'PVI_MACHINE ' + machine + '\r\nPVI_RELEASE ' + release + '\r\nPVI_UID ' + uid + '\r\n',
              err: '',
            };
          }
          if (code.includes('PVI_MACHINE')) return { out: 'PVI_MACHINE ' + machine + '\r\n', err: '' };
          if (code.includes('PVI_RELEASE')) return { out: 'PVI_RELEASE ' + release + '\r\n', err: '' };
          if (code.includes('PVI_UID')) return { out: 'PVI_UID ' + uid + '\r\n', err: '' };
          if (code.includes('PVI_WRITABLE')) return { out: 'PVI_WRITABLE ' + (writable ? '1' : '0') + '\r\n', err: '' };
          return { out: '', err: '' };
        },
      };
    }

    viewer._test.setDevices([
      { dev: '/dev/board-a', port: probePort('micropython', 'Generic ESP32 module with ESP32', '1.25.0', 'aaaa1111') },
      { dev: '/dev/board-b', port: probePort('circuitpython', 'Pico 2 W', '10.2.1', 'bbbb2222', true) },
    ]);
    try {
      const boards = await viewer.scanDevices();
      assert.equal(maxActive, 2);
      assert.deepEqual(boards.map(board => [board.firmware, board.machine, board.release, board.uid]), [
        ['micropython', 'Generic ESP32 module with ESP32', '1.25.0', 'aaaa1111'],
        ['circuitpython', 'Pico 2 W', '10.2.1', 'bbbb2222'],
      ]);
      assert.deepEqual(boards.map(board => board.label), ['ESP32', 'Pico 2 W']);
      assert.equal(boards[1].readOnly, false);
      assert.equal(boards[1].capabilities.write, true);
    } finally {
      viewer._test.clearDevices();
    }
  });
});

describe('MCP protocol', () => {
  const modernMeta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };

  test('supports modern discovery and deterministic tool listing', async () => {
    const discover = await viewer.dispatchMcp({
      jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: modernMeta },
    });
    assert.deepEqual(discover.result.supportedVersions, ['2026-07-28']);
    assert.equal(discover.result.resultType, 'complete');
    assert.equal(discover.result.capabilities.tools.listChanged, false);

    const first = await viewer.dispatchMcp({
      jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: modernMeta },
    });
    const second = await viewer.dispatchMcp({
      jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: modernMeta },
    });
    assert.deepEqual(first.result.tools, second.result.tools);
    assert.deepEqual(first.result.tools.map(tool => tool.name), [
      'pico_boards_list',
      'pico_files_list',
      'pico_file_read',
      'pico_file_write',
      'pico_directory_create',
      'pico_path_rename',
      'pico_path_delete',
      'pico_python_run',
      'pico_board_interrupt',
      'pico_board_reset',
      'pico_install',
    ]);
    assert.ok(first.result.tools.every(tool => !Object.hasOwn(tool, 'handler')));
  });

  test('checks and installs MicroPython on a confirmed BOOTSEL model', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pico-bay-bootsel-mcp-'));
    const device = {
      dev: 'bootsel:/dev/sdz1', uid: 'BOOTSEL-ID', ok: true, bootMode: true,
      firmware: 'bootsel', firmwareLabel: 'BOOTSEL', machine: 'RP2350',
      label: 'RP2350', serial: '', readOnly: true, mountRoot: root, blockDevice: '/dev/sdz1',
      capabilities: { read: false, write: false, run: false, console: false },
    };
    const calls = [];
    viewer._test.setBootselDevices([device]);
    viewer._test.setBootselInstaller(async (dev, firmware) => {
      calls.push([dev, firmware]);
      return { ok: true, bytes: 1234 };
    });
    const call = (id, args) => viewer.dispatchMcp({
      jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'pico_install', arguments: args, _meta: modernMeta },
    });
    try {
      const boards = await viewer.dispatchMcp({
        jsonrpc: '2.0', id: 8, method: 'tools/call',
        params: { name: 'pico_boards_list', arguments: {}, _meta: modernMeta },
      });
      const bootsel = boards.result.structuredContent.boards.find(board => board.board_id === 'BOOTSEL-ID');
      assert.deepEqual(bootsel.installable_firmware, ['micropython']);
      assert.equal(bootsel.boot_mode, true);

      const check = await call(9, {
        board_id: 'BOOTSEL-ID', action: 'check', firmware: 'micropython',
      });
      assert.equal(check.result.structuredContent.status, 'ready');
      assert.deepEqual(check.result.structuredContent.models.map(model => model.wifi), [false, true]);

      const noWifi = await call(10, {
        board_id: 'BOOTSEL-ID', action: 'install', firmware: 'micropython', confirmed: true,
      });
      assert.equal(noWifi.result.isError, true);
      assert.match(noWifi.result.content[0].text, /wifi is required/);

      const unconfirmed = await call(11, {
        board_id: 'BOOTSEL-ID', action: 'install', firmware: 'micropython', wifi: true,
      });
      assert.equal(unconfirmed.result.isError, true);
      assert.match(unconfirmed.result.content[0].text, /confirmed must be true/);

      const installed = await call(12, {
        board_id: 'BOOTSEL-ID', action: 'install', firmware: 'micropython', wifi: true, confirmed: true,
      });
      assert.equal(installed.result.structuredContent.status, 'installed');
      assert.equal(installed.result.structuredContent.model, 'Raspberry Pi Pico 2 W');
      assert.deepEqual(calls, [['bootsel:/dev/sdz1', 'pico2-w']]);

      viewer._test.setBootselDevices([{ ...device, mountRoot: null }]);
      const needsMount = await call(13, {
        board_id: 'BOOTSEL-ID', action: 'check', firmware: 'micropython',
      });
      assert.equal(needsMount.result.structuredContent.status, 'needs_mount');
      assert.equal(needsMount.result.structuredContent.command, 'udisksctl mount --block-device /dev/sdz1');
    } finally {
      viewer._test.clearDevices();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('supports the legacy initialize handshake', async () => {
    const response = await viewer.dispatchMcp({
      jsonrpc: '2.0', id: 'init', method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    assert.equal(response.result.protocolVersion, '2025-11-25');
    assert.equal(response.result.serverInfo.name, 'pico-bay');
    assert.equal(response.result.resultType, undefined);
  });

  test('calls board tools and reports correctable failures as tool errors', async () => {
    const info = firmwareInfo('micropython', false);
    const port = fakePort(info);
    viewer._test.setDevices([{ dev: info.dev, port }]);
    try {
      const boards = await viewer.dispatchMcp({
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'pico_boards_list', arguments: {}, _meta: modernMeta },
      });
      assert.equal(boards.result.structuredContent.boards[0].board_id, info.uid);

      const read = await viewer.dispatchMcp({
        jsonrpc: '2.0', id: 5, method: 'tools/call',
        params: {
          name: 'pico_file_read',
          arguments: { board_id: info.uid, path: 'code.py' },
          _meta: modernMeta,
        },
      });
      assert.equal(read.result.structuredContent.content, 'print(1)');
      assert.equal(read.result.structuredContent.encoding, 'utf8');

      const badPath = await viewer.dispatchMcp({
        jsonrpc: '2.0', id: 6, method: 'tools/call',
        params: {
          name: 'pico_file_read',
          arguments: { board_id: info.uid, path: '../secret' },
          _meta: modernMeta,
        },
      });
      assert.equal(badPath.result.isError, true);
      assert.match(badPath.result.content[0].text, /Bad path/);
    } finally {
      viewer._test.clearDevices();
    }
  });

  test('keeps unknown tools as protocol errors', async () => {
    const response = await viewer.dispatchMcp({
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'missing', arguments: {}, _meta: modernMeta },
    });
    assert.equal(response.error.code, -32602);
  });
});

describe('mocked HTTP API', () => {
  let server;
  let baseUrl;
  let microPort;
  let circuitPort;

  before(async () => {
    const micro = firmwareInfo('micropython', false);
    const circuit = firmwareInfo('circuitpython', true);
    microPort = fakePort(micro);
    circuitPort = fakePort(circuit);
    viewer._test.setDevices([
      { dev: micro.dev, port: microPort },
      { dev: circuit.dev, port: circuitPort },
    ]);
    server = viewer.createServer({
      logDevices: false,
      mcpHttp: true,
      installBootsel: async (dev, firmware) => ({ ok: true, dev, firmware }),
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = 'http://127.0.0.1:' + server.address().port;
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
    viewer._test.clearDevices();
  });

  async function api(path, options) {
    const response = await fetch(baseUrl + path, options);
    const body = await response.json();
    return { response, body };
  }

  test('reports firmware capabilities', async () => {
    const { response, body } = await api('/api/devices');
    assert.equal(response.status, 200);
    assert.match(body.serverInstance, /^\d+-\d+$/);
    assert.deepEqual(body.devices.map(device => [device.firmware, device.readOnly]).sort(), [
      ['circuitpython', true],
      ['micropython', false],
    ]);
  });

  test('installs an explicitly selected BOOTSEL firmware', async () => {
    const { response, body } = await api('/api/bootsel/install?dev=bootsel%3A%2Fdev%2Fsda1&firmware=pico-w', {
      method: 'POST',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(body, { ok: true, dev: 'bootsel:/dev/sda1', firmware: 'pico-w' });
  });

  test('serves the packaged README for the full-screen help view', async () => {
    const response = await fetch(baseUrl + '/api/readme');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/markdown/);
    assert.match(await response.text(), /^# pico-bay/m);
  });

  test('serves the License linked from the README', async () => {
    const response = await fetch(baseUrl + '/LICENSE');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/plain/);
    assert.match(await response.text(), /MIT License/);
  });

  test('allows CircuitPython reads and interactive console input', async () => {
    const dev = encodeURIComponent('/dev/test-circuitpython');
    const listing = await api('/api/files?dev=' + dev);
    assert.equal(listing.response.status, 200);
    assert.equal(listing.body.files[0].path, 'code.py');
    const defaultListCode = circuitPort.calls.find(code => code.includes("print('PVF'"));
    assert.match(defaultListCode, /n\.startswith\('\.'\)/);

    const fullListing = await api('/api/files?system=1&dev=' + dev);
    assert.equal(fullListing.response.status, 200);
    const listCalls = circuitPort.calls.filter(code => code.includes("print('PVF'"));
    assert.doesNotMatch(listCalls[listCalls.length - 1], /n\.startswith\('\.'\)/);

    const file = await api('/api/file?path=code.py&dev=' + dev);
    assert.equal(file.body.text, 'print(1)');

    const consoleResult = await api('/api/run?dev=' + dev, { method: 'POST', body: 'print(2)' });
    assert.equal(consoleResult.response.status, 200);
    assert.equal(consoleResult.body.ok, true);
  });

  test('downloads backups as standard ZIP files', async () => {
    const dev = encodeURIComponent('/dev/test-circuitpython');
    const response = await fetch(baseUrl + '/api/zip?dev=' + dev);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/zip');
    assert.match(response.headers.get('content-disposition'), /filename="[^"]+\.zip"/);
    assert.equal((await response.arrayBuffer()).byteLength > 0, true);
  });

  test('rejects CircuitPython writes but allows file execution', async () => {
    const dev = encodeURIComponent('/dev/test-circuitpython');
    const write = await api('/api/file?path=new.py&dev=' + dev, { method: 'PUT', body: 'x' });
    assert.equal(write.response.status, 500);
    assert.match(write.body.error, /read-only/);

    const run = await api('/api/run?path=code.py&dev=' + dev, { method: 'POST' });
    assert.equal(run.response.status, 200);
    assert.equal(run.body.ok, true);
  });

  test('keeps MicroPython write, folder, delete, and run routes available', async () => {
    const dev = encodeURIComponent('/dev/test-micropython');
    const write = await api('/api/file?path=new.py&dev=' + dev, { method: 'PUT', body: 'print(3)' });
    assert.equal(write.response.status, 200);

    const folder = await api('/api/mkdir?path=lib&dev=' + dev, { method: 'POST' });
    assert.equal(folder.response.status, 200);

    const remove = await api('/api/file?path=new.py&dev=' + dev, { method: 'DELETE' });
    assert.equal(remove.response.status, 200);

    const run = await api('/api/run?path=code.py&dev=' + dev, { method: 'POST' });
    assert.equal(run.response.status, 200);
    assert.ok(microPort.calls.length > 0);
  });

  test('serves modern MCP over the shared HTTP server', async () => {
    const message = {
      jsonrpc: '2.0', id: 20, method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    };
    const response = await fetch(baseUrl + '/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'server/discover',
      },
      body: JSON.stringify(message),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.result.supportedVersions, ['2026-07-28']);
  });

  test('supports legacy MCP and rejects invalid HTTP origins and methods', async () => {
    const legacy = await fetch(baseUrl + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'tools/list', params: {} }),
    });
    assert.equal(legacy.status, 200);
    assert.equal((await legacy.json()).result.tools.length, 11);

    const foreign = await fetch(baseUrl + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 22, method: 'ping' }),
    });
    assert.equal(foreign.status, 403);

    const get = await fetch(baseUrl + '/mcp');
    assert.equal(get.status, 405);
  });

  test('toggles HTTP MCP while the server is running', async () => {
    const disabled = await api('/api/mcp?enabled=0', { method: 'POST' });
    assert.equal(disabled.response.status, 200);
    assert.equal(disabled.body.enabled, false);

    const unavailable = await fetch(baseUrl + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 23, method: 'ping' }),
    });
    assert.equal(unavailable.status, 404);

    const enabled = await api('/api/mcp?enabled=1', { method: 'POST' });
    assert.equal(enabled.response.status, 200);
    assert.equal(enabled.body.enabled, true);

    const available = await fetch(baseUrl + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 24, method: 'ping' }),
    });
    assert.equal(available.status, 200);
  });
});

describe('MCP stdio process', () => {
  test('writes only JSON-RPC messages to stdout', async () => {
    const child = spawn(process.execPath, ['pico-bay.js', '--mcp-stdio'], {
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.end(JSON.stringify({
      jsonrpc: '2.0', id: 30, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    }) + '\n');
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(exitCode, 0, stderr);
    const lines = stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    const response = JSON.parse(lines[0]);
    assert.equal(response.id, 30);
    assert.equal(response.result.serverInfo.name, 'pico-bay');
  });
});

describe('optional physical boards', () => {
  test('runs firmware-appropriate checks when boards are connected', async t => {
    viewer._test.clearDevices();
    const devices = (await viewer.scanDevices()).filter(device => !device.bootMode);
    if (!devices.length) {
      t.skip('no serial boards connected');
      return;
    }

    const ports = devices.map(device => viewer.getPort(device.dev));
    for (const port of ports) port._cancelIdle();
    try {
      for (const device of devices) {
        await t.test(device.firmwareLabel + ' on ' + device.dev, async () => {
          assert.equal(device.ok, true, device.error || 'device probe failed');
          if (device.firmware === 'micropython') {
            await testPhysicalMicroPython(device);
          } else if (device.firmware === 'circuitpython') {
            await testPhysicalCircuitPython(device);
          } else {
            assert.fail('unsupported connected firmware: ' + device.firmware);
          }
        });
      }
    } finally {
      await Promise.all(ports.map(port => port.releaseNow().catch(() => {})));
    }
  });
});

async function testPhysicalMicroPython(device) {
  const suffix = process.pid + '_' + Date.now().toString(36);
  const file = 'pico_bay_test_' + suffix + '.txt';
  const folder = 'pico_bay_test_' + suffix;
  const nested = folder + '/inside.txt';
  const content = Buffer.from('pico-bay hardware test\n');

  try {
    await viewer.writeFile(device.dev, file, content);
    assert.deepEqual(await viewer.readFile(device.dev, file), content);

    await viewer.makeDirectory(device.dev, folder);
    await viewer.writeFile(device.dev, nested, content);
    const paths = (await viewer.listFiles(device.dev)).map(entry => entry.path);
    assert.ok(paths.includes(file));
    assert.ok(paths.includes(folder));
    assert.ok(paths.includes(nested));

    await viewer.removePath(device.dev, file);
    await viewer.removePath(device.dev, folder);
    const remaining = (await viewer.listFiles(device.dev)).map(entry => entry.path);
    assert.equal(remaining.includes(file), false);
    assert.equal(remaining.includes(folder), false);
    assert.equal(remaining.includes(nested), false);
  } finally {
    await viewer.removePath(device.dev, file).catch(() => {});
    await viewer.removePath(device.dev, folder).catch(() => {});
  }
}

async function testPhysicalCircuitPython(device) {
  assert.ok(device.machine, 'CircuitPython model is missing');
  assert.ok(device.release, 'CircuitPython version is missing');
  assert.ok(device.uid, 'CircuitPython serial number is missing');
  assert.equal(device.capabilities.write, !device.readOnly);
  assert.deepEqual(device.capabilities, {
    read: true, write: !device.readOnly, run: true, console: true,
  });
  if (device.readOnly) await assert.rejects(viewer.requireWritable(device.dev), /read-only/);
  else await testPhysicalMicroPython(device);
  const port = viewer.getPort(device.dev);
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await port.command(pt => pt.exec(
        "print('PVI_READY');print('PICO_BAY_CONSOLE_OK')",
      ));
      assert.match(viewer.cleanReplOutput(result.out), /PICO_BAY_CONSOLE_OK/);
      return;
    } catch (error) {
      if (/PICO_BAY_CONSOLE_OK/.test(String(error.message || error))) return;
      lastError = error;
    }
  }
  throw lastError;
}
}
