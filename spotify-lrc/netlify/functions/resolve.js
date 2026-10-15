// POST /.netlify/functions/resolve   { url, clientId?, clientSecret? }
const lib = require('../../lib');

exports.handler = async (event) => {
  try {
    const { url, clientId, clientSecret } = JSON.parse(event.body || '{}');
    const result = await lib.resolveSpotify(url, clientId, clientSecret);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, ...result }),
    };
  } catch (e) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: e.message || 'Resolve failed' }),
    };
  }
};
