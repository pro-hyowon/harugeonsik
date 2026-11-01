const https = require('https');
const http = require('http');

// ── 전문 상담사 연결 신청 받기 ──
// 챗봇에서 받은 상담 신청을 CONSULT_WEBHOOK_URL(구글 시트 Apps Script 등)로 넘겨줍니다.
// 환경변수
//   CONSULT_WEBHOOK_URL     (필수) 신청을 받을 주소. 예: 구글 Apps Script 웹 앱 주소
//   CONSULT_WEBHOOK_SECRET  (권장) 받는 쪽과 똑같이 맞춰 둔 비밀값. 다른 사람이 가짜 신청을 넣지 못하게 함
//   CONSULT_WEBHOOK_FORMAT  (선택) json(기본, 모든 항목) | text(슬랙·구글챗처럼 글만 받는 곳)
// 개인정보·건강정보는 로그에 남기지 않습니다.

const LIMIT = { name: 20, phone: 11, callTime: 20, age: 3, gender: 4, interest: 30, pregnancy: 10, field: 50, chatText: 400 };

function clean(v, max) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function makeId() {
  const k = new Date(Date.now() + 9 * 3600 * 1000); // 한국 시간
  const p = n => String(n).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, '0');
  return `MK${String(k.getUTCFullYear()).slice(2)}${p(k.getUTCMonth() + 1)}${p(k.getUTCDate())}-${p(k.getUTCHours())}${p(k.getUTCMinutes())}-${rand}`;
}

function kstString() {
  const k = new Date(Date.now() + 9 * 3600 * 1000);
  return k.toISOString().replace('T', ' ').slice(0, 19);
}

function request(urlStr, method, payload, redirects) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'http:' ? http : https;
    const body = payload ? JSON.stringify(payload) : null;
    const headers = body ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) } : {};
    const r = lib.request({ hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method, headers }, pr => {
      const chunks = [];
      pr.on('data', c => chunks.push(c));
      pr.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        // 구글 Apps Script는 결과를 다른 주소로 넘겨 주므로(302) 한 번 따라가서 결과를 확인
        if (pr.statusCode >= 300 && pr.statusCode < 400 && pr.headers.location && (redirects || 0) < 3) {
          const next = new URL(pr.headers.location, urlStr).toString();
          return request(next, 'GET', null, (redirects || 0) + 1).then(resolve, reject);
        }
        resolve({ status: pr.statusCode, body: text });
      });
      pr.on('error', reject);
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('timeout')));
    if (body) r.write(body);
    r.end();
  });
}

function toText(d) {
  const yn = b => (b ? '예' : '아니오');
  const lines = [
    `[MEDICOK 상담 신청] ${d.id}`,
    `접수: ${d.receivedAt}`,
    `이름: ${d.name} / 연락처: ${d.phoneDisplay} / 통화 가능: ${d.callTime || '-'}`,
    `나이·성별: ${[d.age ? d.age + '세' : '', d.gender].filter(Boolean).join(' ') || '-'}`,
    `관심사: ${d.interests.length ? d.interests.join(', ') : '-'}`,
    `임신·수유: ${d.pregnancy || '-'} / 음주: ${yn(d.drink)} / 흡연: ${yn(d.smoke)}`,
    `섭취 중 건강기능식품: ${d.supplements || '-'}`,
    `보유 질환: ${d.diseases || '-'}`,
    `복용 의약품: ${d.medications || '-'}`,
    `알레르기·특이체질: ${d.allergies || '-'}`,
    `생활습관: ${d.lifestyle || '-'}`
  ];
  if (d.chat.length) {
    lines.push('— 최근 AI 상담 대화 —');
    d.chat.forEach(m => lines.push(`${m.role === 'user' ? '고객' : 'AI'}: ${m.text}`));
  }
  return lines.join('\n');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  // 다른 사이트에서 이 주소로 신청을 보내지 못하게 막음
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return res.status(403).json({ ok: false, error: 'forbidden' });
    } catch (e) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
  }

  const b = (req.body && typeof req.body === 'object') ? req.body : {};

  // 자동 입력 로봇이 채우는 숨은 칸이 채워져 있으면 접수한 척만 함
  if (clean(b.hp, 100)) return res.status(200).json({ ok: true, id: makeId() });

  const phone = clean(b.phone, 20).replace(/\D/g, '').slice(0, LIMIT.phone);
  const name = clean(b.name, LIMIT.name);
  const agree = b.agree || {};
  if (!name) return res.status(400).json({ ok: false, error: '이름을 입력해 주세요.' });
  if (!/^01[016789]\d{7,8}$/.test(phone)) return res.status(400).json({ ok: false, error: '휴대폰 번호를 확인해 주세요.' });
  if (agree.privacy !== true || agree.sensitive !== true) return res.status(400).json({ ok: false, error: '개인정보·민감정보 수집 동의가 필요합니다.' });

  const phoneDisplay = phone.length === 10
    ? `${phone.slice(0, 3)}-${phone.slice(3, 6)}-${phone.slice(6)}`
    : `${phone.slice(0, 3)}-${phone.slice(3, 7)}-${phone.slice(7)}`;

  const chat = (agree.chat === true && Array.isArray(b.chat) ? b.chat : []).slice(-8).map(m => ({
    role: m && m.role === 'user' ? 'user' : 'ai',
    text: clean(m && m.text, LIMIT.chatText)
  })).filter(m => m.text);

  const data = {
    id: makeId(),
    receivedAt: kstString(),
    name,
    phone: phoneDisplay,
    phoneDisplay,
    callTime: clean(b.callTime, LIMIT.callTime),
    age: clean(b.age, LIMIT.age).replace(/\D/g, ''),
    gender: clean(b.gender, LIMIT.gender),
    interests: (Array.isArray(b.interests) ? b.interests : []).slice(0, 15).map(t => clean(t, LIMIT.interest)).filter(Boolean),
    pregnancy: clean(b.pregnancy, LIMIT.pregnancy),
    drink: b.drink === true,
    smoke: b.smoke === true,
    supplements: clean(b.supplements, LIMIT.field),
    diseases: clean(b.diseases, LIMIT.field),
    medications: clean(b.medications, LIMIT.field),
    allergies: clean(b.allergies, LIMIT.field),
    lifestyle: clean(b.lifestyle, LIMIT.field),
    chat,
    agree: { privacy: true, sensitive: true, chat: agree.chat === true },
    lang: clean(b.lang, 5)
  };

  const url = process.env.CONSULT_WEBHOOK_URL;
  if (!url) {
    console.error('[consult] CONSULT_WEBHOOK_URL 없음 - 접수 실패', data.id);
    return res.status(503).json({ ok: false, error: 'not_configured' });
  }

  const text = toText(data);
  const out = (process.env.CONSULT_WEBHOOK_FORMAT || 'json').toLowerCase() === 'text'
    ? { text }
    : { secret: process.env.CONSULT_WEBHOOK_SECRET || '', ...data, phoneDisplay: undefined, text };

  try {
    const r = await request(url, 'POST', out, 0);
    let okFlag = r.status >= 200 && r.status < 300;
    // 받는 쪽이 {"ok":false}로 답하면 실패로 봄 (비밀값 불일치 등)
    try { const j = JSON.parse(r.body); if (j && j.ok === false) okFlag = false; } catch (e) { /* 글로 답하는 곳(슬랙 등)은 상태 코드로만 판단 */ }
    if (!okFlag) {
      console.error('[consult] 전달 실패', data.id, r.status);
      return res.status(502).json({ ok: false, error: 'deliver_failed' });
    }
    return res.status(200).json({ ok: true, id: data.id });
  } catch (err) {
    console.error('[consult] 전달 오류', data.id, err.message);
    return res.status(502).json({ ok: false, error: 'deliver_failed' });
  }
}
