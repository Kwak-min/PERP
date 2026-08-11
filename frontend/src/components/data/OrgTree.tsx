export type OrgNode = Readonly<{
  name: string;
  title: string;
  count?: number;
  children?: readonly OrgNode[];
}>;

function Node({ node, depth }: Readonly<{ node: OrgNode; depth: number }>) {
  return (
    <li className="orgtree__item">
      <div className={depth === 0 ? "orgtree__node orgtree__node--root" : "orgtree__node"}>
        <span className="orgtree__avatar" aria-hidden="true">{node.name.slice(0, 1)}</span>
        <span className="orgtree__body">
          <b>{node.name}</b>
          <span>{node.title}</span>
        </span>
        {node.count !== undefined && <span className="orgtree__count">{node.count}명</span>}
      </div>
      {node.children && node.children.length > 0 && (
        <ul className="orgtree__children">
          {node.children.map((child) => (
            <Node key={child.name} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function OrgTree({ root }: Readonly<{ root: OrgNode }>) {
  return (
    <div className="orgtree">
      <ul className="orgtree__root">
        <Node node={root} depth={0} />
      </ul>
    </div>
  );
}
