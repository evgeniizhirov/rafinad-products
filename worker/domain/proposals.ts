// Proposals (vNext ТЗ §1.2): status model. Pure — no I/O.
//
//   new → review → accepted / postponed / rejected
//   accepted → planned   automatically when a linked task gets a sprint; by hand when no development is needed
//   planned → implemented   only by an explicit decision (never just because a release date passed)
//   postponed / rejected → review   (owner decision 13.10: can be returned for review)
// A reason is required for «postponed» and «rejected».

export const PROPOSAL_STATUSES = ['new', 'review', 'accepted', 'postponed', 'rejected', 'planned', 'implemented'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const PROPOSAL_STATUS_LABEL: Record<ProposalStatus, string> = {
  new: 'Новое',
  review: 'На рассмотрении',
  accepted: 'Принято в работу',
  postponed: 'Отложено',
  rejected: 'Отклонено',
  planned: 'Запланировано',
  implemented: 'Реализовано',
};

export const TRANSITIONS: Record<ProposalStatus, ProposalStatus[]> = {
  new: ['review', 'accepted', 'postponed', 'rejected'],
  review: ['accepted', 'postponed', 'rejected'],
  accepted: ['planned', 'review', 'postponed', 'rejected'],
  postponed: ['review'],
  rejected: ['review'],
  planned: ['implemented', 'accepted'],
  implemented: ['planned'],
};

export const REASON_REQUIRED: ProposalStatus[] = ['postponed', 'rejected'];

export function canTransition(from: string, to: string): boolean {
  return (TRANSITIONS[from as ProposalStatus] ?? []).includes(to as ProposalStatus);
}

/** statuses where the proposal is still being decided — its author may edit the text */
export const EDITABLE_BY_AUTHOR: ProposalStatus[] = ['new', 'review'];

export const proposalKey = (number: number) => `P-${number}`;
