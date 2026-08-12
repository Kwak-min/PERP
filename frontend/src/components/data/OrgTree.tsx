import { useMemo, useState, type FormEvent } from "react";

import {
  ORG_PERMISSION_OPTIONS,
  addOrgChild,
  normalizeOrgTree,
  type EditableOrgNode,
  type OrgNode,
  type OrgPermission,
} from "./orgTreeModel";

export type { OrgNode } from "./orgTreeModel";

interface NodeProps {
  node: EditableOrgNode;
  depth: number;
  onAdd: (parentId: string, child: EditableOrgNode) => void;
}

function initials(name: string): string {
  return name === "미배정" ? "?" : name.slice(0, 1);
}

function AddNodeForm({
  parent,
  onAdd,
  onCancel,
}: {
  parent: EditableOrgNode;
  onAdd: NodeProps["onAdd"];
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [department, setDepartment] = useState(parent.department);
  const [permissions, setPermissions] = useState<OrgPermission[]>(["view"]);
  const canSubmit = name.trim() !== "" && title.trim() !== "" && department.trim() !== "";

  function togglePermission(permission: OrgPermission): void {
    setPermissions((current) =>
      current.includes(permission)
        ? current.filter((item) => item !== permission)
        : [...current, permission],
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canSubmit) return;

    onAdd(parent.id, {
      id: `org-${crypto.randomUUID()}`,
      name: name.trim(),
      title: title.trim(),
      department: department.trim(),
      permissions,
      children: [],
    });
    onCancel();
  }

  return (
    <form className="orgtree-editor" onSubmit={handleSubmit}>
      <div className="orgtree-editor__heading">
        <div>
          <b>새 하위 직급</b>
          <span>{parent.name} 아래에 연결됩니다.</span>
        </div>
        <button type="button" className="orgtree-editor__close" onClick={onCancel}>
          취소
        </button>
      </div>
      <div className="orgtree-editor__fields">
        <label>
          <span>담당자 이름</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="예: 장하늘"
            autoFocus
          />
        </label>
        <label>
          <span>직급 또는 역할</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="예: 운영팀장"
          />
        </label>
        <label>
          <span>소속 부서</span>
          <input
            value={department}
            onChange={(event) => setDepartment(event.target.value)}
            placeholder="예: 운영팀"
          />
        </label>
      </div>
      <fieldset className="orgtree-editor__permissions">
        <legend>부여할 권한</legend>
        {ORG_PERMISSION_OPTIONS.map(({ key, label }) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={permissions.includes(key)}
              onChange={() => togglePermission(key)}
            />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      <p className="orgtree-editor__note">
        조직도 위치는 관리 범위를, 선택한 권한은 실행 가능한 업무를 결정합니다.
      </p>
      <button type="submit" className="orgtree-editor__submit" disabled={!canSubmit}>
        조직도에 추가
      </button>
    </form>
  );
}

function Node({ node, depth, onAdd }: NodeProps) {
  const [adding, setAdding] = useState(false);
  const permissionLabels = ORG_PERMISSION_OPTIONS.filter(({ key }) =>
    node.permissions.includes(key),
  );
  const accessibleName = `${node.name} ${node.title} ${node.department}`;

  return (
    <li className="orgtree__item" role="treeitem" aria-label={accessibleName}>
      {depth > 0 && (
        <span className="orgtree__connector orgtree__connector--branch" aria-hidden="true" />
      )}
      <article className={`orgtree__node${depth === 0 ? " orgtree__node--root" : ""}`}>
        <span className="orgtree__avatar" aria-hidden="true">
          {initials(node.name)}
        </span>
        <div className="orgtree__body">
          <div className="orgtree__identity">
            <b>{node.name}</b>
            <span>{node.title}</span>
          </div>
          <span className="orgtree__department">{node.department}</span>
          <div className="orgtree__permissions" aria-label="보유 권한">
            {permissionLabels.map(({ key, label }) => (
              <span key={key} className={`orgtree__permission orgtree__permission--${key}`}>
                {label}
              </span>
            ))}
          </div>
        </div>
        {node.count !== undefined && <span className="orgtree__count">{node.count}명</span>}
      </article>

      <div className="orgtree__node-actions">
        <button
          type="button"
          className="orgtree__add"
          aria-expanded={adding}
          aria-label={`${node.name} 아래 하위 직급 추가`}
          onClick={() => setAdding((current) => !current)}
        >
          <span aria-hidden="true">+</span>
          하위 직급 추가
        </button>
      </div>

      {adding && (
        <div className="orgtree__draft">
          <span className="orgtree__connector" aria-hidden="true" />
          <AddNodeForm parent={node} onAdd={onAdd} onCancel={() => setAdding(false)} />
        </div>
      )}

      {node.children.length > 0 && (
        <ul className="orgtree__children" role="group">
          {node.children.map((child) => (
            <Node key={child.id} node={child} depth={depth + 1} onAdd={onAdd} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function OrgTree({ root }: { root: OrgNode }) {
  const initialRoot = useMemo(() => normalizeOrgTree(root), [root]);
  const [tree, setTree] = useState(initialRoot);

  function handleAdd(parentId: string, child: EditableOrgNode): void {
    setTree((current) => addOrgChild(current, parentId, child));
  }

  return (
    <div className="orgtree">
      <div className="orgtree__legend" aria-label="조직도 사용 안내">
        <span>선은 보고·관리 관계를 나타냅니다.</span>
        <span>권한 배지는 해당 직급이 실행할 수 있는 작업입니다.</span>
      </div>
      <ul className="orgtree__root" role="tree" aria-label="조직 권한 구조">
        <Node node={tree} depth={0} onAdd={handleAdd} />
      </ul>
    </div>
  );
}
