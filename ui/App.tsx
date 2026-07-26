import { useState } from 'react'

type Stage = 'fork_started' | 'simulated' | 'facts_extracted' | 'sealed_inference' | 'verdict_bound'

const STAGES: Array<{ id: Stage; label: string }> = [
  { id: 'fork_started', label: 'private fork started' },
  { id: 'simulated', label: 'transaction simulated' },
  { id: 'facts_extracted', label: 'facts extracted' },
  { id: 'sealed_inference', label: 'sealed inference on 0G' },
  { id: 'verdict_bound', label: 'verdict bound to intent' },
]

interface Result {
  facts: Record<string, any>
  verdict: { verdict: 'safe' | 'caution' | 'danger'; reasons: string[]; confidence: number }
  record: Record<string, any>
  verification: { ok: boolean; checks: Record<string, boolean | null>; errors: string[] }
}

interface IntentInfo {
  from: string
  to: string
  value: string
  data: string
  tokenName: string
  tokenAddress: string
}

const short = (s: string, head = 10, tail = 8) =>
  s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s

export function App() {
  const [stages, setStages] = useState<Stage[]>([])
  const [running, setRunning] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [intent, setIntent] = useState<IntentInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  function run(preset: string) {
    setStages([])
    setResult(null)
    setIntent(null)
    setError(null)
    setRunning(preset)

    const source = new EventSource(`/api/check?preset=${preset}`)
    source.addEventListener('stage', (e) => {
      const { stage } = JSON.parse((e as MessageEvent).data)
      setStages((prev) => [...prev, stage])
    })
    source.addEventListener('intent', (e) => setIntent(JSON.parse((e as MessageEvent).data)))
    source.addEventListener('result', (e) => {
      setResult(JSON.parse((e as MessageEvent).data))
      setRunning(null)
      source.close()
    })
    source.addEventListener('error', (e) => {
      const data = (e as MessageEvent).data
      setError(data ? JSON.parse(data).message : 'connection to the checker failed')
      setRunning(null)
      source.close()
    })
  }

  const verdict = result?.verdict.verdict

  return (
    <main>
      <header>
        <h1>sealed-check</h1>
        <p className="tagline">
          Simulate an unsigned transaction, adjudicate it inside a TEE, get a verdict bound to
          the intent hash. The operator never sees your trade.
        </p>
      </header>

      <section className="presets">
        <button onClick={() => run('safe')} disabled={!!running}>
          Load safe example
        </button>
        <button onClick={() => run('honeypot')} disabled={!!running} className="danger">
          Load honeypot example
        </button>
        <button onClick={() => run('taxed')} disabled={!!running} className="danger">
          Load 30%-tax example
        </button>
      </section>

      {intent && (
        <section className="card intent">
          <h2>Intent</h2>
          <dl>
            <dt>to</dt>
            <dd className="mono">{intent.to}</dd>
            <dt>value</dt>
            <dd className="mono">{intent.value} wei</dd>
            <dt>data</dt>
            <dd className="mono">{short(intent.data, 20, 8)}</dd>
          </dl>
          <p className="aside">
            The token calls itself <strong>“{intent.tokenName}”</strong>. We read that here, in
            the UI, to show you we have it — and it is never passed to the model.
          </p>
        </section>
      )}

      {(running || stages.length > 0) && (
        <section className="card stages">
          <h2>Pipeline</h2>
          <ol>
            {STAGES.map((s) => {
              const done = stages.includes(s.id)
              const active = !done && running && stages.length === STAGES.indexOf(s)
              return (
                <li key={s.id} className={done ? 'done' : active ? 'active' : ''}>
                  <span className="tick">{done ? '✓' : active ? '·' : ' '}</span>
                  {s.label}
                </li>
              )
            })}
          </ol>
        </section>
      )}

      {error && (
        <section className="card error">
          <h2>Failed</h2>
          <p className="mono">{error}</p>
        </section>
      )}

      {result && (
        <>
          <section className={`card verdict ${verdict}`}>
            <div className="badge-row">
              <span className={`badge ${verdict}`}>{verdict?.toUpperCase()}</span>
              <span className="confidence">confidence {result.verdict.confidence}</span>
            </div>
            <ul className="reasons">
              {result.verdict.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
            <p className="privacy">This intent was never sent to a third-party scanner.</p>
          </section>

          <section className="card attest">
            <h2>Attestation</h2>
            <dl>
              <dt>intentHash</dt>
              <dd className="mono">{result.record.intentHash}</dd>
              <dt>factsDigest</dt>
              <dd className="mono">{result.facts.factsDigest}</dd>
              <dt>TEE signer</dt>
              <dd className="mono">{result.record.teeSignerAddress}</dd>
              <dt>signature</dt>
              <dd className="mono">{short(result.record.teeSignature, 26, 10)}</dd>
              <dt>model</dt>
              <dd className="mono">{result.record.model}</dd>
              <dt>RA report sha256</dt>
              <dd className="mono">
                {result.record.attestationReportHash
                  ? short(result.record.attestationReportHash, 20, 10)
                  : 'unavailable'}
              </dd>
            </dl>
            <p className={result.verification.ok ? 'verified' : 'unverified'}>
              {result.verification.ok ? '✓ signature verified' : '✗ verification failed'}
            </p>
            {result.verification.errors.length > 0 && (
              <ul className="reasons">
                {result.verification.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
            <p className="aside">
              The enclave proves this model produced this verdict over these facts. It does not
              prove the verdict is correct. Do not treat a <code>safe</code> result as safety.
            </p>
          </section>

          <section className="card facts">
            <h2>Facts the model saw</h2>
            <p className="aside">
              Every field is a number, boolean, enum or address. There is no free-text field in
              the schema, so nothing the token says about itself can reach the model.
            </p>
            <pre>{JSON.stringify(result.facts, null, 2)}</pre>
          </section>
        </>
      )}
    </main>
  )
}
