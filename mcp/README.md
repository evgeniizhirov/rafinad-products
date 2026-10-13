# Rafinad Roadmap MCP

Standalone Cloudflare Worker. Defaults to authenticated read-only access for one OAuth subject.

Setup, security boundaries, tools, testing and owner-controlled deployment:
[docs/CHATGPT_MCP.md](../docs/CHATGPT_MCP.md).

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
pnpm build
```

Backend integration tests also need the repository root dependencies installed.
`build` is a deployment **dry run**. There is deliberately no automatic deploy script.
