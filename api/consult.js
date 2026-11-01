const https = require('https');

// ── 전문 상담사 연결 신청 저장 · 상담사 관리 화면(/admin) 서버 ──
// 신청은 Supabase(서울) 전용 저장소에 쌓이고, 상담사는 /admin 에서 비밀번호로 들어가 봅니다.
// 저장소 안의 자료는 비밀번호로 로그인해야만 볼 수 있습니다(아래 주소·공개키만으로는 못 봄).
// 개인정보·건강정보는 로그에 남기지 않습니다.
const SUPABASE_URL = process.env.CONSULT_SUPABASE_URL || 'https://mbvaxchigywwgfjicyue.supabase.co';
const SUPABASE_KEY = process.env.CONSULT_SUPABASE_KEY || 'sb_publishable_y4OrWdPTOQOs3c3R4ieUTw_iklEqNkV';

const LIMIT = { name: 20, callTime: 30, message: 200, age: 3, gender: 4, interest: 30, pregnancy: 10, field: 50, chatText: 400 };
const STATUS = ['접수', '연락중', '상담완료', '취소'];

function clean(v, max) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// 상담사에게 남길 말: 줄바꿈은 살리고 나머지 제어문자만 정리
function cleanMulti(v, max) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

function makeId() {
  const k = new Date(Date.now() + 9 * 3600 * 1000); // 한국 시간
  const p = n => String(n).padStart(2, '0');
  const chars = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let rand = '';
  for (let i = 0; i < 4; i++) rand += chars[Math.floor(Math.random() * chars.length)];
  return `MK${String(k.getUTCFullYear()).slice(2)}${p(k.getUTCMonth() + 1)}${p(k.getUTCDate())}-${p(k.getUTCHours())}${p(k.getUTCMinutes())}-${rand}`;
}

// Supabase 함수 호출 → { status, data, error }
function rpc(fn, args) {
  const u = new URL(`${SUPABASE_URL}/rest/v1/rpc/${fn}`);
  const body = JSON.stringify(args || {});
  const lib = u.protocol === 'http:' ? require('http') : https;
  return new Promise((resolve, reject) => {
    const r = lib.request({
      hostname: u.hostname, port: u.port || undefined, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    }, pr => {
      const chunks = [];
      pr.on('data', c => chunks.push(c));
      pr.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let j = null;
        try { j = JSON.parse(text); } catch (e) { /* 빈 응답 */ }
        if (pr.statusCode >= 200 && pr.statusCode < 300) resolve({ status: pr.statusCode, data: j });
        else resolve({ status: pr.statusCode, error: (j && j.message) || 'error' });
      });
      pr.on('error', reject);
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('timeout')));
    r.write(body); r.end();
  });
}

function fmtPhone(d) {
  d = String(d || '');
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
}

async function submit(b, res) {
  // 자동 입력 로봇이 채우는 숨은 칸이 채워져 있으면 접수한 척만 함
  if (clean(b.hp, 100)) return res.status(200).json({ ok: true, id: makeId() });

  const phone = clean(b.phone, 20).replace(/\D/g, '').slice(0, 11);
  const name = clean(b.name, LIMIT.name);
  const agree = b.agree || {};
  if (!name) return res.status(400).json({ ok: false, error: '이름을 입력해 주세요.' });
  if (!/^01[016789]\d{7,8}$/.test(phone)) return res.status(400).json({ ok: false, error: '휴대폰 번호를 확인해 주세요.' });
  if (agree.privacy !== true || agree.sensitive !== true) return res.status(400).json({ ok: false, error: '개인정보·민감정보 수집 동의가 필요합니다.' });

  const withChat = agree.chat === true;
  const data = {
    id: makeId(),
    name,
    phone,
    callTime: clean(b.callTime, LIMIT.callTime),
    age: clean(b.age, LIMIT.age).replace(/\D/g, ''),
    gender: clean(b.gender, LIMIT.gender),
    interests: (Array.isArray(b.interests) ? b.interests : []).slice(0, 15).map(t => clean(t, LIMIT.interest)).filter(Boolean),
    pregnancy: clean(b.pregnancy, LIMIT.pregnancy),
    // 음주·흡연: true(함) / false(안 함) / null(답 안 함)
    drink: typeof b.drink === 'boolean' ? b.drink : null,
    smoke: typeof b.smoke === 'boolean' ? b.smoke : null,
    supplements: clean(b.supplements, LIMIT.field),
    diseases: clean(b.diseases, LIMIT.field),
    medications: clean(b.medications, LIMIT.field),
    allergies: clean(b.allergies, LIMIT.field),
    lifestyle: clean(b.lifestyle, LIMIT.field),
    message: cleanMulti(b.message, LIMIT.message),
    chat: (withChat && Array.isArray(b.chat) ? b.chat : []).slice(-8).map(m => ({
      role: m && m.role === 'user' ? 'user' : 'ai',
      text: clean(m && m.text, LIMIT.chatText)
    })).filter(m => m.text),
    agree: { privacy: true, sensitive: true, chat: withChat },
    lang: clean(b.lang, 5) || 'ko'
  };

  const r = await rpc('consult_submit', { p: data });
  if (r.error) {
    console.error('[consult] 저장 실패', data.id, r.status, r.error === 'too many' ? 'too many' : '');
    if (r.error === 'too many') return res.status(429).json({ ok: false, error: 'too_many' });
    return res.status(502).json({ ok: false, error: 'save_failed' });
  }
  return res.status(200).json({ ok: true, id: data.id });
}

async function admin(action, b, res) {
  const token = clean(b.token, 100);
  let r;
  if (action === 'login') {
    r = await rpc('consult_login', { p_password: String(b.password || '').slice(0, 100) });
    if (r.error === 'locked') return res.status(429).json({ ok: false, error: '비밀번호를 여러 번 틀려 10분 동안 잠겼어요.' });
    if (r.error) return res.status(502).json({ ok: false, error: '저장소에 연결하지 못했어요.' });
    if (!r.data) return res.status(401).json({ ok: false, error: '비밀번호가 맞지 않아요.' });
    return res.status(200).json({ ok: true, token: r.data });
  }
  if (action === 'list') {
    r = await rpc('consult_list', { p_token: token });
    if (!r.error) {
      const rows = (Array.isArray(r.data) ? r.data : []).map(x => Object.assign({}, x, { phone: fmtPhone(x.phone) }));
      return res.status(200).json({ ok: true, rows });
    }
  } else if (action === 'update') {
    const status = STATUS.includes(b.status) ? b.status : '접수';
    r = await rpc('consult_update', { p_token: token, p_id: clean(b.id, 40), p_status: status, p_manager: clean(b.manager, 20), p_memo: String(b.memo || '').slice(0, 500) });
    if (!r.error) return res.status(200).json({ ok: r.data === true });
  } else if (action === 'delete') {
    r = await rpc('consult_delete', { p_token: token, p_id: clean(b.id, 40) });
    if (!r.error) return res.status(200).json({ ok: r.data === true });
  } else if (action === 'password') {
    if (String(b.newPassword || '').length < 8) return res.status(400).json({ ok: false, error: '새 비밀번호는 8자 이상으로 정해 주세요.' });
    r = await rpc('consult_password', { p_token: token, p_old: String(b.oldPassword || '').slice(0, 100), p_new: String(b.newPassword).slice(0, 100) });
    if (!r.error) return r.data === true ? res.status(200).json({ ok: true }) : res.status(400).json({ ok: false, error: '지금 비밀번호가 맞지 않아요.' });
  } else {
    return res.status(400).json({ ok: false, error: 'unknown action' });
  }
  if (r.error === 'unauthorized') return res.status(401).json({ ok: false, error: 'login_required' });
  return res.status(502).json({ ok: false, error: '저장소에 연결하지 못했어요.' });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // 하루 한 번(vercel.json crons) 저장소를 깨워 무료 저장소가 잠들지 않게 함
  if (req.method === 'GET') {
    try {
      const r = await rpc('consult_ping', {});
      return res.status(r.error ? 502 : 200).json({ ok: !r.error });
    } catch (e) {
      return res.status(502).json({ ok: false });
    }
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  // 다른 사이트에서 이 주소로 보내지 못하게 막음
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return res.status(403).json({ ok: false, error: 'forbidden' });
    } catch (e) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
  }

  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  const action = b.action || 'submit';
  try {
    if (action === 'submit') return await submit(b, res);
    return await admin(action, b, res);
  } catch (err) {
    console.error('[consult] 오류', action, err.message);
    return res.status(502).json({ ok: false, error: '저장소에 연결하지 못했어요.' });
  }
}
