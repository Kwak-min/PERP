// 목업 orbitArt() 이식 — 로그인 브랜드 패널의 궤도 일러스트.
const RINGS: Array<[number, number, string[]]> = [
  [120, 46, ["일정", "업무"]],
  [190, 74, ["회계", "결재", "문서"]],
  [255, 100, ["인수인계", "자산", "인사", "AI Agent"]],
];

export function OrbitArt() {
  const els: React.ReactNode[] = [];
  RINGS.forEach(([rx, ry, labels], ri) => {
    els.push(
      <ellipse
        key={`e${ri}`}
        cx="280"
        cy="280"
        rx={rx}
        ry={ry}
        fill="none"
        stroke="#6366F1"
        strokeOpacity={0.55 - ri * 0.12}
        strokeWidth="1.2"
      />,
    );
    labels.forEach((l, i) => {
      const a = (i / labels.length) * Math.PI * 2 + ri * 0.9 + 0.4;
      const x = 280 + rx * Math.cos(a);
      const y = 280 + ry * Math.sin(a);
      const ai = l === "AI Agent";
      els.push(
        <circle
          key={`c${ri}-${i}`}
          cx={x.toFixed(1)}
          cy={y.toFixed(1)}
          r={ai ? 7 : 5}
          fill={ai ? "#A78BFA" : "#818CF8"}
          stroke="#1E1B4B"
          strokeWidth="2"
        />,
      );
      els.push(
        <text key={`t${ri}-${i}`} x={(x + 11).toFixed(1)} y={(y + 4).toFixed(1)}>
          {l}
        </text>,
      );
    });
  });
  return (
    <svg className="orbit" viewBox="0 0 560 560" aria-hidden="true">
      <g transform="rotate(-18 280 280)">{els}</g>
      <circle cx="280" cy="280" r="30" fill="#4F46E5" />
      <circle cx="280" cy="280" r="12" fill="#fff" />
    </svg>
  );
}
