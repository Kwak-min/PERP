// Callers supply a current company principal and a row selected in that company.
// Read-only policy: PG deciders form a company pool, not an assigned route.
export function canReadPgApproval(principal, row) {
  const eligibleRequester = String(row.requester_id) === String(principal.userId) && principal.has('approval.request');
  return eligibleRequester || (row.status !== 'draft' && principal.has('approval.decide'));
}
