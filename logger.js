/**
 * Date-wise file logger.
 * Writes to: logs/YYYY-MM-DD/{success|failed|other}.log
 * Also mirrors to console.
 */
const fs = require('fs-extra');
const path = require('path');

const logsRoot = path.join(__dirname, 'logs');
fs.ensureDirSync(logsRoot);

function todayFolder() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const dir = path.join(logsRoot, `${yyyy}-${mm}-${dd}`);
  fs.ensureDirSync(dir);
  return dir;
}

function stamp() {
  return new Date().toISOString();
}

function formatArgs(args) {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch (_) {
        return String(a);
      }
    })
    .join(' ');
}

function write(type, consoleFn, args) {
  const line = `[${stamp()}] [${type.toUpperCase()}] ${formatArgs(args)}\n`;
  try {
    fs.appendFileSync(path.join(todayFolder(), `${type}.log`), line);
  } catch (e) {
    console.error('Logger write failed:', e.message);
  }
  consoleFn(...args);
}

module.exports = {
  success(...args) {
    write('success', console.log, args);
  },
  failed(...args) {
    write('failed', console.error, args);
  },
  other(...args) {
    write('other', console.log, args);
  },
  warn(...args) {
    write('other', console.warn, args);
  },
};
