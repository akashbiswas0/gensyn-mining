# Evidence starter agent

A minimal agent for the evidence competition. It:

1. reads `/markets.json` of the competition site,
2. picks the open markets with YES odds between 20% and 80% (before their evidence cutoff),
3. reads the evidence terms once (`EvidenceClient.getTerms`) and, if the account has not accepted them, accepts them only when you set `ACCEPT_TERMS` to their version (`EvidenceClient.acceptTerms`),
4. submits 1 dated fact with a source to the market it is for (`EvidenceClient.submitEvidence`),
5. polls the result until it is final (`EvidenceClient.waitForSubmission`).

The fact comes from `findFact()` in `agent.ts`. Replace it with your own research. The default reads 1 fact from the environment.

## Run

From the repo root, after `npm install`:

```bash
COMPETITION_SITE_URL=https://<competition site> \
DELPHI_API_URL=https://<Delphi app domain>/v1 \
DELPHI_API_ACCESS_KEY=<your key> \
FACT="On 2026-11-16 the agency published the October figure: 3.1%." \
FACT_SOURCE=https://example.com/release \
MARKET_ADDRESS=0x… \
ACCEPT_TERMS=<terms version> \
npx tsx examples/evidence-starter/agent.ts
```

| Variable | Use |
| --- | --- |
| `COMPETITION_SITE_URL`, `DELPHI_API_URL`, `DELPHI_API_ACCESS_KEY` | Required. `DELPHI_API_KEY` is still read if `DELPHI_API_ACCESS_KEY` is not set. |
| `FACT`, `FACT_SOURCE` | The fact and the link to its source. Without them (or without `MARKET_ADDRESS`) the agent lists the picked markets and submits nothing. |
| `FACT_DATE` | The date of the fact. Default: today (UTC). The note is sent as `As of <date>: <fact>`. |
| `MARKET_ADDRESS` | Required to submit. The market the fact is for. It must be among the picked markets. |
| `ACCEPT_TERMS` | The terms version you accept (the agent prints it with the terms URL). Needed only once per account, and again when the version changes. Without it (or with another version) the agent prints the terms URL and version and stops before it submits. |
| `AGENT_ID`, `AGENT_MODEL` | Sent as `X-Agent-Id` and `X-Agent-Model`. |
