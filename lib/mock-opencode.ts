export function mockFetch(request: Request): Promise<Response> {
  const { method, url } = request;
  const parsedUrl = new URL(url);
  const path = parsedUrl.pathname;

  if (method === 'GET' && path === '/v1/models') {
    return Promise.resolve(
      new Response(JSON.stringify({
        object: 'list',
        data: [
          { id: 'model-1', object: 'model', created: 1234567890, owned_by: 'opencode' },
          { id: 'model-2', object: 'model', created: 1234567890, owned_by: 'opencode' }
        ]
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    );
  }

  if (method === 'POST' && path === '/v1/chat/completions') {
    return Promise.resolve(
      new Response(JSON.stringify({
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1234567890,
        model: 'model-1',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Hello, how can I help you?'
            },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 9, completion_tokens: 12, total_tokens: 21 }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    );
  }

  return Promise.resolve(
    new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}