// Diagnostic disabled.
Deno.serve(() => new Response('gone', { status: 410 }))
