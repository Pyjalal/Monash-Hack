export const CATEGORIES = [
  'BL_COMPARISON',
  'SI_REQUEST',
  'INVOICE_QUERY',
  'GENERAL',
  'SPAM',
];

// The descriptions matter: Jev chooses between these meanings rather than
// generating free-form text. Keep boundary cases explicit, particularly the
// distinction between requesting a draft BL and supplying an SI.
export const CATEGORY_CRITERIA = {
  BL_COMPARISON: {
    definition:
      'Shipping-document work whose main intent is to obtain, check, confirm, amend, or compare a draft Bill of Lading (BL), often against a Shipping Instruction (SI).',
    include: [
      'confirm documents or draft BL details',
      'check a draft BL against an SI',
      'request or chase a draft BL, even when no attachment is present yet',
      'coded shipment subjects whose body asks for BL checking or confirmation',
    ],
    exclude:
      'Do not choose this for general outstanding-BL summaries, release-status reports, or an email primarily supplying/requesting the SI itself.',
  },
  SI_REQUEST: {
    definition:
      'The main intent is to request, provide, or communicate Shipping Instruction (SI) details so shipping documents or a draft BL can be prepared.',
    include: [
      'REQUEST SI, CUST SI, SI NEEDED, or a subject beginning with SI',
      'an SI written in the email body with shipper, consignee, ports, cargo, and document requirements',
    ],
    exclude:
      'Do not choose this when the main task is checking or amending an already-issued draft BL against the SI.',
  },
  INVOICE_QUERY: {
    definition:
      'A billing, invoice, payment, freight-charge, local-charge, missing-GR, cancellation, detention, or demurrage query.',
    include: [
      'missing goods receipt (GR)',
      'cancel or reverse an invoice',
      'THC, local charges, total freight, D&D, detention, demurrage, or payment confirmation',
    ],
    exclude: 'Do not choose this merely because an invoice reference appears in a shipment subject.',
  },
  GENERAL: {
    definition:
      'Legitimate operational, administrative, reporting, reminder, HR, holiday, status, or automated mail that does not request one of the specific workflows above.',
    include: [
      'update summaries, berthing reports, delivery planning, RPA completion notices',
      'outstanding-BL lists, pending BL release status, SI/AED bulk reminders, HR or holiday notices',
    ],
    exclude:
      'Do not choose this when the message asks to compare a particular BL, supplies a particular SI, or raises a billing query.',
  },
  SPAM: {
    definition:
      'Unsolicited, deceptive, phishing, scam, credential-stealing, implausible prize, fake parcel-fee, suspicious investment, or irrelevant promotional mail.',
    include: [
      'prize and gift-card claims',
      'mailbox verification or account suspension links',
      'fake parcel fees, bank-detail requests, guaranteed returns, or extreme promotions',
    ],
    exclude: 'Do not choose this for legitimate company or shipping operations mail.',
  },
};

export function isCategory(value) {
  return CATEGORIES.includes(value);
}
