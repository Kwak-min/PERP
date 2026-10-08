import type { AgentProtectedResult } from "../../services/agent";

export function AgentProtectedResults({ results }: Readonly<{ results: readonly AgentProtectedResult[] }>) {
  return <div className="agent-protected-results">{results.map(item => <section key={item.tool_call_id}
    className="agent-protected-result" aria-label={`보호된 조회: ${item.tool}`} data-protected-result={item.tool_call_id}>
    <h3>보호된 조회 결과</h3>
    <small>{item.tool} · {item.classification}</small>
    <p>원본은 모델에 전달하지 않았습니다. 현재 권한으로 조회한 자료를 이 화면에서 직접 확인하세요.</p>
    {item.truncated && <p>조회 한도로 일부 결과만 표시됩니다.</p>}
    <details><summary>조회 결과와 근거</summary>
      <h4>조회 원본</h4><pre aria-label="조회 원본">{JSON.stringify(item.result, null, 2)}</pre>
      <h4>조회 근거</h4><pre aria-label="조회 근거">{JSON.stringify(item.evidence, null, 2)}</pre>
    </details>
  </section>)}</div>;
}
