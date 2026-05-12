const https = require('https');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API 키가 설정되지 않았습니다.' });

  try {
    const { messages, system, max_tokens } = req.body;

    const geminiContents = [];
    messages.forEach(m => {
      const role = m.role === 'assistant' ? 'model' : 'user';
      if (typeof m.content === 'string') {
        geminiContents.push({ role, parts: [{ text: m.content }] });
      } else {
        const parts = m.content.map(c => {
          if (c.type === 'text') return { text: c.text };
          if (c.type === 'image') return { inline_data: { mime_type: c.source.media_type, data: c.source.data } };
          return { text: c.text || '[파일 첨부됨]' };
        });
        geminiContents.push({ role, parts });
      }
    });

    const bodyObj = {
      contents: geminiContents,
      generationConfig: { maxOutputTokens: max_tokens || 1000 },
    };
    if (system) bodyObj.systemInstruction = { parts: [{ text: system }] };

    const body = JSON.stringify(bodyObj);
    // 최신 모델명으로 변경
    const path = '/v1beta/models/gemini-1.5-flash-latest:generateContent?key=' + apiKey;

    const response = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'generativelanguage.googleapis.com', port: 443,
        path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
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

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    res.status(200).json({ content: [{ type: 'text', text }] });

  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
