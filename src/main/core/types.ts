export type InvoiceState = 'Issued' | 'Pending' | 'Paid' | 'Underpaid' | 'Overpaid' | 'Expired' | 'Flagged'

// once an invoice reaches one of these, reconcile stops touching it
export const FINAL_STATES: InvoiceState[] = ['Paid', 'Underpaid', 'Overpaid', 'Expired', 'Flagged']
