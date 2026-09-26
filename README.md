# Deploy Doctor 🩺

> **A self-healing deployment failsafe agent** — watches live deployments, diagnoses failures from real logs, and fixes them with human-in-the-loop approval for anything irreversible.

Built for the **TrueFoundry × Polaris "Agents That Act" hackathon** (Sep 2026).

## What It Does

Deploy Doctor is an MCP server that connects to TrueForge and gives an AI agent the ability to:

1. **DIAGNOSE** failures by reading real logs and status from real platforms
2. **CLASSIFY** the fix into tiers (auto-fix / approval-required / report-only)
3. **FIX** the issue — with automatic approval gates for anything that changes what's deployed
4. **VERIFY** the fix by hitting the live endpoint after applying it

### Supported Platforms

| Platform | Failure Shapes | Owner |
|----------|---------------|-------|
| **Render** | Crashed service, health check failures, port binding, env misconfig | Laptop 1 |
| **Hugging Face Spaces** | Sleeping spaces, quota exhaustion, stale deps, OOM | Laptop 2 |
| **Vercel** | Build errors, serverless timeouts, env misconfig, bad deploys | Laptop 3 |
| **GitHub Pages** | Jekyll build failures, Actions errors, wrong base path, 404s | Laptop 4 |

### Remediation Tiers

| Tier | What Happens | Examples |
|------|-------------|----------|
| **Tier 1** | Agent fixes automatically (reversible, low risk) | Restart, retry, rollback |
| **Tier 2** | Agent drafts fix → tests → **pauses for human approval** | Env var change, config fix, redeploy |
| **Tier 3** | Agent reports findings and **stops** (nothing safe to automate) | Revoked credentials, billing limits, outages |

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org) ≥ 22.14
- [TrueForge](https://trueforge.dev) — `npx @truefoundry/trueforge@latest`
- An OpenAI API key
- API key for at least one platform (Render, HF, Vercel, or GitHub)

### Setup

```bash
# 1. Clone
git clone https://github.com/sankeerthts54-glitch/DeployMentor.git
cd DeployMentor

# 2. Install dependencies
npm install

# 3. Build
npm run build

# 4. Configure environment
cp .env.example .env
# Edit .env — add your API keys (at minimum OPENAI_API_KEY + one platform key)

# 5. Start TrueForge
npx @truefoundry/trueforge@latest
```

### Connect Deploy Doctor to TrueForge

1. Open TrueForge at http://localhost:8790
2. Go to **Settings → Models** → Configure **OpenAI** with your API key
3. Go to **Settings → Connectors** → Click **Add MCP Server**
4. Set:
   - **Name:** `deploy-doctor`
   - **Transport:** `stdio`
   - **Command:** `node`
   - **Args:** `["dist/server.js"]`  
   - **Working Directory:** full path to your `DeployMentor` folder
   - **Environment Variables:** Copy the relevant keys from your `.env`
5. Go to **Build Agent** → Create an agent with:
   - **Model:** `openai/gpt-4o`
   - **MCP Servers:** Select `deploy-doctor`, enable all tools
   - **Tool Approval:** Set to `@write` and `@destructive`
   - **Instructions:** (see `trueforge-config.json` for the full system prompt)

### Test It

1. Break a deployment (e.g., set a wrong env var on your Render service)
2. Ask the agent: *"Check my Render service srv-XXXXX and fix any issues"*
3. Watch it diagnose → classify → propose a fix → **pause for your approval**
4. Click **Allow** → agent applies the fix → verifies health

## Architecture

```
TrueForge Harness (LLM + sandbox + approvals)
    │
    ├── MCP tool calls (stdio)
    │
    ▼
deploy-doctor MCP Server
    ├── Render Adapter      → api.render.com
    ├── HF Spaces Adapter   → huggingface.co/api
    ├── Vercel Adapter       → api.vercel.com
    └── GitHub Pages Adapter → api.github.com
```

## AI Tools Used

This project was built with assistance from:
- **Google Antigravity (AGY)** — architecture, scaffold, and code generation

## Team

Built by a team of 4 at the TrueFoundry × Polaris hackathon.

## License

MIT
