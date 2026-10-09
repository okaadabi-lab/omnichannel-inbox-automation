'use strict';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n').trim();
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

// Limits are counted in UTF-16 code units (JavaScript string length), which is what the
// downstream APIs validate. The cut never splits a surrogate pair.
function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  let end = maxLength - 1;
  if (isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return `${text.slice(0, end)}…`;
}

function utf8ByteLength(codePoint) {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

// Instagram limits message text to 1000 bytes of UTF-8, not characters.
function truncateUtf8(text, maxBytes) {
  const ellipsisBytes = 3;
  let total = 0;
  for (const char of text) total += utf8ByteLength(char.codePointAt(0));
  if (total <= maxBytes) return text;

  let kept = '';
  let used = 0;
  for (const char of text) {
    const size = utf8ByteLength(char.codePointAt(0));
    if (used + size > maxBytes - ellipsisBytes) break;
    kept += char;
    used += size;
  }
  return `${kept}…`;
}

// Meta sends seconds in some payloads and milliseconds in others; anything above 1e12 is
// treated as milliseconds (1e12 seconds is the year 33658).
function unixToIso(value) {
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0) return null;
  const millis = number > 1e12 ? number : number * 1000;
  return new Date(millis).toISOString();
}

function toMysqlDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${String(value)}`);
  }
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

function singleLine(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// Telegram messages are sent with parse_mode HTML, where only these three characters need
// escaping. Escape after truncating: Telegram counts the length of the parsed text.
function escapeTelegramHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = {
  asArray,
  cleanText,
  truncate,
  truncateUtf8,
  unixToIso,
  toMysqlDateTime,
  singleLine,
  escapeTelegramHtml,
};
