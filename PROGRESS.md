# PROGRESS — skye / sealed-check

State file. `HANDOFF.md` is the spec; this is what has actually been executed.
Append one entry per block. Never mark a block done that has not been run.

Format:

```
## Block N — <name> — DONE <time>
- Built: <files>
- Decisions: <choices made and why>
- Cut: <what was dropped for time, and whether the README says so>
- Surprises: <anything that contradicted the brief>
- Next block needs to know: <...>
```

---

## Block -1 — environment — DONE 2026-07-25 21:20

- Built: repo scaffold only — `.gitignore`, `PROGRESS.md`, `HANDOFF.md`.
- Toolchain installed on Debian 13 (trixie), arm64:
  - node v22.23.1 (NodeSource apt repo, not nvm — system-wide so non-interactive
    and background shells get it without sourcing a profile)
  - npm 10.9.8, pnpm 11.17.0, gh 2.46.0, git 2.52.0
- Decisions: Debian's own `nodejs` (20.19.2) was removed — pnpm >=10 requires Node
  22.13+ (`node:sqlite`). A stale pnpm@9 symlink in `/usr/local/bin` shadowed the new
  install and was deleted; if `pnpm --version` ever reports 9.x again, check
  `which -a pnpm`.
- Layout: the repo root is `/workspaces/debian-9/skye`, **not** the workspace root.
  `/workspaces/debian-9` is the devcontainer template's own folder — its
  `.devcontainer/` and `.github/dependabot.yml` configure the container, not this
  project, and are deliberately left outside the repo. All paths in `HANDOFF.md` are
  relative to `skye/`.
- Surprises: none.
- Next block needs to know: no `.env` exists yet. Block 0 must create it (and
  `.env.example`) for the 0G wallet key. `.gitignore` already excludes `.env`.

## Block 0 — de-risk 0G — BLOCKED ON FUNDING 2026-07-25 21:50

- Built: `package.json`, `tsconfig.json`, `.env.example`, `pnpm-workspace.yaml`,
  `scripts/env.ts`, `scripts/probe-0g.ts`, `scripts/verify-0g.ts`.
- **Executed:** `probe-0g.ts` against live 0G testnet. Network reachable, real data.
  `verify-0g.ts` typechecks and runs as far as ledger creation, then fails on funds.
- Facts confirmed by execution, not docs:
  - SDK `@0gfoundation/0g-compute-ts-sdk@0.9.0`. RPC `https://evmrpc-testnet.0g.ai`.
  - **Testnet chain id is 16602**, not 16601. (`constants.d.ts:TESTNET_CHAIN_ID`.)
  - Only ONE chatbot provider on testnet: `0xa48f01287233509FD694a22Bf840225062E67836`,
    model `qwen/qwen2.5-omni-7b`, `verifiability: TeeML`,
    url `https://compute-network-6.integratenetwork.work`.
    (Second service is image-editing — not usable for us.)
- **Surprise, and it is the blocker:** `broker.ledger.addLedger()` enforces
  `MIN_LEDGER_BALANCE_OG = 3` client-side. The docs show `depositFund(10)` and never
  state a minimum. Sub-account `transferFund` minimum is a further 1 0G
  (`MIN_TRANSFER_AMOUNT_OG = 1e18`). So the wallet needs ~3.05 0G before anything
  runs. Faucet gave 0.5. Wallet: `0x7aC9eB7980a64b01ff000f7D05FFb497BFB593CC`.
- Decisions: verification is done twice — the SDK's own `processResponse`, and an
  independent recover-and-compare against `checkProviderSignerStatus().teeSignerAddress`
  using `ethers.verifyMessage`. The second is load-bearing; it does not trust the SDK's
  verdict. RA report is fetched via `getSignerRaDownloadLink`, sha256'd, parse best-effort.
- Cut: nothing yet.
- Next block needs to know: **the gate has not been passed.** We are not in state (a),
  (b) or (c) — inference has never been attempted because funding never cleared. This
  is a prerequisite failure, not a 0G integration failure.

## Block 1 — simulation harness + facts — CODE COMPLETE, UNRUN 2026-07-25 21:50

- Built: `src/facts.ts`, `src/intent.ts`, `src/anvil.ts`, `src/simulate.ts`,
  `src/extract.ts`, `src/compile.ts`, `src/scenarios.ts`, `fixtures/Fixtures.sol`,
  `tests/schema-audit.test.ts`, `tests/injection.test.ts`.
- **Executed:** `solc` compiles all five fixture contracts. `schema-audit.test.ts`
  passes (3/3). `pnpm typecheck` clean. Nothing that needs anvil has been run.
- Decisions:
  - **Bare anvil, no fork, by default.** Both fixtures are contracts we deploy, so no
    mainnet RPC is needed and CREATE addresses are deterministic — which is what makes
    the injection test byte-comparable across two runs. `MAINNET_RPC_URL` is an
    optional upgrade for a real-token demo. README must say the fixtures are ours.
  - **solc via npm, not forge.** Keeps the only external binary requirement at anvil.
  - Schema audit test walks the zod tree and fails if any string leaf lacks a regex
    constraint. This is the structural half of the invariant; the injection test is
    the behavioural half.
  - Revert *strings* are treated as attacker-controlled and never cross into `Facts` —
    a honeypot can revert with "SAFE: audited". Only the enum crosses.
- Cut: the sell replay only fires when the intent's `to` is the venue that can sell the
  acquired token back (`token()` must match). Multi-hop and router-mediated buys return
  `not_applicable`. README must say so.
- **Executed after anvil landed (foundry 1.7.1):** injection test PASSES. All five
  scenarios produce correct, differing Facts (`pnpm facts`).
- **The injection test earned its keep — it found a real side channel.** First run
  failed: the two Facts differed in the native ETH delta by ~7 gwei. Cause: a longer
  attacker-controlled token `name` makes the token's own deployment cost more gas,
  shifting the block base fee, which changed the gas price at the moment the intent
  executed. The delta was being corrected with a separately-fetched `getGasPrice()`.
  Fixed by cancelling with `receipt.effectiveGasPrice`. Name length no longer leaks.
- Acceptance numbers: clean / honeypot / taxed all have **identical** balanceDeltas
  (−1 ETH, +45454 TKN). Only `sellOutcome` separates them: `ok` / `reverted` /
  `returned_less` with `transferTaxBps: 2999` measured from what actually arrived.
  Approvals: `isUnlimited true, spenderAgeBlocks 2` vs `false, 502`.

## Block 2 — judge + attestation binding — DONE 2026-07-25 21:58

- Built: `src/judge.ts`, `src/zg.ts`, `src/attest.ts`, `tests/tamper.test.ts`.
- **Executed:** full suite 17/17 passing. `pnpm typecheck` clean.
- **The tamper test also earned its keep.** It exposed that the enclave signs only the
  model's *response*, so the signature committed to the verdict but NOT to the facts —
  an attacker could display doctored facts beside a genuine signature and a green tick.
  Fix: `Facts` carries `factsDigest` (keccak over the canonical facts with the digest
  field omitted); the model echoes it; `verify()` recomputes it. Now editing a fact
  fails even if the attacker recomputes the digest, because the signed bytes commit to
  the original. Test covers that exact case.
- Decisions:
  - Binding chain: enclave signs response bytes → bytes contain verdict + intentHash +
    factsDigest → intentHash recomputed from the transaction. Break any link, `ok:false`.
  - `judge.ts` imports from `./facts.js` and nothing else. The invariant is enforced by
    the import graph, not by discipline.
  - Revert *strings* never cross into Facts — a honeypot can revert with "SAFE: audited".
  - One retry on malformed model JSON, then hard failure. No coaxing loop.
- **Risk carried forward:** the binding depends on a 7B model echoing two 64-char hex
  digests verbatim at temperature 0. Untested against the real model — funding blocked.
  If it proves unreliable, the fallback is to shorten the digests and say so in the README.

## Block 3 — CLI + UI — CLI DONE, UI NOT STARTED 2026-07-25 22:00

- Built: `src/pipeline.ts`, `src/cli.ts`. `pnpm check --preset honeypot|safe|taxed`.
- **Executed:** the CLI runs the entire pipeline — deploys fixtures, simulates,
  extracts facts, connects to 0G — and fails at exactly one call: `addLedger` sending
  3 0G with 0.5 available. Everything before the enclave is verified working.
- Next: the UI, and a live run the moment funding clears.

## Block 0 GATE — PASSED, state (a) — 2026-07-25 22:40

Wallet funded (5.5 0G). `pnpm verify:0g` prints a real response, a signature, and
**SIGNATURE OK**. Signature verified independently via `ethers.verifyMessage` against
`checkProviderSignerStatus().teeSignerAddress` = `0x83df4B8EbA7c0B3B740019b8c9a77ffF77D508cF`.
SDK `processResponse` agrees (`true`). Ledger tx `0xc8b79058…`, sub-account tx `0xcdb14a08…`.

- **Surprise that forced a redesign:** the TEE does NOT sign the response text. The signed
  text is five colon-separated fields:
  `<requestDigest>:<responseDigest>:centralized:aliyun:<...>`.
  Established by `scripts/probe-signature.ts` brute-forcing digests of every part of the
  exchange. `part[1] == sha256(JSON.stringify(responseBody))`.
  `attest.ts` was rewritten around this: the record now carries `responseJson`, and
  `verify()` recomputes sha256 over it and matches field 1, then reads the verdict out of
  that body. Three new tamper cases cover it.
- The request digest (field 0) covers the prompt, and therefore the facts — but we cannot
  reproduce the provider's serialisation, so the facts binding stays on the `factsDigest`
  echo. README says so.
- **Risk retired:** qwen2.5-omni-7b echoes both 64-char digests verbatim at temperature 0,
  across all three presets. The one-retry-then-fail path was never triggered.
- RA report: the testnet provider's `/attestation/report` returns a 221-byte error body,
  not a quote. Hash recorded, parsing skipped per the brief. README states this.

## Block 3 — UI — DONE 2026-07-25 22:52

- Built: `server.ts` (express + SSE), `ui/App.tsx`, `ui/styles.css`, `vite.config.ts`.
- **Executed:** `pnpm dev:api` + `pnpm dev:ui`; SSE verified end to end through the vite
  proxy for both `safe` and `honeypot`. All eight verification checks return true.
  `vite build` succeeds. UI shows real pipeline stages, not a spinner.
- Decision: the pipeline needs anvil and a wallet, so it cannot run in the browser — hence
  the small express backend. 0G connection is created once and shared, since ledger setup
  costs on-chain transactions.
- Decision: preset buy sizes differ (1 / 0.5 / 0.25 ETH) so each demo run has a distinct
  `intentHash`. Deterministic fixture deployment otherwise made all three identical, which
  would have undercut the "bound to this exact transaction" claim on camera.
- The UI deliberately displays the token's on-chain name and says it is never passed to the
  model — it makes the invariant visible rather than merely claimed.

## Block 4 — README — DONE 2026-07-25 22:55

- Built: `README.md`. Contains the honest-limitation paragraph verbatim, the injection
  example, what is real vs stubbed, the 0G gotchas, and the architecture diagram.
- **Outstanding: the Team table is empty.** Must be filled before submitting.
- **Outstanding: the demo video has not been recorded.**
