const https = require('https');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API 키가 설정되지 않았습니다.' });

  try {
    const { messages, system, max_tokens } = req.body;

    const openaiMessages = [];
    if (system) openaiMessages.push({ role: 'system', content: system });

    messages.forEach(m => {
      if (typeof m.content === 'string') {
        openaiMessages.push({ role: m.role, content: m.content });
      } else {
        const parts = m.content.map(c => {
          if (c.type === 'text') return { type: 'text', text: c.text };
          if (c.type === 'image') return { type: 'image_url', image_url: { url: 'data:' + c.source.media_type + ';base64,' + c.source.data } };
          return { type: 'text', text: c.text || '[파일 첨부됨]' };
        });
        openaiMessages.push({ role: m.role, content: parts });
      }
    });

    const body = JSON.stringify({ model: 'gpt-4o', max_tokens: max_tokens || 1000, messages: openaiMessages });

    const response = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.openai.com', port: 443,
        path: '/v1/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey, 'Content-Length': Buffer.byteLength(body) },
      };
      const r = https.request(options, (pr) => {
        let d = '';
        pr.on('data', c => d += c);
        pr.on('end', () => resolve({ status: pr.statusCode, body: d }));
      });
      r.on('error', reject);
      r.write(body);
      r.end();
    });

    const data = JSON.parse(response.body);
    if (data.error) return res.status(response.status).json({ error: data.error.message });
    res.status(200).json({ content: [{ type: 'text', text: data.choices?.[0]?.message?.content || '' }] });

  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
