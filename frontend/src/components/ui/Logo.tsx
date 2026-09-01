export function Logo({ compact = false }: Readonly<{ compact?: boolean }>) {
  return (
    <span className="brand" aria-label="OrbitFlow">
      <span className="brand__mark" aria-hidden="true">
        O
      </span>
      {!compact && <span className="brand__name">OrbitFlow</span>}
    </span>
  );
}
