const https = require('https');

// ── 모델 설정 ──
// CLAUDE_MODEL 환경변수로 바꿀 수 있음 (기본: claude-sonnet-5-5)
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
// 답변 길이 한도 (CLAUDE_MAX_TOKENS 환경변수로 바꿀 수 있음). 1500이면 간편팩까지 추천하는 긴 답변이 중간에 끊겼음
const MAX_TOKENS = parseInt(process.env.CLAUDE_MAX_TOKENS, 10) || 3000;
const CUT_NOTE = '(답변이 길어 여기까지 보여 드렸어요. "이어서"라고 보내 주시면 나머지를 알려 드릴게요.)';

// 한도에 걸려 끊긴 답변은 마지막 완전한 줄까지만 보여 주고 이어서 안내를 붙임
function finishText(text, cut) {
  text = (text || '').trim();
  if (!cut) return text;
  const nl = text.lastIndexOf('\n');
  if (nl > text.length * 0.5) text = text.slice(0, nl).trim();
  return text + '\n\n' + CUT_NOTE;
}

function postJSON(hostname, path, headers, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname, port: 443, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers }
    }, pr => {
      // 한글 깨짐 방지: 조각(Buffer)을 모두 모은 뒤 한 번에 UTF-8로 변환
      const chunks = [];
      pr.on('data', c => chunks.push(c));
      pr.on('end', () => resolve({ status: pr.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      pr.on('error', reject);
    });
    r.on('error', reject);
    r.setTimeout(55000, () => r.destroy(new Error('응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.')));
    r.write(body); r.end();
  });
}

// 프론트에서 오는 메시지를 Claude 형식으로 정리 (이미지·텍스트 블록 지원)
function toClaudeMessages(messages) {
  const out = [];
  (messages || []).forEach(m => {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    let content;
    if (typeof m.content === 'string') {
      content = m.content;
    } else {
      content = (m.content || []).map(c => {
        if (c.type === 'image' && c.source && c.source.data) {
          return { type: 'image', source: { type: 'base64', media_type: c.source.media_type, data: c.source.data } };
        }
        return { type: 'text', text: c.text || '' };
      }).filter(c => c.type === 'image' || c.text.trim() !== '');
      if (content.length === 0) content = '(내용 없음)';
    }
    // 같은 역할이 연속되면 합치기 (Claude는 user/assistant 교대 필요)
    const last = out[out.length - 1];
    if (last && last.role === role) {
      const a = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
      const b = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
      last.content = a.concat(b);
    } else {
      out.push({ role, content });
    }
  });
  // 첫 메시지는 반드시 user
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

async function callClaude(apiKey, system, messages) {
  const payload = { model: CLAUDE_MODEL, max_tokens: MAX_TOKENS, messages: toClaudeMessages(messages) };
  if (system) payload.system = system;
  const resp = await postJSON('api.anthropic.com', '/v1/messages', {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  }, payload);
  const data = JSON.parse(resp.body);
  if (data.type === 'error' || data.error) {
    const msg = (data.error && data.error.message) || '알 수 없는 오류';
    if (/credit balance/i.test(msg)) {
      return { status: 402, error: '이번 달 AI 사용량이 모두 소진되었습니다. 다음 달에 다시 이용해 주세요.' };
    }
    if (resp.status === 529 || resp.status === 429) {
      return { status: resp.status, error: '지금 요청이 많습니다. 잠시 후 다시 시도해 주세요.' };
    }
    return { status: resp.status || 500, error: msg };
  }
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return { status: 200, text: finishText(text, data.stop_reason === 'max_tokens') };
}

// (예비) Claude 키가 없을 때만 기존 GPT-4o 사용
async function callOpenAI(apiKey, system, messages) {
  const oMsgs = [];
  if (system) oMsgs.push({ role: 'system', content: system });
  (messages || []).forEach(m => {
    if (typeof m.content === 'string') {
      oMsgs.push({ role: m.role, content: m.content });
    } else {
      const parts = (m.content || []).map(c => {
        if (c.type === 'image') return { type: 'image_url', image_url: { url: `data:${c.source.media_type};base64,${c.source.data}` } };
        return { type: 'text', text: c.text || '' };
      });
      oMsgs.push({ role: m.role, content: parts });
    }
  });
  const resp = await postJSON('api.openai.com', '/v1/chat/completions', {
    'Authorization': `Bearer ${apiKey}`
  }, { model: 'gpt-4o', max_tokens: MAX_TOKENS, messages: oMsgs });
  const data = JSON.parse(resp.body);
  if (data.error) return { status: resp.status, error: typeof data.error === 'object' ? data.error.message : data.error };
  const ch = data.choices?.[0];
  return { status: 200, text: finishText(ch?.message?.content || '', ch?.finish_reason === 'length') };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!claudeKey && !openaiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY가 설정되지 않았습니다.' });
  }

  try {
    const { messages, system } = req.body || {};
    const result = claudeKey
      ? await callClaude(claudeKey, system, messages)
      : await callOpenAI(openaiKey, system, messages);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(200).json({ content: [{ type: 'text', text: result.text }], provider: claudeKey ? 'claude' : 'openai' });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
