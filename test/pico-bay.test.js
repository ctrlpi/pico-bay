const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { after, before, describe, test } = require('node:test');
const zlib = require('node:zlib');
const { formatMilliseconds } = require('./reporter.js');

const PROJECT_DIR = path.resolve(__dirname, '..');
const viewer = require('../pico-bay.js');

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

  test('selects native USB reset for C3/S3 while preserving external UART reset', () => {
    for (const machine of ['ESP32C3 module with ESP32-C3', 'ESP32-S3']) {
      for (const dev of ['/dev/cu.usbmodem101', '/dev/ttyACM0', 'COM7']) {
        assert.equal(viewer.espResetStrategies({ machine }, dev)[0], 'usb-jtag');
        assert.ok(viewer.espResetStrategies({ machine }, dev).includes('classic'));
      }
      assert.equal(viewer.espResetStrategies({ machine }, '/dev/ttyUSB0')[0], 'tight');
    }
    assert.equal(viewer.espResetStrategies({ machine: 'ESP32' }, '/dev/cu.usbserial-0001')[0], 'tight');
    assert.equal(viewer.espResetStrategies({ machine: 'ESP32' }, 'COM7')[0], 'tight');
  });

  function makeEspImage(chipId, content = Buffer.from('pico-bay ESP firmware test')) {
    const cursor = 24 + 8 + content.length;
    const checksumOffset = Math.ceil((cursor + 1) / 16) * 16 - 1;
    const image = Buffer.alloc(checksumOffset + 33);
    image[0] = 0xe9;
    image[1] = 1;
    image[3] = 0x20;
    image.writeUInt16LE(chipId, 12);
    image.writeUInt32LE(0x3f400020, 24);
    image.writeUInt32LE(content.length, 28);
    content.copy(image, 32);
    image[checksumOffset] = viewer.espChecksum(content);
    return image;
  }

  function withPartitionTable(image, firmware, entries) {
    const tableOffset = 0x8000 - firmware.offset;
    const combined = Buffer.alloc(Math.max(image.length, tableOffset + 0x1000), 0xff);
    image.copy(combined);
    entries.forEach((entry, index) => {
      const offset = tableOffset + index * 32;
      combined.writeUInt16LE(0x50aa, offset);
      combined.writeUInt32LE(entry.offset, offset + 4);
      combined.writeUInt32LE(entry.size, offset + 8);
      combined.fill(0, offset + 12, offset + 28);
      Buffer.from(entry.label || '', 'ascii').copy(combined, offset + 12, 0, 16);
    });
    return combined;
  }

  function romPort({ modernId, magic = 0x00f01d83, denyMac = false, stub = false, syncValue = 0x20120707,
    allowFlash = false, flashedMd5 = '', securityFlags = 0, flashCryptCount = 0, flashFailures = 0,
    refuseReboot = false, silentReboot = false, storageOffset = 0, storageMd5 = '' } = {}) {
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
      const opcode = request[1];
      assert.ok((allowFlash ? [2, 3, 4, 8, 10, 11, 13, 16, 17, 18, 19, 20] : [8, 10, 20]).includes(opcode),
        allowFlash ? 'supported bootloader command' : 'only read-only bootloader commands');
      if (opcode !== 3 && opcode !== 17) assert.equal(request.readUInt32LE(4), 0);
      let value = 0;
      let payload = Buffer.alloc(0);
      let error = false;
      if (opcode === 8) {
        assert.equal(request.subarray(8).toString('hex'), '07071220' + '55'.repeat(32));
        value = stub ? 0 : syncValue;
      } else if (opcode === 20) {
        error = modernId === undefined;
        if (!error) {
          payload = Buffer.alloc(20);
          payload.writeUInt32LE(securityFlags, 0);
          payload[4] = flashCryptCount;
          payload.writeUInt32LE(modernId, 12);
        }
      } else if (opcode === 10) {
        const address = request.readUInt32LE(8);
        if (address === 0x40001000) value = magic;
        else if (address === 0x3ff5a004) { value = 0x12c0db34; error = denyMac; }
        else if (address === 0x3ff5a008) value = 0x0000246f;
        else if (address === 0x3ff5a000 || address === 0x3ff5a018) value = 0;
        else assert.fail('unexpected register read');
      } else if (opcode === 19) {
        const address = request.readUInt32LE(8);
        payload = Buffer.from(storageMd5 && address === storageOffset ? storageMd5 : flashedMd5, 'ascii');
      } else if (opcode === 3 && flashFailures > 0) {
        flashFailures--;
        error = true;
      } else if (opcode === 4 && refuseReboot) {
        error = true;
      }
      if (opcode === 4 && silentReboot) return;
      const response = Buffer.alloc(12 + payload.length);
      response[0] = 1;
      response[1] = opcode;
      response.writeUInt16LE(payload.length + 4, 2);
      response.writeUInt32LE(value, 4);
      payload.copy(response, 8);
      if (error) {
        response[response.length - 4] = 1;
        response[response.length - 3] = opcode === 4 ? 6 : 5;
      }
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
      assert.deepEqual(record.installable_firmware, ['micropython']);
      assert.equal(record.install_firmware.build, 'ESP32_GENERIC');
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

  test('accepts variable ROM synchronization values from physical ESP32 boards', async () => {
    for (const syncValue of [0x55201207, 0x55552012, 0x55551207]) {
      const { port } = romPort({ syncValue });
      const board = await port.command(viewer.detectEspBootloader, { rawRepl: false });
      assert.equal(board.machine, 'ESP32');
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
    assert.equal(attempts, 2);
    assert.equal(port.probePromise, null);
    port.probeFailure.retryAt = 0;
    await assert.rejects(viewer.probe(port.dev), /watchdog resets/);
    assert.equal(attempts, 4);
  });

  test('retries identification once after two seconds without exposing the first failure', async () => {
    const { port } = romPort();
    const write = port.write;
    let attempts = 0;
    const started = Date.now();
    port._enterRaw = async () => { attempts++; throw new Error('not ready'); };
    port.write = async wire => {
      if (attempts === 1) throw new Error('board is still starting');
      return write(wire);
    };
    viewer._test.setDevices([{ dev: port.dev, port }]);
    try {
      const pending = viewer.probe(port.dev);
      await new Promise(resolve => setImmediate(resolve));
      for (let i = 0; i < 2; i++) {
        const [device] = await viewer.scanDevices({ waitForProbes: false });
        assert.equal(device.probing, true);
        assert.equal(port.probeFailure, null);
        assert.equal(attempts, 1);
      }
      const board = await pending;
      assert.equal(board.machine, 'ESP32');
      assert.equal(attempts, 2);
      assert.ok(Date.now() - started >= 1900);
      assert.equal(port.probeFailure, null);
    } finally { viewer._test.clearDevices(); }
  });

  test('explains download-mode recovery when ESP flash headers are invalid', async () => {
    const { port } = romPort({ stub: true });
    port._enterRaw = async () => { throw new Error('invalid header: 0xffffffff'); };
    await assert.rejects(viewer.probe(port.dev), /invalid flash header.*Hold BOOT.*3 seconds/);
    assert.equal(port.probePromise, null);
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
    await assert.rejects(viewer.espRomCommand(port, 8, Buffer.alloc(0), 20),
      /ESP ROM did not respond to command 0x08/);
    assert.equal(port.capture, null);
    await assert.rejects(viewer.espRomCommand(port, 5), /Unsupported/);
    port.inCommand = false;
  });

  test('validates ESP images and maps supported MicroPython builds', () => {
    const mappings = [
      ['ESP32', 0, 0x1000, 'ESP32_GENERIC'],
      ['ESP32-S2', 2, 0x1000, 'ESP32_GENERIC_S2'],
      ['ESP32-C3', 5, 0, 'ESP32_GENERIC_C3'],
      ['ESP32-S3', 9, 0, 'ESP32_GENERIC_S3'],
    ];
    for (const [chip, chipId, offset, build] of mappings) {
      const firmware = viewer.espFirmwareForChip(chip);
      assert.equal(firmware.chipId, chipId);
      assert.equal(firmware.offset, offset);
      assert.equal(firmware.build, build);
      assert.equal(viewer.espImageInfo(makeEspImage(chipId), chipId).flashSize, 4 * 1024 * 1024);
    }
    assert.equal(viewer.espFirmwareForChip('ESP32-C6'), null);
    const firmware = viewer.espFirmwareForChip('ESP32-S3');
    assert.equal(viewer.resolveEspFirmwareUrl(firmware,
      '<a href="/resources/firmware/ESP32_GENERIC_S3-v1.app-bin">app</a>' +
      '<a href="/resources/firmware/ESP32_GENERIC_S3-20260824-v1.29.0.bin">bin</a>'),
    'https://micropython.org/resources/firmware/ESP32_GENERIC_S3-20260824-v1.29.0.bin');
    assert.throws(() => viewer.resolveEspFirmwareUrl(firmware,
      '<a href="https://example.com/ESP32_GENERIC_S3-v1.bin">other host</a>'), /Could not find/);
    assert.throws(() => viewer.espImageInfo(makeEspImage(5), 9), /different ESP32 chip/);
    const corrupt = makeEspImage(0);
    corrupt[40] ^= 1;
    assert.throws(() => viewer.espImageInfo(corrupt, 0), /checksum/);
    const hashed = makeEspImage(9);
    hashed[23] = 1;
    require('node:crypto').createHash('sha256').update(hashed.subarray(0, hashed.length - 32))
      .digest().copy(hashed, hashed.length - 32);
    assert.equal(viewer.espImageInfo(hashed, 9).hasSha256, true);
    hashed[hashed.length - 1] ^= 1;
    assert.throws(() => viewer.espImageInfo(hashed, 9), /SHA-256/);
  });

  test('resolves and downloads the latest stable combined ESP image', async () => {
    const firmware = viewer.espFirmwareForChip('ESP32-S2');
    const image = makeEspImage(2);
    const seen = [];
    const result = await viewer.downloadEspFirmware(firmware, async url => {
      seen.push(url);
      return url === firmware.page
        ? Buffer.from('<a href="/resources/firmware/ESP32_GENERIC_S2-v1.app-bin">app</a>' +
          '<a href="/resources/firmware/ESP32_GENERIC_S2-20260824-v1.29.0.bin">bin</a>')
        : image;
    });
    assert.equal(result, image);
    assert.deepEqual(seen, [
      firmware.page,
      'https://micropython.org/resources/firmware/ESP32_GENERIC_S2-20260824-v1.29.0.bin',
    ]);
  });

  test('reports the failing firmware block and stops before verification or reboot', async () => {
    const image = makeEspImage(0);
    const { port, requests } = romPort({ allowFlash: true, flashFailures: 2 });
    const device = await port.command(viewer.detectEspBootloader, { rawRepl: false });
    await assert.rejects(port.command(active => viewer.flashEspImage(
      active, device, viewer.espFirmwareForChip('ESP32'), image,
    ), { rawRepl: false }), /command 0x03 \(error 0x05\).*block 1\/1, flash address 0x00001000, after 2 attempts/);
    assert.equal(requests.filter(request => request[1] === 3).length, 2);
    assert.ok(!requests.some(request => [4, 19].includes(request[1])));
  });

  test('writes, checksums, verifies, and reboots an ESP image through the ROM', async () => {
    const image = makeEspImage(0, Buffer.alloc(1200, 0x5a));
    const md5 = require('node:crypto').createHash('md5').update(image).digest('hex');
    const { port, requests } = romPort({ allowFlash: true, flashedMd5: md5, flashFailures: 1 });
    port.info = await port.command(viewer.detectEspBootloader, { rawRepl: false });
    const device = port.info;
    const progress = [];
    const result = await port.command(active => viewer.flashEspImage(
      active, device, viewer.espFirmwareForChip('ESP32'), image,
      update => progress.push(update),
    ), { rawRepl: false });
    assert.equal(result.md5, md5);
    const opcodes = requests.map(request => request[1]);
    assert.ok(opcodes.includes(13), 'SPI_ATTACH sent');
    assert.ok(opcodes.includes(11), 'SPI_SET_PARAMS sent');
    assert.ok(opcodes.includes(2), 'FLASH_BEGIN sent');
    assert.ok(opcodes.includes(3), 'FLASH_DATA sent');
    assert.ok(opcodes.includes(19), 'SPI_FLASH_MD5 sent');
    assert.equal(opcodes.at(-1), 4, 'FLASH_END reboots only after verification');
    const begin = requests.find(request => request[1] === 2).subarray(8);
    assert.deepEqual([
      begin.readUInt32LE(0), begin.readUInt32LE(4), begin.readUInt32LE(8), begin.readUInt32LE(12),
    ], [image.length, Math.ceil(image.length / 0x400), 0x400, 0x1000]);
    for (const request of requests.filter(request => request[1] === 3)) {
      const block = request.subarray(24);
      assert.equal(request.readUInt32LE(4), viewer.espChecksum(block));
      assert.equal(request.readUInt32LE(8), block.length);
    }
    assert.equal(progress.at(-1).stage, 'rebooting');
    const writeProgress = progress.filter(update => update.stage === 'writing')
      .map(update => update.percent);
    assert.equal(writeProgress[0], 0);
    assert.equal(writeProgress.at(-1), 100);
    assert.deepEqual(writeProgress, [...writeProgress].sort((a, b) => a - b));
  });

  test('erases and verifies ESP32 storage when initialization is selected', async () => {
    const firmware = viewer.espFirmwareForChip('ESP32');
    const image = withPartitionTable(makeEspImage(0), firmware, [
      { offset: 0x9000, size: 0x6000, label: 'nvs' },
      { offset: 0x10000, size: 0x1f0000, label: 'factory' },
      { offset: 0x200000, size: 0x200000, label: 'vfs' },
    ]);
    const storage = { offset: 0x200000, size: 0x200000 };
    const imageMd5 = require('node:crypto').createHash('md5').update(image).digest('hex');
    const storageMd5 = require('node:crypto').createHash('md5')
      .update(Buffer.alloc(storage.size, 0xff)).digest('hex');
    const { port, requests } = romPort({
      allowFlash: true, flashedMd5: imageMd5,
      storageOffset: storage.offset, storageMd5,
    });
    port.info = await port.command(viewer.detectEspBootloader, { rawRepl: false });
    const progress = [];
    const result = await port.command(active => viewer.flashEspImage(
      active, port.info, firmware, image,
      update => progress.push(update), { initializeStorage: true },
    ), { rawRepl: false });

    assert.deepEqual(result.storage, storage);
    assert.deepEqual(viewer.espStorageRange(image, firmware, 4 * 1024 * 1024), storage);
    const releaseLayout = withPartitionTable(makeEspImage(0), firmware, [
      { offset: 0x9000, size: 0x6000, label: 'nvs' },
      { offset: 0xf000, size: 0x1000, label: 'phy_init' },
      { offset: 0x10000, size: 0x1f0000, label: 'factory' },
    ]);
    assert.deepEqual(viewer.espStorageRange(releaseLayout, firmware, 4 * 1024 * 1024), storage);
    const opcodes = requests.map(request => request[1]);
    assert.ok(opcodes.indexOf(16) > opcodes.indexOf(19), 'storage is erased only after firmware verification');
    assert.ok(opcodes.lastIndexOf(19) < opcodes.indexOf(4), 'storage verification completes before reboot');
    assert.ok(opcodes.includes(17), 'compressed blank data is sent');
    assert.equal(opcodes.includes(18), false, 'do not exit the ROM before storage verification');
    const compressed = Buffer.concat(requests.filter(request => request[1] === 17).map(request => {
      const length = request.readUInt32LE(8);
      const block = request.subarray(24, 24 + length);
      assert.ok(length > 0 && length <= 0x400);
      assert.equal(request.readUInt32LE(4), viewer.espChecksum(block));
      return block;
    }));
    const blank = require('node:zlib').inflateSync(compressed);
    assert.deepEqual(compressed, require('node:zlib').deflateSync(blank, { level: 9 }), 'no padding after compressed data');
    assert.equal(blank.length, storage.size);
    assert.equal(blank.every(byte => byte === 0xff), true);
    const storageMd5Request = requests.find(request =>
      request[1] === 19 && request.readUInt32LE(8) === storage.offset);
    assert.equal(storageMd5Request.readUInt32LE(12), storage.size);
    const initializationProgress = progress.filter(update => update.stage === 'initializing').map(update => update.percent);
    assert.equal(initializationProgress[0], 0);
    assert.equal(initializationProgress.at(-1), 100);
    assert.ok(initializationProgress.some(percent => percent > 0 && percent < 100));
  });

  test('does not reboot when ESP flash verification fails', async () => {
    const image = makeEspImage(5, Buffer.alloc(1100, 0xa5));
    const { port, requests } = romPort({ modernId: 5, allowFlash: true, flashedMd5: '0'.repeat(32) });
    port.info = await port.command(viewer.detectEspBootloader, { rawRepl: false });
    const device = port.info;
    await assert.rejects(port.command(active => viewer.flashEspImage(
      active, device, viewer.espFirmwareForChip('ESP32-C3'), image,
    ), { rawRepl: false }), /verification failed/);
    assert.equal(requests.some(request => request[1] === 4), false);
  });

  test('keeps a verified install successful when the ROM cannot reboot itself', async () => {
    const image = makeEspImage(0, Buffer.alloc(1100, 0x33));
    const md5 = require('node:crypto').createHash('md5').update(image).digest('hex');
    for (const resetOptions of [{ refuseReboot: true }, { silentReboot: true }]) {
      const { port } = romPort({ allowFlash: true, flashedMd5: md5, ...resetOptions });
      port.info = await port.command(viewer.detectEspBootloader, { rawRepl: false });
      const result = await port.command(active => viewer.flashEspImage(
        active, port.info, viewer.espFirmwareForChip('ESP32'), image,
      ), { rawRepl: false });
      assert.equal(result.md5, md5);
      assert.equal(result.rebooted, false);
    }
  });

  test('hard-resets ESP32 UART and native USB after verification and retains the startup session', async () => {
    for (const [chipId, chip, dev, resetMode] of [
      [0, 'ESP32', '/dev/ttyUSB0', 'normal'], [5, 'ESP32-C3', '/dev/ttyACM0', 'usb-normal'],
    ]) {
    const image = makeEspImage(chipId);
    const md5 = require('node:crypto').createHash('md5').update(image).digest('hex');
    const { port, requests } = romPort({ modernId: chipId || undefined, allowFlash: true, flashedMd5: md5 });
    port.dev = dev;
    port.info = await port.command(viewer.detectEspBootloader, { rawRepl: false });
    let resets = 0, closes = 0;
    port._close = () => { closes++; };
    port.fd = 42;
    const result = await port.command(active => viewer.flashEspImage(
      active, port.info, viewer.espFirmwareForChip(chip), image, () => {}, {
        resetLines: async (_fd, mode) => {
          resets++;
          assert.equal(mode, resetMode);
          assert.equal(requests.at(-1)[1], 19, 'reset directly after MD5 verification');
          assert.ok(requests.some(request => request[1] === 19), 'firmware verified first');
        },
      },
    ), { rawRepl: false });
    assert.equal(result.rebooted, true);
    assert.equal(resets, 1);
    assert.equal(closes, 0);
    assert.equal(port.info, null);
    assert.ok(port.rebootingUntil > Date.now());
    port.fd = null;
    }
  });

  test('falls back to ROM reboot when hardware reset control is unavailable', async () => {
    const { port, requests } = romPort({ allowFlash: true });
    port.fd = 42;
    try {
      assert.equal(await port.command(active => viewer.rebootEspAfterInstall(active, { machine: 'ESP32' },
        async () => { throw new Error('no control lines'); }), { rawRepl: false }), true);
      assert.equal(requests.at(-1)[1], 4);
      assert.equal(requests.at(-1).readUInt32LE(8), 0);
    } finally { port.fd = null; }
  });

  test('refuses protected ESP chips before issuing a flash command', async () => {
    const image = makeEspImage(5);
    const { port, requests } = romPort({ modernId: 5, allowFlash: true, securityFlags: 1 });
    port.info = await port.command(viewer.detectEspBootloader, { rawRepl: false });
    const device = port.info;
    await assert.rejects(port.command(active => viewer.flashEspImage(
      active, device, viewer.espFirmwareForChip('ESP32-C3'), image,
    ), { rawRepl: false }), /security enabled/);
    assert.equal(requests.some(request => [2, 3, 4, 11, 13, 19].includes(request[1])), false);
  });

  test('prevents two ESP installations from sharing one serial port', async () => {
    const image = makeEspImage(0, Buffer.alloc(1050, 0x11));
    const md5 = require('node:crypto').createHash('md5').update(image).digest('hex');
    const { port } = romPort({ allowFlash: true, flashedMd5: md5 });
    port.info = await port.command(viewer.detectEspBootloader, { rawRepl: false });
    viewer._test.setDevices([{ dev: port.dev, port }]);
    let releasePage;
    const page = new Promise(resolve => { releasePage = resolve; });
    const download = async url => url.endsWith('/') ? page : image;
    const first = viewer.installEspFirmware(port.dev, download);
    await assert.rejects(viewer.installEspFirmware(port.dev, download), /already running/);
    releasePage(Buffer.from('<a href="/resources/firmware/ESP32_GENERIC-20260824-v1.29.0.bin">bin</a>'));
    assert.equal((await first).ok, true);
  });
});

describe('pure helpers', () => {
  test('prints CLI help and version without starting the server', () => {
    const help = spawnSync(process.execPath, ['pico-bay.js', '--help'], {
      cwd: PROJECT_DIR, encoding: 'utf8',
    });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^Usage: pico-bay \[options\]/);
    assert.equal(help.stderr, '');

    const version = spawnSync(process.execPath, ['pico-bay.js', '--version'], {
      cwd: PROJECT_DIR, encoding: 'utf8',
    });
    assert.equal(version.status, 0);
    assert.equal(version.stdout.trim(), require('../package.json').version);
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
    assert.equal(viewer.cleanPath('\\'), null);
    assert.equal(viewer.cleanPath('lib\\..'), null);
  });

  test('mounted paths reject roots and Windows traversal while allowing drive-root children', () => {
    const mountedPath = viewer._test.mountedPath;
    for (const bad of ['/', '.', '..', '\\', 'lib\\..', '../outside', 'E:', 'E:/', 'C:/secret', 'lib/.. ', '...']) {
      assert.equal(mountedPath('E:\\', bad, path.win32), null, bad);
    }
    assert.equal(mountedPath('E:\\', 'lib/code.py', path.win32), 'E:\\lib\\code.py');
    assert.equal(mountedPath('/Volumes/CIRCUITPY', 'lib/code.py', path.posix), '/Volumes/CIRCUITPY/lib/code.py');
    assert.equal(mountedPath('/Volumes/CIRCUITPY', '/', path.posix), null);
  });

  test('hardware-test failure still cleans up its empty file', async t => {
    const written = [], removed = [];
    t.mock.method(viewer, 'writeFile', async (_dev, file) => { written.push(file); });
    t.mock.method(viewer, 'readFile', async (_dev, file) => {
      if (file.endsWith('_empty')) throw new Error('empty read failed');
      return Buffer.from('pico-bay hardware test\n');
    });
    t.mock.method(viewer, 'removePath', async (_dev, file) => { removed.push(file); });
    await assert.rejects(testPhysicalMicroPython({ dev: '/dev/mock' }), /empty read failed/);
    assert.equal(written.length, 2);
    for (const file of written) assert.ok(removed.includes(file), file);
  });

  test('CircuitPython console checks reject marker-containing errors and stderr', async t => {
    const device = firmwareInfo('circuitpython', true);
    t.mock.method(viewer, 'requireWritable', async () => { throw new Error('read-only'); });
    let command = async () => { throw new Error('timeout after PICO_BAY_CONSOLE_OK'); };
    t.mock.method(viewer, 'getPort', () => ({ command: (...args) => command(...args) }));
    await assert.rejects(testPhysicalCircuitPython(device), /timeout after/);
    command = async () => ({ out: 'PICO_BAY_CONSOLE_OK\n', err: 'RuntimeError: failed\n' });
    await assert.rejects(testPhysicalCircuitPython(device), /must not produce stderr/);
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

  test('waits for Linux device metadata and scans even when udevadm is unavailable', async () => {
    for (const unavailable of [false, true]) {
      const calls = [];
      const result = await viewer.linuxBlockDevices(async (command, args, options) => {
        calls.push(command);
        assert.ok(options.timeout <= 3000);
        if (command === 'udevadm') {
          assert.ok(args.includes('--timeout=2'));
          if (unavailable) throw new Error('udevadm not found');
          return '';
        }
        assert.ok(args.includes('--tree'), 'inherit serial numbers from parent disks');
        assert.match(args.at(-1), /MOUNTPOINT$/);
        return '{"blockdevices":[]}';
      });
      assert.deepEqual(calls, ['udevadm', 'lsblk']);
      assert.equal(result, '{"blockdevices":[]}');
    }
  });

  test('recognizes mounted and unmounted Pico volumes with legacy Linux mountpoint fields', () => {
    const output = JSON.stringify({ blockdevices: [
      { path: '/dev/sda', serial: 'pico-id', children: [
        { path: '/dev/sda1', label: 'RPI-RP2', mountpoint: '/media/pi/RPI-RP2' },
      ] },
      { path: '/dev/sdb1', label: 'RP2350', mountpoint: null },
      { path: '/dev/sdc1', label: 'CIRCUITPY', fstype: 'vfat', mountpoint: '/media/pi/CIRCUITPY' },
      { path: '/dev/sdd1', label: 'CIRCUITPY', fstype: 'vfat', serial: 'circuit-id', mountpoint: null },
    ] });
    assert.deepEqual(viewer.parseBootselBlockDevices(output).map(board => [board.mountRoot, board.uid]),
      [['/media/pi/RPI-RP2', 'pico-id'], [null, '']]);
    assert.deepEqual(viewer.parseLinuxCircuitPartitions(output), ['/dev/sdd1']);
    assert.deepEqual([...viewer.parseLinuxUnmountedCircuitVolumes(output)], [['circuit-id', '/dev/sdd1']]);
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

  test('BOOTSEL feedback accepts any detected BOOTSEL board', async () => {
    const html = fs.readFileSync(path.join(PROJECT_DIR, 'page.html'), 'utf8');
    const start = html.indexOf('  async function waitForBootsel(');
    const end = html.indexOf('  async function doBootloader()', start);
    let scans = 0;
    const context = require('node:vm').createContext({
      devices: [],
      setTimeout: resolve => resolve(),
      loadDevices: async () => { scans++; },
    });
    require('node:vm').runInContext(html.slice(start, end), context);
    const source = { dev: '/dev/cu.usbmodem1', uid: 'e6601234' };
    for (const uid of ['OTHER', 'E6601234', '']) {
      const bootsel = { firmware: 'bootsel', dev: 'bootsel:/Volumes/RPI-RP2', uid };
      context.devices = [source, bootsel];
      scans = 0;
      assert.equal(await context.waitForBootsel(), bootsel);
      assert.equal(scans, 1, 'an existing BOOTSEL board is accepted immediately');
    }
    context.devices = [source];
    scans = 0;
    assert.equal(await context.waitForBootsel(), null);
    assert.equal(scans, 15, 'waits for BOOTSEL before reporting failure');
    scans = 0;
    context.loadDevices = async () => {
      if (++scans === 3) context.devices.push({ firmware: 'bootsel' });
    };
    assert.equal((await context.waitForBootsel()).firmware, 'bootsel');
    assert.equal(scans, 3);
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

  test('finds multiple macOS BOOTSEL mounts with numbered volume names', () => {
    const mounts = [
      '/dev/disk4s1 on /Volumes/RPI-RP2 (msdos, local)',
      '/dev/disk5s1 on /Volumes/RPI-RP2 1 (msdos, local)',
      '/dev/disk6 on /Volumes/RP2350 2 (msdos, local)',
      '/dev/disk7s1 on /Volumes/RPI-RP2-backup (msdos, local)',
      '/dev/disk8s1 on /Volumes/CIRCUITPY (msdos, local)',
    ].join('\n');
    const boards = viewer.parseDarwinBootselVolumes(mounts);
    assert.deepEqual(boards.map(board => [board.machine, board.mountRoot]), [
      ['RP2040', '/Volumes/RPI-RP2'], ['RP2040', '/Volumes/RPI-RP2 1'], ['RP2350', '/Volumes/RP2350 2'],
    ]);
    assert.equal(new Set(boards.map(board => board.dev)).size, 3);
    assert.deepEqual(viewer.parseDarwinBootselVolumes(''), []);
  });

  function makeUf2(family = 0xe48bff56, count = 2) {
    const image = Buffer.alloc(count * 512);
    for (let i = 0; i < count; i++) {
      const block = image.subarray(i * 512, (i + 1) * 512);
      [0x0a324655, 0x9e5d5157, 0x2000, 0x10000000 + i * 256, 256, i, count, family]
        .forEach((value, index) => block.writeUInt32LE(value, index * 4));
      block.writeUInt32LE(0x0ab16f30, 508);
    }
    return image;
  }

  test('validates all UF2 blocks, chip families, counts, payloads, and RP2350 prefix', () => {
    assert.doesNotThrow(() => viewer.validateUf2Image(makeUf2(), 'RP2040'));
    for (const family of [0xe48bff59, 0xe48bff5a, 0xe48bff5b]) {
      assert.doesNotThrow(() => viewer.validateUf2Image(makeUf2(family), 'RP2350'));
    }
    const bad = [Buffer.alloc(512), makeUf2().subarray(0, 513), makeUf2().subarray(0, 512)];
    for (const [offset, value] of [[512, 0], [1020, 0], [8, 0], [28, 123], [16, 480],
      [16, 0], [12, 0x20000000], [12, 0x10000001], [532, 0], [536, 3], [524, 0x10000000]]) {
      const image = makeUf2();
      image.writeUInt32LE(value, offset);
      bad.push(image);
    }
    for (const image of bad) assert.throws(() => viewer.validateUf2Image(image, 'RP2040'), /Invalid UF2/);
    assert.throws(() => viewer.validateUf2Image(makeUf2(), 'RP2350'), /family/);
    const reordered = makeUf2();
    assert.doesNotThrow(() => viewer.validateUf2Image(Buffer.concat([
      reordered.subarray(512), reordered.subarray(0, 512),
    ]), 'RP2040'));
    const prefix = makeUf2(0xe48bff57).subarray(0, 512);
    prefix.writeUInt32LE(0xa000, 8);
    prefix.writeUInt32LE(0x10ffff00, 12);
    prefix.fill(0xef, 32, 288);
    prefix.writeUInt32LE(0x9957e304, 288);
    assert.doesNotThrow(() => viewer.validateUf2Image(Buffer.concat([prefix, makeUf2(0xe48bff59)]), 'RP2350'));
    assert.throws(() => viewer.validateUf2Image(prefix, 'RP2350'), /no firmware/);
    prefix[32] = 0;
    assert.throws(() => viewer.validateUf2Image(Buffer.concat([prefix, makeUf2(0xe48bff59)]), 'RP2350'), /prefix/);
  });

  test('reports each BOOTSEL installation stage while copying firmware', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pico-bay-bootsel-progress-'));
    const image = makeUf2();
    const device = {
      dev: 'bootsel:/dev/test-progress', machine: 'RP2040', mountRoot: root,
    };
    const progress = [];
    viewer._test.setBootselDevices([device]);
    try {
      const result = await viewer.installBootselFirmware(
        device.dev, 'pico-w', async () => image,
        update => progress.push(update),
      );
      assert.equal(result.firmware, 'Raspberry Pi Pico W');
      assert.deepEqual(progress.map(update => update.stage), [
        'downloading', 'validating', 'writing', 'rebooting',
      ]);
      assert.equal(fs.readFileSync(path.join(root, 'rp2-pico-w-latest.uf2')).equals(image), true);
      const malformed = Buffer.from(image);
      malformed.writeUInt32LE(0, 1020);
      progress.length = 0;
      await assert.rejects(viewer.installBootselFirmware(device.dev, 'pico-w', async () => malformed,
        update => progress.push(update)), /Invalid UF2/);
      assert.ok(!progress.some(update => update.stage === 'writing'));
      assert.ok(fs.readFileSync(path.join(root, 'rp2-pico-w-latest.uf2')).equals(image),
        'invalid downloads leave the existing file unchanged');
    } finally {
      viewer._test.clearDevices();
      fs.rmSync(root, { recursive: true, force: true });
    }
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
      fs.symlinkSync(os.tmpdir(), path.join(root, 'outside'), process.platform === 'win32' ? 'junction' : null);
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

  test('keeps the event loop responsive while a USB serial close is stalled', async t => {
    let finishClose;
    t.mock.method(fs, 'close', (_fd, callback) => { finishClose = callback; });
    const port = viewer.getPort('/dev/test-stalled-close');
    port.fd = 42;
    port._close();
    assert.equal(port.fd, null);
    assert.equal(port.closing, true);
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(port._open(), /still closing/);
    await assert.rejects(port._waitForClose(20), /still closing/);
    finishClose(null);
    assert.equal(port.closing, false);
    viewer._test.clearDevices();
  });

  test('waits for an in-flight serial close before starting the next command', async t => {
    let finishClose;
    t.mock.method(fs, 'close', (_fd, callback) => { finishClose = callback; });
    const port = viewer.getPort('/dev/test-close-before-command');
    port.fd = 42;
    port._close();
    let opened = false;
    t.mock.method(port, '_open', () => {
      assert.equal(port.closing, false);
      opened = true;
    });
    const command = port.command(async () => 'backup ready', { rawRepl: false });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(opened, false);
    finishClose(null);
    assert.equal(await command, 'backup ready');
    assert.equal(opened, true);
    viewer._test.clearDevices();
  });

  test('recovers the command queue after a serial close timeout', async t => {
    const port = viewer.getPort('/dev/test-close-timeout');
    port.closing = true;
    const waitForClose = port._waitForClose.bind(port);
    t.mock.method(port, '_waitForClose', () => waitForClose(20));
    t.mock.method(port, '_open', () => {});
    let ran = false;
    await assert.rejects(port.command(async () => { ran = true; }, { rawRepl: false }), /still closing/);
    assert.equal(ran, false);
    assert.equal(port.busy, false);
    assert.equal(port.inCommand, false);
    port.closing = false;
    t.mock.method(port, '_enterRaw', async () => {});
    t.mock.method(port, '_resume', async () => {});
    assert.equal(await port.command(async () => 'recovered'), 'recovered');
    await port.releaseNow();
    viewer._test.clearDevices();
  });

  test('keeps a halted board open until release resumes its program', async t => {
    const port = viewer.getPort('/dev/test-console-release');
    const monitor = () => {};
    port.fd = 42;
    port.halted = true;
    port.monitors.add(monitor);
    const events = [];
    t.mock.method(port, '_resume', async () => { events.push('resume'); });
    t.mock.method(port, '_close', () => { events.push('close'); port.fd = null; });
    port.removeMonitor(monitor);
    assert.equal(port.fd, 42);
    await port.releaseNow();
    assert.deepEqual(events, ['resume', 'close']);
    viewer._test.clearDevices();
  });

  test('ignores old serial reads after reopening even when the fd is reused', async t => {
    let completeRead;
    t.mock.method(fs, 'read', (_fd, buffer, _offset, _length, _position, callback) => {
      completeRead = error => { buffer.write('stale'); callback(error, error ? 0 : 5); };
    });
    t.mock.method(fs, 'close', (_fd, callback) => callback(null));
    for (const error of [new Error('device disconnected'), null]) {
      const port = viewer.getPort('/dev/test-reopened');
      const info = { firmware: 'micropython' };
      const received = [];
      port.fd = 42;
      port.info = info;
      port._onData = chunk => received.push(chunk);
      const pump = port._pump();
      const oldRead = completeRead;
      port._close();
      port.fd = 42;
      port.connectionGeneration++;
      oldRead(error);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(port.fd, 42);
      assert.equal(port.info, info);
      assert.deepEqual(received, []);
      port._close();
      completeRead(null);
      await pump;
    }
    viewer._test.clearDevices();
  });

  test('does not leave a raw REPL timeout pending when its write fails', async () => {
    const port = viewer.getPort('/dev/test-repl-write-failure');
    port.write = async data => {
      if (data === '\x01') throw new Error('Board disconnected during write');
    };
    try {
      await assert.rejects(port._enterRaw(0), /disconnected during write/);
      assert.equal(port.capture, null);
      // An orphaned read would reject after 400 ms and fail the test process.
      await new Promise(resolve => setTimeout(resolve, 450));
    } finally { viewer._test.clearDevices(); }
  });

  test('preserves a raw REPL reply received before the write completes', async () => {
    const port = viewer.getPort('/dev/test-repl-fast-reply');
    port.inCommand = true;
    port.write = async data => {
      if (data === '\x01') port._onData('raw REPL; CTRL-B to exit\r\n>');
    };
    try {
      await port._enterRaw(0);
      assert.equal(port.capture, null);
    } finally { viewer._test.clearDevices(); }
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
    viewer._test.setDevices([]);
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
      assert.deepEqual(boards.result.structuredContent.boards.map(board => board.board_id), ['BOOTSEL-ID']);
      const bootsel = boards.result.structuredContent.boards[0];
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

  test('checks and installs MicroPython on a confirmed ESP DOWNLOAD board', async () => {
    const firmware = viewer.espFirmwareForChip('ESP32-S3');
    const device = {
      dev: '/dev/test-esp-install', uid: 'ESP-INSTALL-ID', ok: true, bootMode: true,
      bootloader: 'esp-rom', firmware: 'esp-bootloader', firmwareLabel: 'Download mode',
      machine: 'ESP32-S3', label: 'ESP32-S3', serial: '', readOnly: true,
      bootDetails: {
        securityChecked: true, installSupported: true,
        secureDownload: false, secureBoot: false, flashEncryption: false,
      },
      installFirmware: { id: firmware.id, name: firmware.name, build: firmware.build,
        page: firmware.page, address: firmware.offset },
      capabilities: { read: false, write: false, run: false, console: false },
    };
    viewer._test.setDevices([{ dev: device.dev, port: fakePort(device) }]);
    const calls = [];
    viewer._test.setEspInstaller(async (dev, _download, _progress, options) => {
      calls.push({ dev, options });
      return { ok: true, bytes: 4567 };
    });
    const call = (id, args) => viewer.dispatchMcp({
      jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'pico_install', arguments: args, _meta: modernMeta },
    });
    try {
      const check = await call(14, {
        board_id: device.uid, action: 'check', firmware: 'micropython',
      });
      assert.equal(check.result.structuredContent.status, 'ready');
      assert.equal(check.result.structuredContent.build, 'ESP32_GENERIC_S3');
      const unconfirmed = await call(15, {
        board_id: device.uid, action: 'install', firmware: 'micropython',
      });
      assert.equal(unconfirmed.result.isError, true);
      assert.match(unconfirmed.result.content[0].text, /confirmed must be true/);
      const installed = await call(16, {
        board_id: device.uid, action: 'install', firmware: 'micropython', confirmed: true,
      });
      assert.equal(installed.result.structuredContent.status, 'installed');
      assert.equal(installed.result.structuredContent.model, 'MicroPython for ESP32-S3');
      assert.equal(installed.result.structuredContent.storage_initialized, true);
      assert.deepEqual(calls, [{ dev: device.dev, options: { initializeStorage: true } }]);
    } finally { viewer._test.clearDevices(); }
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
  let finishBootselInstall;
  let finishEspInstall;
  let espInstallOptions;
  const initializedStorage = [];

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
      logErrors: false,
      mcpHttp: true,
      installBootsel: async (dev, firmware, _download, progress) => {
        progress({ stage: 'validating', percent: 0 });
        await new Promise(resolve => { finishBootselInstall = resolve; });
        return { ok: true, dev, firmware: 'MicroPython for Pico W', firmwareId: firmware };
      },
      installEsp: async (dev, _download, progress, options) => {
        espInstallOptions = options;
        progress({ stage: 'writing', percent: 42 });
        await new Promise(resolve => { finishEspInstall = resolve; });
        return { ok: true, dev, firmware: 'MicroPython for ESP32' };
      },
      initializeStorage: async dev => {
        initializedStorage.push(dev);
        return { ok: true, initialized: true, fsTotal: 2097152, fsFree: 2088960 };
      },
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
    assert.ok(body.devices.every(device => device.bootloaderMode === null), 'unknown boards have no bootloader action');
    assert.deepEqual(body.devices.map(device => [device.firmware, device.readOnly]).sort(), [
      ['circuitpython', true],
      ['micropython', false],
    ]);
  });

  test('offers ESP32 storage recovery for create, upload, folder, and ZIP restore flows', async () => {
    const response = await fetch(baseUrl + '/');
    assert.equal(response.status, 200);
    const html = await response.text();
    const recoveredRoutes = [...html.matchAll(
      /withEspStorageRecovery\(function \(\) \{\s*return api\('([^']+)/g,
    )].map(match => match[1]);
    assert.ok(recoveredRoutes.some(route => route.startsWith('/api/touch?')));
    assert.ok(recoveredRoutes.some(route => route.startsWith('/api/file?')));
    assert.ok(recoveredRoutes.some(route => route.startsWith('/api/mkdir?')));
    assert.ok(recoveredRoutes.includes('/api/restore'));
  });

  test('requires confirmation before initializing ESP32 storage', async () => {
    const dev = encodeURIComponent('/dev/test-micropython');
    const denied = await api('/api/storage/initialize?dev=' + dev, { method: 'POST' });
    assert.equal(denied.response.status, 400);
    assert.match(denied.body.error, /confirmed/);
    const initialized = await api('/api/storage/initialize?confirmed=1&dev=' + dev, { method: 'POST' });
    assert.equal(initialized.response.status, 200);
    assert.equal(initialized.body.fsTotal, 2097152);
    assert.deepEqual(initializedStorage, ['/dev/test-micropython']);
  });

  test('installs an explicitly selected BOOTSEL firmware', async () => {
    const started = await api('/api/bootsel/install?dev=bootsel%3A%2Fdev%2Fsda1&firmware=pico-w', {
      method: 'POST',
    });
    assert.equal(started.response.status, 202);
    assert.equal(started.body.status, 'running');
    await new Promise(resolve => setImmediate(resolve));
    const active = await api('/api/bootsel/install/status?id=' + started.body.id);
    assert.equal(active.body.stage, 'validating');
    finishBootselInstall();
    let completed;
    for (let attempt = 0; attempt < 10; attempt++) {
      completed = await api('/api/bootsel/install/status?id=' + started.body.id);
      if (completed.body.status === 'complete') break;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(completed.body.status, 'complete');
    assert.deepEqual(completed.body.result, {
      ok: true, dev: 'bootsel:/dev/sda1', firmware: 'MicroPython for Pico W', firmwareId: 'pico-w',
    });
  });

  test('requires confirmation and installs ESP32 firmware on the selected serial port', async () => {
    const dev = encodeURIComponent('/dev/test-micropython');
    const denied = await api('/api/esp/install?dev=' + dev, { method: 'POST' });
    assert.equal(denied.response.status, 400);
    assert.match(denied.body.error, /confirmed/);
    const started = await api('/api/esp/install?confirmed=1&initialize=1&dev=' + dev, { method: 'POST' });
    assert.equal(started.response.status, 202);
    assert.equal(started.body.status, 'running');
    assert.equal(started.body.initializeStorage, true);
    await new Promise(resolve => setImmediate(resolve));
    const devices = await api('/api/devices');
    const installing = devices.body.devices.find(device => device.dev === '/dev/test-micropython');
    assert.equal(installing.installJob.stage, 'writing');
    assert.equal(installing.installJob.percent, 42);
    assert.equal(installing.installJob.initializeStorage, true);
    assert.deepEqual(espInstallOptions, { initializeStorage: true });
    finishEspInstall();
    let completed;
    for (let attempt = 0; attempt < 10; attempt++) {
      completed = await api('/api/esp/install/status?id=' + started.body.id);
      if (completed.body.status === 'complete') break;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(completed.response.status, 200);
    assert.equal(completed.body.status, 'complete');
    assert.deepEqual(completed.body.result, {
      ok: true, dev: '/dev/test-micropython', firmware: 'MicroPython for ESP32',
    });
  });

  test('logs background installation failures once while HTTP MCP remains quiet', async () => {
    const lines = [];
    const local = viewer.createServer({
      logDevices: false, mcpHttp: true, errorLogger: line => lines.push(line),
      installEsp: async (_dev, _download, progress) => {
        progress({ stage: 'writing', percent: 12 });
        throw new Error('ESP ROM rejected command 0x03 (error 0x05)');
      },
    });
    await new Promise(resolve => local.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + local.address().port;
    try {
      const response = await fetch(url + '/api/esp/install?confirmed=1&dev=/dev/test-micropython', { method: 'POST' });
      const job = await response.json();
      assert.equal(response.status, 202);
      for (let i = 0; i < 2; i++) {
        const status = await (await fetch(url + '/api/esp/install/status?id=' + job.id)).json();
        assert.equal(status.status, 'failed');
      }
      assert.equal(lines.length, 1);
      assert.match(lines[0], /ESP32 installation \(writing\) failed: .*\/dev\/test-micropython.*command 0x03/);
      await fetch(url + '/mcp', { method: 'POST', body: '{' });
      assert.equal(lines.length, 1, 'MCP failures do not add terminal logs');
    } finally {
      await new Promise(resolve => local.close(resolve));
    }
  });

  test('serves the packaged README for the full-screen help view', async () => {
    const response = await fetch(baseUrl + '/api/readme');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/markdown/);
    assert.match(await response.text(), /^# Pico Bay/m);
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

  test('fails a backup when a file cannot be read instead of writing an empty entry', async t => {
    const originalExec = circuitPort.exec;
    t.mock.method(circuitPort, 'exec', async function (code) {
      if (code.includes("print('PVD'")) throw new Error('USB read failed');
      return originalExec.call(this, code);
    });
    const { response, body } = await api('/api/zip?dev=' + encodeURIComponent('/dev/test-circuitpython'));
    assert.equal(response.status, 500);
    assert.match(body.error, /USB read failed/);
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

  test('enters BOOTSEL on read-only CircuitPython Pico and Pico 2 boards', async () => {
    const saved = circuitPort.info;
    try {
      for (const machine of ['Raspberry Pi Pico with rp2040', 'Raspberry Pi Pico W with rp2040',
        'Raspberry Pi Pico 2 with rp2350', 'Raspberry Pi Pico 2 W with rp2350']) {
        circuitPort.info = { ...saved, machine };
        const result = await api('/api/bootloader?dev=' + encodeURIComponent(saved.dev), { method: 'POST' });
        assert.equal(result.response.status, 200);
        assert.equal(result.body.ok, true);
        assert.equal(circuitPort.calls.at(-1),
          'import microcontroller\nmicrocontroller.on_next_reset(microcontroller.RunMode.BOOTLOADER)\nmicrocontroller.reset()');
      }
    } finally {
      circuitPort.info = saved;
    }
  });

  test('rejects unsupported bootloader targets and failures before the reset command', async () => {
    const saved = microPort.info;
    const command = microPort.command;
    try {
      const url = '/api/bootloader?dev=' + encodeURIComponent(saved.dev);
      const unsupported = await api(url, { method: 'POST' });
      assert.equal(unsupported.response.status, 500);
      assert.match(unsupported.body.error, /unavailable/);
      microPort.info = { ...saved, machine: 'Raspberry Pi Pico with RP2040' };
      microPort.command = async () => { throw new Error('timed out waiting for the board'); };
      const failed = await api(url, { method: 'POST' });
      assert.equal(failed.response.status, 500);
      assert.match(failed.body.error, /timed out/);
    } finally {
      microPort.info = saved;
      microPort.command = command;
    }
  });

  test('keeps MicroPython write, folder, delete, and run routes available', async () => {
    microPort.info.machine = 'Raspberry Pi Pico with RP2040';
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

    const bootloader = await api('/api/bootloader?dev=' + dev, { method: 'POST' });
    assert.equal(bootloader.response.status, 200);
    assert.equal(bootloader.body.ok, true);
    assert.ok(microPort.calls.includes('import machine\nmachine.bootloader()'));
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

describe('Windows serial lifecycle', () => {
  // Exercise the actual Windows branch without a compiler, COM port, or named pipe.
  function setup(t) {
    const { EventEmitter } = require('node:events');
    const children = [], servers = [];
    const fakeRequire = name => {
      if (name === './package.json') return require('../package.json');
      if (name === 'fs') return { ...fs, existsSync: file => String(file).endsWith('.exe') || fs.existsSync(file) };
      if (name === 'net') return { createServer() {
        const server = new EventEmitter();
        server.listen = () => {};
        server.close = () => {};
        servers.push(server);
        return server;
      } };
      if (name === 'child_process') return { ...require(name), spawn() {
        const child = new EventEmitter();
        Object.assign(child, { pid: 123, exitCode: null, signalCode: null });
        child.stdin = new EventEmitter();
        child.stdin.end = () => {};
        child.stdin.write = (_data, callback) => { if (callback) callback(); return true; };
        child.stdout = new EventEmitter();
        child.stop = () => { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); };
        children.push(child);
        return child;
      } };
      return require(name);
    };
    const context = {
      require: fakeRequire, module: { exports: {} }, __dirname: PROJECT_DIR, Buffer, console,
      process: { ...process, platform: 'win32', env: { ...process.env } },
      setTimeout, clearTimeout, setInterval, clearInterval, URL,
    };
    require('node:vm').runInNewContext(fs.readFileSync(path.join(PROJECT_DIR, 'pico-bay.js'), 'utf8'), context);
    const api = context.module.exports;
    const port = api.getPort('COM7');
    t.after(() => { for (const child of children) child.stop(); port._close(); });
    const connect = () => {
      const control = new EventEmitter();
      control.destroy = () => { control.destroyed = true; };
      control.write = (_data, callback) => { if (callback) callback(); return true; };
      servers.at(-1).emit('connection', control);
      return control;
    };
    return { api, port, children, servers, connect };
  }

  test('reopens after the helper has already exited', async t => {
    const { port, children, connect } = setup(t);
    let opening = port._open(); connect(); await opening;
    children[0].stop();
    assert.equal(port.closing, false);
    assert.equal(port.winPort, null);
    await port._waitForClose(20);
    opening = port._open(); connect(); await opening;
    assert.equal(children.length, 2);
    await port.write('hello');
  });

  test('waits for helper shutdown when explicitly closing a live port', async t => {
    const { port, children, connect } = setup(t);
    const opening = port._open(); connect(); await opening;
    port._close();
    assert.equal(port.closing, true);
    children[0].stop();
    await port._waitForClose(20);
    assert.equal(port.closing, false);
  });

  test('rejects failed helper startup without leaving the port closing', async t => {
    const { port, children } = setup(t);
    const opening = port._open();
    children[0].pid = undefined;
    children[0].emit('error', new Error('spawn failed'));
    await assert.rejects(opening, /Board disconnected/);
    assert.equal(port.closing, false);
    assert.equal(port.winPortServer, null);
  });

  test('handles named-pipe server failures during startup', async t => {
    const { port, children, servers } = setup(t);
    const opening = port._open();
    servers[0].emit('error', new Error('pipe unavailable'));
    await assert.rejects(opening, /Board disconnected/);
    children[0].stop();
    assert.equal(port.closing, false);
  });

  for (const stream of ['stdin', 'stdout', 'control']) {
    test('disconnects and rejects pending reads on ' + stream + ' errors', async t => {
      const { port, children, connect } = setup(t);
      const opening = port._open(); const control = connect(); await opening;
      const read = port.readUntil('never', 1000);
      const rejected = assert.rejects(read, /Board disconnected/);
      (stream === 'control' ? control : children[0][stream]).emit('error', new Error('broken pipe'));
      await rejected;
      children[0].stop();
      await port._waitForClose(20);
      assert.equal(port.winPort, null);
    });
  }

  test('propagates write and reset-control failures to the caller', async t => {
    const { api, port, children, connect } = setup(t);
    const opening = port._open(); const control = connect(); await opening;
    children[0].stdin.write = (_data, callback) => callback(new Error('write failed'));
    await assert.rejects(port.write('hello'), /write failed/);
    control.write = (_data, callback) => callback(new Error('reset failed'));
    await assert.rejects(api._test.winResetEspLines(port, 'normal'), /reset failed/);
    await assert.rejects(api._test.winResetEspLines({}, 'normal'), /unavailable/);
  });

  test('sends Ctrl-C through the Windows helper when interrupting a board', async t => {
    const { api, port, children, connect } = setup(t);
    const opening = port._open(); connect(); await opening;
    port.info = { ...firmwareInfo('micropython', false), dev: port.dev };
    api._test.setDevices([{ dev: port.dev, port }]);
    const writes = [];
    children[0].stdin.write = (data, callback) => {
      writes.push(Buffer.from(data));
      if (callback) callback();
      return true;
    };
    const result = await api.MCP_TOOLS.find(tool => tool.name === 'pico_board_interrupt')
      .handler({ board_id: port.dev });
    assert.equal(result.structuredContent.ok, true);
    assert.ok(Buffer.concat(writes).includes(3), 'Interrupt must send Ctrl-C, not only report success');
  });
});

describe('console serial lifecycle', () => {
  async function setup(t) {
    const port = viewer.getPort('/dev/test-console');
    viewer._test.setDevices([{ dev: port.dev, port }]);
    t.mock.method(port, '_open', () => {
      assert.equal(port.closing, false);
      port.fd = 42;
    });
    t.mock.method(port, '_close', () => { port.fd = null; });
    const server = viewer.createServer({ logDevices: false, logErrors: false });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      viewer._test.clearDevices();
    });
    return { port, server, url: 'http://127.0.0.1:' + server.address().port + '/api/console?dev=' + encodeURIComponent(port.dev) };
  }

  test('waits for serial close before attaching and cleans up when the client leaves', async t => {
    const { port, url } = await setup(t);
    port.closing = true;
    let waiting;
    const entered = new Promise(resolve => { waiting = resolve; });
    const originalWait = port._waitForClose.bind(port);
    t.mock.method(port, '_waitForClose', async () => { waiting(); await originalWait(); });
    const controller = new AbortController();
    const responsePromise = fetch(url, { signal: controller.signal });
    await entered;
    assert.equal(port.monitors.size, 0);
    port.closing = false;
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.equal(port.monitors.size, 1);
    let closed;
    const closeComplete = new Promise(resolve => { closed = resolve; });
    t.mock.method(port, '_close', () => { port.fd = null; closed(); });
    controller.abort();
    await closeComplete;
    assert.equal(port.monitors.size, 0);
  });

  test('removes a pending attachment if the client disconnects while waiting', async t => {
    const { port, server, url } = await setup(t);
    let startWaiting, finishWaiting, cleanedUp;
    const waiting = new Promise(resolve => { startWaiting = resolve; });
    const released = new Promise(resolve => { finishWaiting = resolve; });
    const cleaned = new Promise(resolve => { cleanedUp = resolve; });
    const disconnected = new Promise(resolve => {
      server.on('request', (_req, res) => res.once('close', resolve));
    });
    t.mock.method(port, '_waitForClose', async () => { startWaiting(); await released; });
    const originalRemove = port.removeMonitor.bind(port);
    t.mock.method(port, 'removeMonitor', monitor => { originalRemove(monitor); cleanedUp(); });
    const controller = new AbortController();
    const request = fetch(url, { signal: controller.signal });
    const rejected = assert.rejects(request, { name: 'AbortError' });
    await waiting;
    controller.abort();
    await rejected;
    await disconnected;
    finishWaiting();
    await cleaned;
    assert.equal(port.monitors.size, 0);
    assert.equal(port.fd, null);
  });

  test('keeps the port open for another console subscriber and an active command', async t => {
    const { port } = await setup(t);
    const first = () => {}, second = () => {};
    await port.addMonitor(first);
    await port.addMonitor(second);
    port.removeMonitor(first);
    assert.equal(port.fd, 42);
    port.busy = true;
    port.removeMonitor(second);
    assert.equal(port.fd, 42);
    port.busy = false;
    await port.releaseNow();
    assert.equal(port.fd, null);
  });

  test('returns JSON errors without leaking a monitor when opening fails', async t => {
    const { port, url } = await setup(t);
    t.mock.method(port, '_open', () => { throw new Error('Board disconnected'); });
    const response = await fetch(url);
    assert.equal(response.status, 500);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.match((await response.json()).error, /Board disconnected/);
    assert.equal(port.monitors.size, 0);
  });

  test('reports a stalled serial close without opening an event stream', async t => {
    const { port, url } = await setup(t);
    port.closing = true;
    const originalWait = port._waitForClose.bind(port);
    t.mock.method(port, '_waitForClose', () => originalWait(20));
    const response = await fetch(url);
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /still closing/);
    assert.equal(port.monitors.size, 0);
  });
});

describe('MCP stdio process', () => {
  test('writes only JSON-RPC messages to stdout', async () => {
    const child = spawn(process.execPath, ['pico-bay.js', '--mcp-stdio'], {
      cwd: PROJECT_DIR,
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
    if (process.env.CI) {
      t.skip('physical boards are not available in CI');
      return;
    }
    const devices = await viewer.scanDevices();
    if (!devices.length) {
      t.skip('no serial boards connected');
      return;
    }

    t.diagnostic('Scan found ' + devices.length + ' device(s): ' + devices.map(device => device.dev).join(', '));
    // Include bootloader boards in the report; only serial devices own ports.
    const ports = devices.filter(device => !device.bootMode || device.bootloader === 'esp-rom')
      .map(device => viewer.getPort(device.dev));
    for (const port of ports) port._cancelIdle();
    try {
      for (const device of devices) {
        const details = device.ok
          ? [device.firmwareLabel, device.label || device.machine,
            device.release && 'v' + String(device.release).replace(/^v/, ''),
            (device.uid || device.serial) && 'ID ' + (device.uid || device.serial)]
            .filter(Boolean).join(' · ')
          : 'Unidentified device';
        await t.test(details + ' on ' + device.dev, async t => {
          if (device.bootMode) {
            t.skip((device.bootloader === 'esp-rom' ? 'ROM download' : 'BOOTSEL') +
              ' mode — filesystem checks require running firmware');
            return;
          }
          if (!device.ok) {
            assert.fail(device.error || 'device probe failed');
            return;
          }
          if (device.firmware === 'micropython') {
            assert.ok(device.uid, 'MicroPython serial number is missing');
          } else if (device.firmware === 'circuitpython') {
            await t.test('capabilities and strict console response', () => testPhysicalCircuitPython(device));
          } else {
            assert.fail('unsupported connected firmware: ' + device.firmware);
          }
          if (!device.readOnly) {
            await t.test('text, empty file, listing, and deletion', () => testPhysicalMicroPython(device));
            await t.test('binary boundaries, overwrite, and truncation', () => testPhysicalBinaryFiles(device));
            await t.test('nested directories and file/folder renames', () => testPhysicalRenames(device));
          }
          await t.test('Python exception and command recovery', () => testPhysicalErrorRecovery(device));
          await t.test('run, interrupt, and run again', () => testPhysicalInterrupt(device));
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
  const empty = file + '_empty';
  const content = Buffer.from('pico-bay hardware test\n');

  try {
    await viewer.writeFile(device.dev, file, content);
    assert.deepEqual(await viewer.readFile(device.dev, file), content);

    await viewer.writeFile(device.dev, empty, Buffer.alloc(0));
    assert.deepEqual(await viewer.readFile(device.dev, empty), Buffer.alloc(0));
    await viewer.removePath(device.dev, empty);

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
    await viewer.removePath(device.dev, empty).catch(() => {});
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
  const port = viewer.getPort(device.dev);
  const result = await port.command(pt => pt.exec("print('PICO_BAY_CONSOLE_OK')"));
  assert.equal(result.err.trim(), '', 'Console command must not produce stderr');
  assert.equal(viewer.cleanReplOutput(result.out).trim(), 'PICO_BAY_CONSOLE_OK');
}

async function withPhysicalTestDirectory(device, check) {
  const root = 'pico_bay_test_' + process.pid + '_' + require('node:crypto').randomBytes(6).toString('hex');
  let created = false;
  try {
    await viewer.makeDirectory(device.dev, root);
    created = true;
    await check(root);
  } finally {
    if (created) {
      await viewer.removePath(device.dev, root);
      assert.ok(!(await viewer.listFiles(device.dev)).some(entry => entry.path === root || entry.path.startsWith(root + '/')),
        'Temporary test directory must be completely removed');
    }
  }
}

async function testPhysicalBinaryFiles(device) {
  await withPhysicalTestDirectory(device, async root => {
    const file = root + '/bytes.bin';
    // Include NUL, Ctrl-C/Ctrl-D, high bytes, and every possible byte value.
    for (const size of [255, 256, 257, 1023, 1024, 1025, 16384]) {
      const content = Buffer.from(Array.from({ length: size }, (_, i) => i & 255));
      await viewer.writeFile(device.dev, file, content);
      assert.deepEqual(await viewer.readFile(device.dev, file), content, size + '-byte binary round trip');
      const entry = (await viewer.listFiles(device.dev)).find(entry => entry.path === file);
      assert.ok(entry, 'Binary file must be listed');
      assert.equal(entry.size, size);
    }
    for (const content of [Buffer.from([0, 255, 3]), Buffer.alloc(0)]) {
      await viewer.writeFile(device.dev, file, content);
      assert.deepEqual(await viewer.readFile(device.dev, file), content, 'Overwrite must truncate previous contents');
      assert.equal((await viewer.listFiles(device.dev)).find(entry => entry.path === file).size, content.length);
    }
  });
}

async function testPhysicalRenames(device) {
  await withPhysicalTestDirectory(device, async root => {
    const folder = root + '/nested/deeper';
    const content = Buffer.from('rename preserves content\n');
    await viewer.makeDirectory(device.dev, folder);
    await viewer.writeFile(device.dev, folder + '/original.txt', content);
    await viewer.renamePath(device.dev, folder + '/original.txt', folder + '/renamed.txt');
    assert.deepEqual(await viewer.readFile(device.dev, folder + '/renamed.txt'), content);
    assert.ok(!(await viewer.listFiles(device.dev)).some(entry => entry.path === folder + '/original.txt'));
    await viewer.renamePath(device.dev, root + '/nested', root + '/moved');
    assert.deepEqual(await viewer.readFile(device.dev, root + '/moved/deeper/renamed.txt'), content);
    assert.ok(!(await viewer.listFiles(device.dev)).some(entry => entry.path === root + '/nested' || entry.path.startsWith(root + '/nested/')));
  });
}

function physicalTool(device, name, args = {}) {
  return viewer.MCP_TOOLS.find(tool => tool.name === name).handler({ board_id: device.dev, ...args });
}

async function testPhysicalErrorRecovery(device) {
  const failed = await physicalTool(device, 'pico_python_run', { code: "raise ValueError('PICO_BAY_EXPECTED_ERROR')" });
  assert.equal(failed.isError, true);
  assert.match(failed.structuredContent.err, /ValueError: PICO_BAY_EXPECTED_ERROR/);
  const recovered = await physicalTool(device, 'pico_python_run', { code: "print('PICO_BAY_RECOVERED')" });
  assert.equal(recovered.structuredContent.ok, true);
  assert.equal(recovered.structuredContent.err.trim(), '');
  assert.equal(viewer.cleanReplOutput(recovered.structuredContent.out).trim(), 'PICO_BAY_RECOVERED');
}

async function within(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function testPhysicalInterrupt(device) {
  const port = viewer.getPort(device.dev);
  let ready, output = '', settled = false;
  const started = new Promise(resolve => { ready = resolve; });
  const monitor = (type, text) => {
    if (type !== 'out') return;
    output += text;
    if (output.includes('PICO_BAY_INTERRUPT_READY')) ready();
  };
  port.monitors.add(monitor);
  // A bounded loop also terminates if the application fails to deliver Ctrl-C.
  const run = physicalTool(device, 'pico_python_run', { code:
    "import time\nprint('PICO_BAY_INTERRUPT_READY')\nfor _pico_test_i in range(100):\n    time.sleep(0.1)\nprint('PICO_BAY_INTERRUPT_MISSED')",
  });
  const completion = run.then(result => { settled = true; return { result }; }, error => { settled = true; return { error }; });
  try {
    await within(Promise.race([started, completion.then(() => {
      throw new Error('Program finished before interruption could be tested');
    })]), 8000, 'Program did not announce readiness');
    const interrupted = await physicalTool(device, 'pico_board_interrupt');
    assert.equal(interrupted.structuredContent.ok, true);
    const ended = await within(completion, 3000, 'Interrupt reported success but the program kept running');
    if (ended.error) throw ended.error;
    assert.equal(ended.result.isError, true);
    assert.match(ended.result.structuredContent.err, /KeyboardInterrupt/);
    assert.doesNotMatch(ended.result.structuredContent.out, /PICO_BAY_INTERRUPT_MISSED/);
    const recovered = await physicalTool(device, 'pico_python_run', { code: "print('PICO_BAY_AFTER_INTERRUPT')" });
    assert.equal(recovered.structuredContent.ok, true);
    assert.equal(recovered.structuredContent.err.trim(), '');
    assert.equal(viewer.cleanReplOutput(recovered.structuredContent.out).trim(), 'PICO_BAY_AFTER_INTERRUPT');
  } finally {
    try {
      if (!settled) {
        // Test cleanup only: recover even when the application's interrupt route is broken.
        await port.write('\r\x03\x03').catch(() => {});
        await within(completion, 15000, 'Test program did not stop during cleanup');
      }
    } finally { port.monitors.delete(monitor); }
  }
}
