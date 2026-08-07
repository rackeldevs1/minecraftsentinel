'use strict';

const LEVELS = { info: 'INFO ', warn: 'WARN ', error: 'ERROR', event: 'EVENT' };

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function createLogger(tag = 'watcher') {
  const write = (level, message) => {
    const line = `[${stamp()}] ${LEVELS[level] || level} [${tag}] ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
    event: (m) => write('event', m),
    child: (childTag) => createLogger(`${tag}:${childTag}`),
  };
}

module.exports = createLogger;
module.exports.createLogger = createLogger;
