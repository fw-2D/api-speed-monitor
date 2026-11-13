export default function handler(request) {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const encoder = new TextEncoder();
  const timers = [];
  let closed = false;
  const clearTimers = () => timers.forEach(timer => clearTimeout(timer));
  const body = new ReadableStream({
    start(controller) {
      const send = type => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type, version: '2.0', at: Date.now() })}\n\n`));
      send('site.ready');
      timers.push(setTimeout(() => { if (!closed) send('site.streaming'); }, 250));
      timers.push(setTimeout(() => {
        if (closed) return;
        send('site.completed');
        closed = true;
        clearTimers();
        controller.close();
      }, 650));
      request.signal.addEventListener('abort', () => {
        if (closed) return;
        closed = true;
        clearTimers();
        controller.close();
      }, { once: true });
    },
    cancel() { closed = true; clearTimers(); }
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
