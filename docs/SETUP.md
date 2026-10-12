# Choose a decision provider

Run the setup command from the project you want to investigate:

```bash
perfdigest-plugin init
# With the pre-release package already installed locally:
npx --no-install perfdigest-plugin init
```

The npm package has not been published to the registry. Install the local tarball using the README's package instructions before using `npx --no-install`; plain `npx perfdigest-plugin init` can otherwise try to download a registry package.

The small terminal menu offers **Cloudflare** (recommended for the demo), **local llama.cpp**, **OpenAI Decisions**, and **offline**. It prints the active provider explicitly. Setup makes no hosted requests by default. It does not call a model, download a model, install Python packages or change global Codex settings. A failed prerequisite leaves the selected provider visible and never switches to another provider.

For automation, supply both `--provider` and `--yes`:

```bash
perfdigest-plugin init --provider offline --yes
perfdigest-plugin init --provider local --endpoint http://127.0.0.1:8137/v1/systemone --yes
perfdigest-plugin init --provider cloudflare --env-file /absolute/private/perfdigest.env --yes
perfdigest-plugin init --provider openai --env-file /absolute/private/perfdigest.env --yes
```

Use `--workspace /path/to/project` to configure another existing directory. Noninteractive setup without an explicit provider fails. `--yes` also authorizes replacing that workspace's existing setup; interactive replacement asks first.

Configuration is saved to the ignored `.perfdigest/config.json` with private permissions (0600 on POSIX). It contains only these fields:

```json
{
  "version": 1,
  "provider": "cloudflare",
  "envFile": "/absolute/private/perfdigest.env"
}
```

The local provider also stores its full `endpoint`. Hosted providers use their fixed service endpoint and refuse `--endpoint`. The local endpoint must be exactly `http://127.0.0.1:PORT/v1/systemone`, with an explicit port and no user information, query or fragment. Init makes one unauthenticated `GET /health` at that loopback address. A successful health response does not establish model identity or successful inference.

## Optional Cloudflare connection check

Add `--check-connection` to opt in for this invocation, with either the terminal menu or automation:

```bash
perfdigest-plugin init --check-connection
perfdigest-plugin init --provider cloudflare --env-file /absolute/private/perfdigest.env --yes --check-connection
```

When Cloudflare is selected and its dedicated credentials and env file are valid, setup makes exactly one authenticated `GET /accounts/{account_id}/ai/models/search`, with `search=clef-flash`, `per_page=1` and `page=1`. Cloudflare documents **Workers AI Read** or **Workers AI Write** as accepted permissions for this [model-discovery endpoint](https://developers.cloudflare.com/api/resources/ai/subresources/models/methods/list/).

The request has a five-second deadline and a 64 KiB response limit. It follows no redirects, performs no retries or pagination, and does not display tokens, headers or upstream response bodies. Missing or invalid credentials/env files skip the request and fail prerequisite checks. A failed requested connection check also fails prerequisite checks, while preserving your provider selection.

Success confirms only that the authenticated model-discovery read was accepted. It does **not** establish Clef model availability, inference permission, successful inference, remaining quota or budget. Even an empty search result can establish read-endpoint acceptance. The flag is not saved in configuration. Local setup keeps its existing `/health` check; OpenAI and offline setup make no requests even with this flag.

## Keep credentials outside the project

Create the private env file with your editor outside the investigated repository, and set its permissions to 600. Setup asks only for its absolute path, never a token. Do not paste credential values into setup flags, configuration JSON, checked-in files or the parent Codex environment.

| Provider | Dedicated runner variables |
| --- | --- |
| `cloudflare` | `PERFDIGEST_CLOUDFLARE_ACCOUNT_ID` (32 hexadecimal characters), `PERFDIGEST_CLOUDFLARE_API_TOKEN` |
| `openai` | `PERFDIGEST_DECISIONS_API_KEY` |
| `local` | No API credential; the saved endpoint sets `PERFDIGEST_CLEF_URL` |
| `offline` | None |

The env file accepts only those four variable names, one `KEY=VALUE` assignment per line. Blank lines and whole-line `#` comments are allowed. Values may have a matching pair of single or double quotes; values are literal, single-line text without whitespace. General keys such as `OPENAI_API_KEY`, duplicate assignments, `export` and shell commands are refused. The file is parsed without executing a shell or expanding variables. The runner stages all assignments before applying any, and inherited dedicated values take precedence. The saved local endpoint takes precedence over `PERFDIGEST_CLEF_URL`.

The runner loads this file only in its own process. Its existing child-environment allowlist excludes these dedicated variables from Codex, profilers and Python MCP. The file still exists on disk under your user account; process environment filtering is not OS filesystem isolation.

`init` can save a configuration even if prerequisites are missing, then exits unsuccessfully and explains what needs attention. Missing or invalid env files, absent dedicated credentials, unavailable `uvx`, or an unhealthy local endpoint do not become a successful fallback. Missing Codex is reported separately because offline collection can run without `--agent codex`. Finding executables does not verify Python MCP installation or Codex login. Hosted authentication remains unverified unless the optional Cloudflare read check succeeds; inference and remaining quota are never validated by setup.

Legacy names `clef-cloudflare`, `clef-local`, `openai-luna` and `decisions` are accepted when loading or initializing configuration, and are saved as `cloudflare`, `local`, `openai` and `openai` respectively.
