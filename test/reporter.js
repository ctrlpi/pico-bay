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

function formatReporterLine(line, color) {
  line = line
    .replace(/(\()([0-9]+(?:\.[0-9]+)?)ms\)/g,
      (_match, opening, value) => opening + formatMilliseconds(value) + 'ms)')
    .replace(/(duration_ms\s+)([0-9]+(?:\.[0-9]+)?)/g,
      (_match, _label, value) => 'duration ' + formatMilliseconds(value) + ' ms');
  const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
  const paint = (text, code) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  if (plain === '*** Optional physical boards tests') return paint(plain, '1;34');
  const noBoards = ' # no serial boards connected';
  if (plain.includes(noBoards)) {
    const indent = plain.match(/^\s*/)[0];
    return plain.slice(0, plain.indexOf(noBoards)) + '\n' +
      paint(indent + '*** no serial boards connected', '38;5;208');
  }
  const summary = plain.match(/^ℹ (tests|suites|pass|fail|cancelled|skipped|todo|duration)\s+(\d+)/);
  if (summary) {
    const [, label, count] = summary;
    const code = label === 'skipped' && Number(count) > 0 ? '38;5;208'
      : ['fail', 'cancelled'].includes(label) && Number(count) > 0 ? '31' : '32';
    return paint(plain, code);
  }
  if (/^\s*✔ .* on \/dev\//.test(plain)) return paint(plain, '38;5;28');
  return line;
}

if (require.main !== module) {
  async function* roundedSpecReporter(source) {
    const reporter = spec();
    const color = process.env.FORCE_COLOR !== undefined
      ? process.env.FORCE_COLOR !== '0'
      : !('NO_COLOR' in process.env) && !!process.stdout.isTTY;
    async function* withPhysicalHeading() {
      for await (const event of source) {
        if (event.type === 'test:dequeue' && event.data.nesting === 0 &&
            event.data.name === 'optional physical boards') {
          yield { type: 'test:stdout', data: { message: '*** Optional physical boards tests\n' } };
        }
        yield event;
      }
    }
    Readable.from(withPhysicalHeading()).pipe(reporter);
    let pending = '';
    for await (const chunk of reporter) {
      pending += String(chunk);
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        yield formatReporterLine(pending.slice(0, newline), color) + '\n';
        pending = pending.slice(newline + 1);
      }
    }
    if (pending) yield formatReporterLine(pending, color);
  }
  roundedSpecReporter.formatMilliseconds = formatMilliseconds;
  module.exports = roundedSpecReporter;
}
