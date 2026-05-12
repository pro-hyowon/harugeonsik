const https = require('https');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API 키가 설정되지 않았습니다.' });

  try {
    const body = JSON.stringify(req.body);
    const response = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com', port: 443,
        path: '/v1/messages', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
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

    // Anthropic 오류 응답 처리
    if (data.error) {
      const msg = typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error));
      return res.status(response.status).json({ error: msg });
    }

    res.status(200).json(data);

  } catch (err) {
    res.status(502).json({ error: err.message || '알 수 없는 오류가 발생했습니다.' });
  }
}
