// Disabled diagnostic stub (was a one-off probe to confirm FMP_API_KEY + earnings coverage).
Deno.serve(() => new Response(JSON.stringify({ ok: true, note: 'diag-fmp disabled' }), { headers: { 'Content-Type': 'application/json' } }))
