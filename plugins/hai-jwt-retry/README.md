# hai-jwt-retry

Retries the current OMP turn when HAI Proxy returns a supported transient error.

## Supported errors

- Expired JWT responses, including `401 Jwt is expired`
- OpenAI Responses API errors with code `invalid_encrypted_content`

The plugin retries at `0`, `3`, and `10` seconds. A successful turn resets the retry limit. After three consecutive failures, it stops and reports the recovery action instead of creating a retry loop.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Enables automatic retries. |
| `proxyHost` | `localhost` | Restricts retries to models using this HAI Proxy host. |
| `proxyPort` | `6655` | Restricts retries to models using this HAI Proxy port. |

The endpoint check prevents matching errors from other OpenAI-compatible providers. Repeated encrypted-content failures usually require a fresh session because encrypted reasoning is tied to the upstream account or deployment that produced it.

## Development

```bash
bun test
bun run typecheck
```
