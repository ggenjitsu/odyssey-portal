// The pipeline vocabulary every client board shares, and the rules built on it.
// Change a definition here and every view, count and permission follows.

export const STATUSES = ['Idea', 'Scripting', 'Filming', 'Ready to Edit', 'Editing', 'Revisions', 'Review', 'Ready', 'Posted', 'Archive'];

// With an editor right now.
export const WORK = ['Ready to Edit', 'Editing', 'Revisions'];

// An editor "finished" a video when it moves from WORK into one of these.
export const EDITOR_DONE = ['Review', 'Ready', 'Posted'];

// Delivered means posted. Ready is finished but still waiting to go out.
export const DELIVERED_TO = ['Posted'];
// A video is only delivered once (Posted -> Archive is not a new delivery).
export const AFTER_DELIVERY = ['Posted', 'Archive'];

// The edit is done, so a due date can no longer be missed.
export const FINISHED = ['Ready', 'Posted', 'Archive'];

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

const CLIENT_DECIDES = ['needs_client', 'changes_requested'];

// Review is the team's own check (Ahmed or Genji). The client never sees a video at this stage.
export const needsReview = (c) => c.status === 'Review';

// Waiting on the client: passed the team's review and the client still has to say yes.
// A reworked video that comes back to Ready counts too, even if nobody reset its Approval.
export const needsApproval = (c) => c.status === 'Ready' && CLIENT_DECIDES.includes(c.approval);
// The client asked for changes and the team is working on them.
export const changesRequested = (c) => c.approval === 'changes_requested' && [...WORK, 'Review'].includes(c.status);
export const readyToPost = (c) => c.status === 'Ready' && !CLIENT_DECIDES.includes(c.approval);
export const wasPosted = (c) => c.status === 'Posted' || (c.status === 'Archive' && Boolean(c.posted_date || c.posted_link));

// The only cards a client login can ever see or act on.
export const clientVisible = (c) => needsApproval(c) || changesRequested(c) || readyToPost(c) || wasPosted(c);
