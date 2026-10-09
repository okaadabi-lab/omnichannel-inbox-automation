'use strict';

const { buildClaimRow } = require('./canonical');
const { buildInstagramPrivateReply, buildInstagramPublicReply } = require('./senders');
const { toMysqlDateTime } = require('./text');

// Order matters: a gambling-spam comment that also says "harga" must be treated as spam.
const RULES = [
  {
    category: 'spam',
    patterns: [
      /https?:\/\/|www\.|bit\.ly|\b[a-z0-9-]+\.(com|net|xyz|site|online|link)\b/,
      /\b(slot|gacor|maxwin|togel|judi|depo|deposit|jackpot)\b/,
      /\b(follow back|follback|f4f|cek bio|check my bio|dm for collab)\b/,
    ],
  },
  {
    category: 'insult',
    patterns: [
      /\b(anjing|anjg|bangsat|bajingan|brengsek|goblok|goblog|tolol|kampret|idiot|stupid)\b/,
    ],
  },
  {
    category: 'price_inquiry',
    patterns: [
      /\b(harga|hrg|brp|berapaan|biaya|tarif|pricelist|price ?list|price|how much)\b/,
      /\b(info|minta|cek) (harga|pl|pricelist)\b/,
    ],
  },
];

// Lowercase, fold Unicode look-alikes and collapse stretched letters ("hargaaa", "tololll").
function normalizeForMatching(text) {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(\p{L})\1{2,}/gu, '$1')
    .replace(/\s+/g, ' ');
}

function classifyComment(text) {
  const normalized = normalizeForMatching(text);
  for (const rule of RULES) {
    const pattern = rule.patterns.find((candidate) => candidate.test(normalized));
    if (pattern) return { category: rule.category, matched: pattern.source };
  }
  return { category: 'other', matched: null };
}

function hourWindowStart(date) {
  const start = new Date(date);
  start.setUTCMinutes(0, 0, 0);
  return toMysqlDateTime(start).slice(0, 19);
}

function renderReplies(comment, priceListUrl) {
  const handle = comment.username ? `@${comment.username}` : 'kak';
  return {
    public: `Halo ${handle}, info harga sudah kami kirim lewat DM ya. Silakan cek inbox.`,
    private: [
      `Halo ${comment.username ? `kak ${comment.username}` : 'kak'}, terima kasih sudah bertanya.`,
      `Daftar paket dan harga lengkap bisa dilihat di sini: ${priceListUrl}`,
      'Balas pesan ini kalau ada yang ingin ditanyakan, tim kami siap membantu.',
    ].join('\n'),
  };
}

// Everything the comment workflow needs for one comment: the rule outcome, the message_log
// claim row, the rate-limit bucket and (for price questions) both reply payloads.
function planComment(comment, { priceListUrl, hourlyCap, now = new Date() }) {
  if (!Number.isInteger(hourlyCap) || hourlyCap < 1) {
    throw new Error('hourlyCap must be a positive integer');
  }
  const { category, matched } = classifyComment(comment.text);
  const plan = {
    comment_id: comment.comment_id,
    category,
    matched,
    reasons: [category === 'other' ? 'no_rule_matched' : `rule_${category}`],
    claim: buildClaimRow({
      channel: 'instagram_comment',
      external_message_id: comment.comment_id,
      customer_id: comment.from_id,
      customer_name: comment.username,
      text: comment.text,
      received_at: comment.received_at,
    }),
    rate_limit: {
      scope_key: `instagram:${comment.account_id}`,
      window_start: hourWindowStart(now),
      cap: hourlyCap,
    },
    public_reply: null,
    private_reply: null,
  };

  if (category === 'price_inquiry') {
    const texts = renderReplies(comment, priceListUrl);
    plan.public_reply = {
      comment_id: comment.comment_id,
      body: buildInstagramPublicReply(texts.public),
    };
    plan.private_reply = {
      account_id: comment.account_id,
      body: buildInstagramPrivateReply(comment.comment_id, texts.private),
    };
  }
  return plan;
}

module.exports = { classifyComment, planComment };
