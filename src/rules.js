// The pipeline vocabulary every client board shares, and the rules built on it.
// Change a definition here and every view, count and permission follows.

export const STATUSES = ['Idea', 'Scripting', 'Filming', 'Ready to Edit', 'Editing', 'Revisions', 'Review', 'Ready', 'Posted', 'Archive'];

// With an editor right now.
export const WORK = ['Ready to Edit', 'Editing', 'Revisions'];

// An editor "finished" a video when it moves from WORK into one of these.
export const EDITOR_DONE = ['Review', 'Ready', 'Posted'];

// A video counts toward the client's package the first time it reaches one of these...
export const DELIVERED_TO = ['Ready', 'Posted'];
// ...and never again once it has been in any of these (Posted -> Archive is not a new delivery).
export const AFTER_DELIVERY = ['Ready', 'Posted', 'Archive'];

export const IN_PRODUCTION = ['Scripting', 'Filming', 'Ready to Edit', 'Editing', 'Revisions', 'Review'];

// "Needs Elena Approval", "Needs Raymond Approval"... all mean the same thing.
export function canonApproval(raw) {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (s.startsWith('needs')) return 'needs_client';
  if (s.includes('change')) return 'changes_requested';
  if (s.includes('not needed')) return 'not_needed';
  if (s.startsWith('approved')) return 'approved';
  return null;
}

export const needsApproval = (c) => c.approval === 'needs_client' && ['Review', 'Ready'].includes(c.status);
export const changesRequested = (c) => c.approval === 'changes_requested' && !AFTER_DELIVERY.includes(c.status);
export const readyToPost = (c) => c.status === 'Ready' && !['needs_client', 'changes_requested'].includes(c.approval);
export const wasPosted = (c) => c.status === 'Posted' || (c.status === 'Archive' && Boolean(c.posted_date || c.posted_link));

// The only cards a client login can ever see or act on.
export const clientVisible = (c) => needsApproval(c) || changesRequested(c) || readyToPost(c) || wasPosted(c);
