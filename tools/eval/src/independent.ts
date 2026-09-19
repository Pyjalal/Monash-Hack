import type { Category, Email, Expectation } from "@cargolens/shared";

interface IndependentCase {
  email: Email;
  expectedCategory: Category;
  expectedExpectation?: Expectation;
  expectedUrgency?: "routine" | "week" | "today" | "blocking";
}

function example(id: number, subject: string, body: string, expectedCategory: Category,
  expectedExpectation?: Expectation, expectedUrgency?: IndependentCase["expectedUrgency"]): IndependentCase {
  return { email: { id: `independent-${id}`, subject, body, from: "ops@example.test", contentScope: "full_message", attachments: [] },
    expectedCategory, expectedExpectation, expectedUrgency };
}

export const INDEPENDENT_CASES: IndependentCase[] = [
  example(1, "Draft request", "Please prepare and send the draft bill of lading so we can check it against our instructions.", "BL_COMPARISON", "FUTURE_DRAFT", "routine"),
  example(2, "Check documents", "Please verify the supplied draft BL against the shipping instructions and flag any differences.", "BL_COMPARISON", "VERIFY_NOW", "routine"),
  example(3, "Invoice query", "The subject is from an old message. My current request is to amend the consignee on the draft bill of lading to match the SI.", "BL_COMPARISON", "VERIFY_NOW"),
  example(4, "RE: Invoice", "Please send us the new draft BL.\n\nOn Monday, Accounts wrote:\nPlease pay the overdue invoice.", "BL_COMPARISON", "FUTURE_DRAFT"),
  example(5, "Missing BL", "Your message says the draft bill of lading is attached, but no attachment arrived. Please resend the missing attachment.", "BL_COMPARISON", "REPORTS_MISSING"),
  example(6, "Release blocked", "Cargo release is currently blocked because we have not received your draft BL. Please send the draft now.", "BL_COMPARISON", "FUTURE_DRAFT", "blocking"),
  example(7, "Review by today's cutoff", "Please check and correct the container quantity on this draft BL before today's 16:00 cutoff. Loading has not been blocked.", "BL_COMPARISON", "VERIFY_NOW", "today"),
  example(8, "Customer checking", "Our customer will compare the documents themselves. Please provide the draft bill of lading for them to check.", "BL_COMPARISON", "FUTURE_DRAFT"),
  example(9, "Shipping instructions needed", "Please provide your shipping instructions for this shipment.", "SI_REQUEST", undefined, "routine"),
  example(10, "Updated SI", "We have revised our shipping instructions. Please use these updated instructions for the shipment.", "SI_REQUEST"),
  example(11, "RE: Draft bill", "At this point we only need the shipper's shipping instructions. Please obtain the SI first; we are not requesting a draft BL yet.", "SI_REQUEST"),
  example(12, "Instructions today", "Please send the shipping instructions today. There is no current shipment blockage.", "SI_REQUEST", undefined, "today"),
  example(13, "Instructions correction", "Please update the notify party in the shipping instructions. No bill of lading has been issued for review.", "SI_REQUEST"),
  example(14, "Instructions this week", "Please supply the shipping instructions later this week. Today is not a deadline and the shipment is not blocked.", "SI_REQUEST", undefined, "week"),
  example(15, "Freight invoice", "Please send us the invoice for the freight charges.", "INVOICE_QUERY"),
  example(16, "Duplicate payment", "We appear to have paid this invoice twice. Please investigate and refund the duplicate payment.", "INVOICE_QUERY"),
  example(17, "RE: Bill of lading", "The shipping paperwork is already approved. This message is only asking why the invoice contains an extra handling charge.", "INVOICE_QUERY"),
  example(18, "Invoice amount", "The amount on our invoice differs from the agreed rate. Please clarify the billing calculation.", "INVOICE_QUERY"),
  example(19, "Payment receipt", "Could you confirm whether our invoice payment has been received?", "INVOICE_QUERY"),
  example(20, "Correct billing address", "Please reissue the invoice with our updated billing address.", "INVOICE_QUERY"),
  example(21, "Sailing schedule", "Please confirm the vessel's estimated departure and arrival dates.", "GENERAL"),
  example(22, "Thanks", "Thank you for the update. We have received it and have no further requests.", "GENERAL", undefined, "routine"),
  example(23, "Warehouse opening hours", "What time does the warehouse open on Saturday?", "GENERAL"),
  example(24, "Delivery appointment", "Please confirm our truck's delivery appointment at the warehouse.", "GENERAL"),
  example(25, "RE: SI", "The instructions are settled. Please tell me your office opening hours.\n\nOn Tuesday, Ops wrote:\nPlease provide shipping instructions.", "GENERAL"),
  example(26, "URGENT!!!", "For our reference, could you share the office telephone number? This is routine and there is no deadline or shipment impact.", "GENERAL", undefined, "routine"),
  example(27, "Guaranteed crypto returns", "Unsolicited offer: transfer cryptocurrency to our investment scheme for guaranteed daily returns. This has no relation to any shipment.", "SPAM"),
  example(28, "Bulk advertising", "We purchased this mailing list to promote our unrelated casino bonus. Click here to claim free spins.", "SPAM"),
  example(29, "Lottery prize", "You have won a lottery you never entered. Send us a processing fee to collect your prize.", "SPAM"),
  example(30, "Search ranking promotion", "This is an unsolicited mass advertisement selling search ranking services. We have no shipping business with you.", "SPAM"),
  example(31, "Unrelated sale", "Bulk promotion: buy miracle slimming supplements now. You did not subscribe to these advertisements.", "SPAM"),
  example(32, "Draft BL", "The subject is bait. This is an unsolicited advertisement for an unrelated online casino, with no shipment or document request.", "SPAM"),
];
