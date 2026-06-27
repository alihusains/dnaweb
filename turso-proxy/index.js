// Cloudflare Worker: Turso CORS Proxy
// Proxies requests to Turso HTTP API with proper CORS headers

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // Only allow POST requests
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      // Extract the target URL from the request path
      const url = new URL(request.url);
      // Path format: /proxy/<encoded-turso-url>/v2/pipeline
      const pathParts = url.pathname.split('/');

      // Get the Turso URL from query param or body
      const tursoUrl = url.searchParams.get('url');
      if (!tursoUrl) {
        return new Response(JSON.stringify({ error: 'Missing ?url= parameter' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Forward the request to Turso
      const tursoResponse = await fetch(tursoUrl, {
        method: 'POST',
        headers: {
          'Content-Type': request.headers.get('Content-Type') || 'application/json',
          'Authorization': request.headers.get('Authorization') || ''
        },
        body: await request.text()
      });

      // Create response with CORS headers
      const response = new Response(tursoResponse.body, {
        status: tursoResponse.status,
        headers: {
          'Content-Type': tursoResponse.headers.get('Content-Type') || 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      });

      return response;
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  }
};
