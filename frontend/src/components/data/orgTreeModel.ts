export const ORG_PERMISSION_OPTIONS = [
  { key: "view", label: "조직 조회" },
  { key: "assign", label: "업무 배정" },
  { key: "approve", label: "승인 가능" },
  { key: "finance", label: "회계 관리" },
] as const;

export type OrgPermission = (typeof ORG_PERMISSION_OPTIONS)[number]["key"];

export interface OrgNode {
  id?: string;
  name: string;
  title: string;
  department?: string;
  count?: number;
  permissions?: readonly OrgPermission[];
  children?: readonly OrgNode[];
}

export interface EditableOrgNode {
  id: string;
  name: string;
  title: string;
  department: string;
  count?: number;
  permissions: OrgPermission[];
  children: EditableOrgNode[];
}

function defaultPermissions(depth: number): OrgPermission[] {
  if (depth === 0) return ORG_PERMISSION_OPTIONS.map(({ key }) => key);
  if (depth === 1) return ["view", "assign", "approve"];
  return ["view"];
}

function normalizeNode(
  node: OrgNode,
  path: readonly number[],
  parentDepartment: string,
): EditableOrgNode {
  const department =
    node.department?.trim() || (path.length === 1 ? "전체 조직" : parentDepartment);

  return {
    id: node.id ?? `org-${path.join("-")}`,
    name: node.name,
    title: node.title,
    department,
    ...(node.count === undefined ? {} : { count: node.count }),
    permissions: node.permissions ? [...node.permissions] : defaultPermissions(path.length - 1),
    children: (node.children ?? []).map((child, index) =>
      normalizeNode(child, [...path, index], department),
    ),
  };
}

export function normalizeOrgTree(root: OrgNode): EditableOrgNode {
  return normalizeNode(root, [0], "전체 조직");
}

export function addOrgChild(
  node: EditableOrgNode,
  parentId: string,
  child: EditableOrgNode,
): EditableOrgNode {
  if (node.id === parentId) {
    return { ...node, children: [...node.children, child] };
  }

  return {
    ...node,
    children: node.children.map((candidate) => addOrgChild(candidate, parentId, child)),
  };
}
