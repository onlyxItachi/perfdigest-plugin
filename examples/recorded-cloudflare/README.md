# Recorded genuine Cloudflare demo

These bytes were captured and routed on 12 October 2026. `receipt.json` is a portable summary of the original one-request Cloudflare Clef-flash → same-thread Codex Astra/max run, not a fixture response or a new inference result. Absolute local paths have been omitted; the raw trace and bounded decision request are preserved.

From the source checkout or installed package directory:

```bash
node dist/cli.js run examples/recorded-cloudflare/manifest.json --workspace examples/recorded-cloudflare --provider offline --agent none
```

The explicit offline replay reads the original trace and reruns the independent arithmetic verifier. It makes no new model request and performs no fresh profile capture. See [the recorded validation](../../docs/VALIDATION.md) for the original hosted inference, timings and claim boundaries. Each recorded timing span is an eight-traversal batch after three warmups, not one traversal. The full pipeline overlap includes routing; capture/digest-only overlap was zero.
