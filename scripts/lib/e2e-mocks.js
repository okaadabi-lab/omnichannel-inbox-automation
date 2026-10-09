'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

// Small stand-ins for the external services, used only by scripts/e2e.js. Each mock records
// every request so the test can assert on what n8n actually sent.

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseBody(text, contentType = '') {
  if (!text) return {};
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function send(res, status, body, contentType = 'application/json') {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function startServer(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const body = parseBody(await readBody(req), req.headers['content-type']);
    const record = {
      method: req.method,
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body,
    };
    requests.push(record);
    try {
      await handler(record, res);
    } catch (error) {
      send(res, 500, { error: { message: error.message } });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ai-support-service POST /v1/messages. The decision depends on keywords in the text;
// "lambat" makes it answer after a few seconds, like a slow LLM call.
function startAiSupport({ apiKey, slowMs }) {
  return startServer(async (req, res) => {
    if (req.method !== 'POST' || req.path !== '/v1/messages') return send(res, 404, {});
    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      return send(res, 401, { error: { code: 'unauthorized', message: 'Invalid API key' } });
    }
    const text = String(req.body.text ?? '');
    if (text.includes('lambat')) await new Promise((resolve) => setTimeout(resolve, slowMs));
    if (text.includes('trigger-error')) {
      return send(res, 400, {
        error: { code: 'validation_failed', message: 'Request validation failed' },
      });
    }
    const base = { conversation_id: crypto.randomUUID(), citations: [] };
    if (text.includes('refund')) {
      return send(res, 201, {
        ...base,
        action: 'escalate',
        reply_text: 'Terima kasih, kak. Tim kami akan segera menghubungi kakak.',
        reasons: ['intent_refund_request'],
        intent: 'refund_request',
        confidence: 0.91,
      });
    }
    return send(res, 201, {
      ...base,
      action: 'reply',
      reply_text: 'Paket Anggrek mulai Rp 12.500.000 kak, untuk sampai 150 tamu.',
      reasons: ['answered_from_knowledge_base'],
      intent: 'pricing_question',
      confidence: 0.85,
      citations: [{ article_id: 'paket-dan-harga', title: 'Paket dekorasi dan harga' }],
    });
  });
}

// WhatsApp Cloud API (/fb/...) and Instagram API (/ig/...). WhatsApp sends to failingPhone
// return 500, like a provider outage for that request.
function startMetaGraph({ whatsappToken, instagramToken, failingPhone }) {
  let sequence = 0;
  return startServer((req, res) => {
    sequence += 1;
    if (req.path.startsWith('/fb/') && req.path.endsWith('/messages')) {
      if (req.headers.authorization !== `Bearer ${whatsappToken}`) return send(res, 401, {});
      if (req.body.to === failingPhone) {
        return send(res, 500, { error: { message: 'Service temporarily unavailable', code: 2 } });
      }
      return send(res, 200, {
        messaging_product: 'whatsapp',
        contacts: [{ input: req.body.to, wa_id: req.body.to }],
        messages: [{ id: `wamid.MOCK${String(sequence).padStart(6, '0')}` }],
      });
    }
    if (req.path.startsWith('/ig/')) {
      if (req.headers.authorization !== `Bearer ${instagramToken}`) return send(res, 401, {});
      if (req.path.endsWith('/replies')) return send(res, 200, { id: `1790000000000${sequence}` });
      if (req.path.endsWith('/messages')) {
        return send(res, 200, {
          recipient_id: '1100000000000001',
          message_id: `mid.MOCK${sequence}`,
        });
      }
    }
    return send(res, 404, { error: { message: 'unknown endpoint' } });
  });
}

// Telegram rejects text it cannot parse in the requested parse_mode. The workflows never send
// HTML tags, so any "<" or a bare "&" is an escaping bug; in legacy Markdown an unmatched "_",
// "*" or "`" opens an entity that never ends.
function telegramParseError(text, parseMode) {
  if (parseMode === 'HTML') {
    return /<|&(?!(lt|gt|amp|quot);)/.test(text);
  }
  if (parseMode === 'Markdown') {
    return ['_', '*', '`'].some((char) => text.split(char).length % 2 === 0);
  }
  return false;
}

// Telegram Bot API: only sendMessage is needed.
function startTelegram({ botToken }) {
  let messageId = 0;
  return startServer((req, res) => {
    if (req.path !== `/bot${botToken}/sendMessage`) {
      return send(res, 404, { ok: false, description: 'Not Found' });
    }
    if (telegramParseError(String(req.body.text ?? ''), req.body.parse_mode)) {
      return send(res, 400, {
        ok: false,
        error_code: 400,
        description: "Bad Request: can't parse entities",
      });
    }
    messageId += 1;
    return send(res, 200, {
      ok: true,
      result: {
        message_id: messageId,
        chat: { id: Number(req.body.chat_id) },
        text: req.body.text,
      },
    });
  });
}

// hr-payroll-api outbox, following its docs/integrations.md contract.
function startPayroll({ apiKey, events }) {
  const acked = new Set();
  const problem = (res, status, code) =>
    send(
      res,
      status,
      { type: 'about:blank', title: code, status, code },
      'application/problem+json',
    );

  return startServer((req, res) => {
    if (req.headers['x-api-key'] !== apiKey) return problem(res, 401, 'invalid_api_key');

    if (req.method === 'GET' && req.path === '/api/v1/integrations/outbox') {
      const after = Number(req.query.get('after') ?? 0);
      const limit = Number(req.query.get('limit') ?? 50);
      const pending = events.filter((event) => !acked.has(event.id));
      const data = pending.filter((event) => event.id > after).slice(0, limit);
      return send(res, 200, {
        data,
        meta: {
          next_after: data.length > 0 ? data[data.length - 1].id : after,
          pending_total: pending.length,
        },
      });
    }

    if (req.method === 'POST' && req.path === '/api/v1/integrations/outbox/ack') {
      const ids = req.body.ids;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) {
        return problem(res, 422, 'validation_failed');
      }
      const result = { acked: [], already_acked: [], unknown: [] };
      for (const id of ids) {
        if (!events.some((event) => event.id === id)) result.unknown.push(id);
        else if (acked.has(id)) result.already_acked.push(id);
        else {
          acked.add(id);
          result.acked.push(id);
        }
      }
      return send(res, 200, { data: result });
    }
    return problem(res, 404, 'not_found');
  }).then((server) => ({ ...server, acked }));
}

module.exports = { startAiSupport, startMetaGraph, startTelegram, startPayroll };
