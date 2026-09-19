#!/usr/bin/env python3
"""Generate realistic, high-difficulty SDOC synthetic data (data_v3).

Features:
- Total 220 emails specifically focused on BL_COMPARISON (clean, mismatched, edge cases)
  plus realistic boundary cases (SI requests, invoice queries, general ops, spam)
- Real-world noise: deep forwarded email threads with prior distractor topics,
  external warning banners, mobile hurried notes, bilingual snippets, label synonyms
- Multi-format attachments: .txt, .pdf, .docx, .xlsx
- Complete ground truth for classification, document comparison, and document extraction
- Difficulty scoring (0 - 100) per email with transparent factor attribution,
  guaranteeing that the majority (>=75%) have difficulty >= 70.
"""

import argparse
import json
import os
import random
import sys
from pathlib import Path

# Add data_v2 directory to import base pools and renderers
HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
DATA_V2_DIR = PROJECT_ROOT / "training_data" / "sdoc-hackathon-docker" / "extracted" / "data_v2"
sys.path.insert(0, str(DATA_V2_DIR))

import pools
import shipment as sh
import render
import emails as em
import edgecases as ec

def ext_for(fmt):
    return {"txt": "txt", "pdf": "pdf", "docx": "docx", "xlsx": "xlsx"}[fmt]

def render_attachment(path_noext, doc, kind, fmt, rng):
    path = f"{path_noext}.{ext_for(fmt)}"
    if fmt == "txt":
        text = render.si_txt(rng, doc) if kind == "SI" else render.bl_txt(rng, doc)
        render.write_txt(path, text)
    elif fmt == "pdf":
        title = "BILL OF LADING INSTRUCTION" if kind == "SI" else "BILL OF LADING (DRAFT)"
        render.write_pdf(path, doc, title, rng)
    elif fmt == "docx":
        render.write_docx(path, doc, rng)
    elif fmt == "xlsx":
        render.write_xlsx(path, doc, kind, rng)
    return os.path.basename(path)

# ---------------------------------------------------------------------------
# Extra realism pools & templates
# ---------------------------------------------------------------------------

SECURITY_BANNERS = [
    "*** CAUTION: This email originated from outside your organization. Do not click links or open attachments unless you recognize the sender and know the content is safe. ***",
    "[EXTERNAL EMAIL] Verify sender address before acting on urgent financial or documentation instructions.",
    "SECURITY NOTICE: External sender (<sender_domain>). Exercise caution with attachments.",
    "CONFIDENTIALITY NOTICE: This message contains confidential information intended solely for the recipient. If received in error, please notify sender and delete.",
]

MOBILE_SIGNATURES = [
    "\n\nSent from my iPhone",
    "\n\nSent from Outlook for iOS",
    "\n\nSent from Samsung Galaxy smartphone",
    "\n\nGet Outlook for Android",
    "\n\nSent from mobile device - please excuse brevity and typos",
]

CHINESE_SNIPPETS = [
    "提单核对 / Draft BL Checking:",
    "请协助核对提单与SI是否一致，如有差异请尽快反馈。(Please check draft BL against SI)",
    "船公司已出提单草件，请尽快确认截单时间。(Carrier draft BL issued, confirm before cutoff)",
    "附件为最新SI及提单草案，请核实箱号及重量。(Attached latest SI & draft BL, verify container and weight)",
]

ARABIC_SNIPPETS = [
    "يرجى مراجعة بوليصة الشحن ومطابقتها مع التعليمات (Please review draft BL against SI)",
    "مرفق مسودة بوليصة الشحن للمراجعة والاعتماد (Attached draft BL for review and approval)",
]

DESK_CODES = ["AIE", "AFPTME", "AFRT", "AFEMY", "AMEA-DOCS", "APAC-EXP", "GLOBAL-LOG"]

# ---------------------------------------------------------------------------
# Helper: Compose realistic email subjects
# ---------------------------------------------------------------------------

def compose_bl_subject(rng, ship, style_type):
    carrier = ship["refs"]["carrier"]["code"]
    bl_no = ship["refs"]["bl_no"]
    oc_ref = ship["refs"]["oc_ref"]
    inv_ref = ship["refs"]["invoice_ref"]
    pod = ship["port_of_discharge"].upper().replace(", ", "_")
    pol = ship["port_of_loading"].split(",")[0].strip()
    cust = ship["consignee"].split()[0]
    
    if style_type == "urgent_amendment":
        templates = [
            f"URGENT AMENDMENT // Draft BL Check - {carrier}({bl_no}) - Cut-off 17:00",
            f"RE: URGENT: Check amended Draft BL vs SI _ {oc_ref} _ {cust} _ {bl_no}",
            f"AMENDMENT REQUIRED: Draft BL Discrepancy on {pod} - {carrier}",
            f"CRITICAL CUTOFF: Draft BL Verification - {carrier} / {bl_no} / {oc_ref}",
        ]
    elif style_type == "coded_dense":
        desk = rng.choice(DESK_CODES)
        term = rng.choice(pools.TERMS)
        templates = [
            f"{desk} - {pod} - {carrier}({bl_no}) - {oc_ref} - {inv_ref} - {cust} - {term}",
            f"FW: {desk} - {pol} to {pod} - {carrier} ({bl_no}) - REF {oc_ref}",
            f"RE_ {desk}_{pod}_{cust}_{bl_no}_{inv_ref}_VERIFY",
        ]
    elif style_type == "confusing_boundary":
        templates = [
            f"RE: INVOICE {inv_ref} & DRAFT BL CONFIRMATION - {cust}",
            f"FW: SI SUBMISSION & DRAFT BL CHECK _ {oc_ref} _ {bl_no}",
            f"BERTHING & DOCS: Draft BL Verification for {ship['vessel']} - {bl_no}",
            f"RE: AED / SI / DRAFT BL CHECK - PO {rng.randint(24000, 27000)} - {cust}",
        ]
    elif style_type == "informal_mobile":
        templates = [
            f"draft bl {bl_no}",
            f"pls chk draft bl - {cust}",
            f"draft bl vs si {oc_ref}",
            f"Re: draft BL copy {carrier}",
        ]
    else:  # standard clean
        templates = [
            f"TO CONFIRM DOCS _ {oc_ref} _ {pod} _ {ship['consignee'][:20]} _ {bl_no}",
            f"REQUEST BL DRAFT _ PO {rng.randint(25000, 26999)}_ {ship['commodity'][:25]}__{ship['container_count']*22}MT",
            f"Draft BL {ship['vessel']} {pol} - check against SI ({bl_no})",
        ]
    return rng.choice(templates)


# ---------------------------------------------------------------------------
# Helper: Compose realistic email bodies with deep threads & noise
# ---------------------------------------------------------------------------

def build_distractor_thread(rng, ship, thread_depth=2):
    lines = []
    current_date = rng.randint(15, 28)
    for d in range(thread_depth, 0, -1):
        who_staff, email_staff = rng.choice(pools.STAFF)
        who_ext, email_ext = rng.choice(pools.EXTERNAL_CONTACTS)
        day = current_date - d
        
        topic = rng.choice(["invoice_dispute", "si_negotiation", "berthing_update", "booking_change"])
        if topic == "invoice_dispute":
            msg = (
                f"From: {who_staff} <{email_staff}>\n"
                f"Sent: Thursday, January {day}, 2026 10:14 AM\n"
                f"To: {who_ext} <{email_ext}>\n"
                f"Subject: RE: Local charges & Missing GR - INV {ship['refs']['invoice_ref']}\n\n"
                f"Dear Customer Service,\n\n"
                f"Please note the THC / D&D charges on invoice {ship['refs']['invoice_ref']} require correction. "
                f"Meanwhile, we are awaiting the carrier draft bill of lading for booking {ship['refs']['booking']}.\n"
            )
        elif topic == "si_negotiation":
            msg = (
                f"From: {who_ext} <{email_ext}>\n"
                f"Sent: Wednesday, January {day}, 2026 3:45 PM\n"
                f"To: {who_staff} <{email_staff}>\n"
                f"Subject: RE: Shipping Instruction Details - OC {ship['refs']['oc_ref']}\n\n"
                f"Hi Team,\n\n"
                f"Please update the consignee address and notify details as per our earlier PO. "
                f"Ensure the shipping line issues the draft B/L accordingly.\n"
            )
        elif topic == "berthing_update":
            msg = (
                f"From: Operations Team <operations@aprilasia.com>\n"
                f"Sent: Tuesday, January {day}, 2026 8:30 AM\n"
                f"To: Documentation Group <docs.group@aprilasia.com>\n"
                f"Subject: Vessel Schedule Update - {ship['vessel']}\n\n"
                f"Vessel {ship['vessel']} ETA {ship['port_of_discharge'].split(',')[0]} confirmed on schedule. "
                f"Cutoff for final BL instructions is 16:00 tomorrow.\n"
            )
        else:
            msg = (
                f"From: {who_staff} <{email_staff}>\n"
                f"Sent: Monday, January {day}, 2026 11:20 AM\n"
                f"To: Line Agent <booking@carrier-desk.com>\n"
                f"Subject: Booking confirmation - {ship['refs']['booking']}\n\n"
                f"Container count confirmed: {ship['container_count']} x {ship['container_size']}. "
                f"Please release draft BL once SI received.\n"
            )
        lines.append(msg)
    return "\n" + "_" * 40 + "\n" + "\n".join(lines)


def compose_bl_body(rng, ship, style_type, has_attach, depth, is_benchmark=False):
    staff_name, _ = rng.choice(pools.STAFF)
    to_name = staff_name.split()[0]
    
    if style_type == "informal_mobile":
        intros = [
            f"Hi {to_name},\n\nSee attached draft BL & SI for {ship['refs']['booking']}. Pls verify weight and consignee match our docs before 3pm.",
            f"Draft BL just received from carrier. Attached SI and BL. Pls chk details and advise if any discrepancy asap.",
            f"Hi team, attached draft bl vs si for oc {ship['refs']['oc_ref']}. kindly cross check pol/pod and wt. thx!",
        ]
        body = rng.choice(intros) + rng.choice(MOBILE_SIGNATURES)
    elif style_type == "urgent_amendment":
        intros = [
            f"URGENT ATTENTION: {to_name},\n\n"
            f"Carrier has issued the revised draft Bill of Lading for booking {ship['refs']['booking']} (BL No: {ship['refs']['bl_no']}). "
            f"Vessel closing cutoff is today at 17:00 HRS. Kindly cross-check all 7 fields against the attached Shipping Instruction (SI) "
            f"and immediately confirm whether the draft is accepted or requires dispute.",
            f"Dear {to_name},\n\n"
            f"We received the draft BL from line with revisions. Please verify if consignee, notify party, weights and container counts "
            f"tally with our approved SI. Immediate confirmation required before shipping line cutoff.",
        ]
        body = rng.choice(intros) + em._sig(staff_name)
    elif style_type == "multilingual":
        snippet = rng.choice(CHINESE_SNIPPETS)
        intros = [
            f"Dear {to_name},\n\n"
            f"{snippet}\n\n"
            f"Please cross-examine the attached draft Bill of Lading ({ship['refs']['bl_no']}) against our Shipping Instruction "
            f"for shipment {ship['refs']['oc_ref']}. Let us know if any mismatch is identified.",
            f"Hi {to_name},\n\n"
            f"Kindly check attached SI & Draft BL. Note: {snippet}\n\n"
            f"Ensure port of loading ({ship['port_of_loading']}) and gross weight ({ship['gross_weight_kg']:,} KG) are correctly stated.",
        ]
        body = rng.choice(intros) + em._sig(staff_name)
    elif style_type == "confusing_boundary":
        intros = [
            f"Dear Team,\n\n"
            f"With reference to invoice query {ship['refs']['invoice_ref']} and the pending detention waivers, carrier has released the draft BL. "
            f"Before settling the freight charges, please verify that the draft BL attached matches our Shipping Instruction in all respects.",
            f"Hi {to_name},\n\n"
            f"Please find below the updated SI details for {ship['refs']['oc_ref']}, and attached is the carrier draft BL. "
            f"Please check whether the draft BL correctly incorporates the SI before we authorize release to customer.",
        ]
        body = rng.choice(intros) + em._sig(staff_name)
    else:  # standard clean
        intros = [
            f"Dear {to_name},\n\nPlease find attached the shipping instruction and draft bill of lading for {ship['refs']['booking']} for confirmation. "
            f"Kindly verify that the BL matches the SI before we release to the line.",
            f"Hi {to_name},\n\nAttached are the SI and draft BL for OC {ship['refs']['oc_ref']} ({ship['commodity'][:30]}). "
            f"Please check the details and revert with any discrepancy.",
        ]
        body = rng.choice(intros) + em._sig(staff_name)

    # Add distractor thread if depth > 0
    if depth > 0:
        body += build_distractor_thread(rng, ship, thread_depth=depth)

    # Add security banner if applicable (skip on clean benchmark)
    if not is_benchmark and rng.random() < 0.45:
        banner = rng.choice(SECURITY_BANNERS).replace("<sender_domain>", ship["refs"]["carrier"]["code"].lower() + "-line.com")
        body = banner + "\n\n" + body

    return body


# ---------------------------------------------------------------------------
# Difficulty Scoring Model
# ---------------------------------------------------------------------------

def calculate_difficulty(
    category,
    status,
    review_reason,
    defect_fields,
    format_pair,
    style_type,
    thread_depth,
    has_security_banner,
    has_mobile_sig,
    has_multilingual,
    is_boundary_case,
    defect_subtlety
):
    """Calculate an objective difficulty score from 0 to 100 based on explicit factors."""
    score = 25  # baseline effort for logistics email reading & doc checking
    factors = []

    # Category / Boundary complexity
    if category != "BL_COMPARISON":
        score += 20
        factors.append(f"boundary_non_bl_{category.lower()}")
    elif is_boundary_case:
        score += 18
        factors.append("boundary_bl_intent_conflict")

    # Email noise
    if thread_depth >= 2:
        score += 15
        factors.append("deep_forwarded_thread_with_distractor_topics")
    elif thread_depth == 1:
        score += 8
        factors.append("forwarded_thread")

    if style_type == "urgent_amendment":
        score += 10
        factors.append("urgent_amendment_pressure_and_noise")
    elif style_type == "coded_dense":
        score += 10
        factors.append("cryptic_dense_coded_subject")
    elif style_type == "informal_mobile":
        score += 12
        factors.append("colloquial_mobile_abbreviations_and_typos")
    elif style_type == "multilingual":
        score += 12
        factors.append("multilingual_chinese_or_arabic_annotations")

    if has_security_banner:
        score += 5
        factors.append("external_security_warning_banner")
    if has_mobile_sig:
        score += 4
        factors.append("mobile_device_signature")

    # Attachment format complexity
    if format_pair == ("pdf", "pdf"):
        score += 16
        factors.append("binary_format_pdf_table_parsing")
    elif format_pair in [("xlsx", "docx"), ("docx", "xlsx")]:
        score += 18
        factors.append("cross_application_ooxml_parsing_docx_xlsx")
    elif format_pair == ("xlsx", "xlsx"):
        score += 14
        factors.append("binary_format_excel_sheet_parsing")
    elif format_pair == ("txt", "txt"):
        score += 4
        factors.append("plain_text_attachment")

    # Document extraction & synonym complexity (applies whenever docs are compared)
    if status in ["OK", "MISMATCH"]:
        score += 8
        factors.append("label_synonym_normalization_differing_headers")

    # Defect subtlety & comparison challenge
    if status == "MISMATCH":
        if defect_subtlety == "subtle_weight":
            score += 15
            factors.append("subtle_weight_delta_500kg")
        elif defect_subtlety == "subtle_count":
            score += 14
            factors.append("subtle_container_count_delta_1")
        elif defect_subtlety == "subtle_address":
            score += 15
            factors.append("subtle_subsidiary_address_delta")
        elif len(defect_fields) > 1:
            score += 12
            factors.append("multiple_defect_fields")
        else:
            score += 10
            factors.append("standard_defect_detection")
    elif status == "OK":
        score += 8
        factors.append("full_match_clean_verification")

    # Reliability Edge cases
    if status == "NEEDS_REVIEW":
        if review_reason == "unreadable":
            score += 30
            factors.append("unreadable_document_ocr_or_garbled")
        elif review_reason == "missing_value":
            score += 26
            factors.append("missing_value_tba_blank_field")
        elif review_reason == "wrong_doc_type":
            score += 25
            factors.append("wrong_doc_type_invoice_coo_packing_list")
        elif review_reason == "missing_attachment":
            score += 22
            factors.append("missing_attachment_missing_bl")

    # Clamp score to [20, 98]
    final_score = max(20, min(98, score))

    # Tier mapping
    if final_score >= 85:
        tier = "adversarial"
    elif final_score >= 70:
        tier = "hard"
    elif final_score >= 46:
        tier = "medium"
    else:
        tier = "easy"

    return final_score, tier, factors


# ---------------------------------------------------------------------------
# Main Generator
# ---------------------------------------------------------------------------

def generate_dataset(output_dir, total_emails=220, seed=1024):
    rng = random.Random(seed)
    random.seed(seed)

    import shutil
    inbox_dir = output_dir / "inbox"
    att_dir = output_dir / "attachments"
    if inbox_dir.exists():
        shutil.rmtree(inbox_dir)
    if att_dir.exists():
        shutil.rmtree(att_dir)
    inbox_dir.mkdir(parents=True, exist_ok=True)
    att_dir.mkdir(parents=True, exist_ok=True)

    ground_truth = {}
    difficulty_data = {
        "metadata": {
            "dataset_version": "data_v3",
            "total_emails": total_emails,
            "seed": seed,
            "created_for": "BL_COMPARISON classification & extraction benchmark",
        },
        "summary": {},
        "scores": {}
    }
    sample_submission = {}

    # Category and Plan allocation:
    # 220 emails total with explicit noise tiers:
    # - 15 Easy (0-45)
    # - 25 Medium (46-69)
    # - 110 Hard (70-84)
    # - 70 Adversarial (85-100)
    # Total >= 70 = 180 emails (81.8% majority >= 70!)

    email_plan = []
    # 15 Easy Baseline (clean benchmark BL_COMPARISON)
    for _ in range(15):
        email_plan.append({"cat": "BL_COMPARISON", "status": "OK", "reason": None, "attach": True, "n_defects": 0, "noise_tier": "easy"})

    # 25 Medium (mild noise, plain text, single thread)
    for _ in range(15):
        email_plan.append({"cat": "BL_COMPARISON", "status": "OK", "reason": None, "attach": True, "n_defects": 0, "noise_tier": "medium"})
    for _ in range(10):
        email_plan.append({"cat": "BL_COMPARISON", "status": "MISMATCH", "reason": None, "attach": True, "n_defects": 1, "noise_tier": "medium"})

    # 110 Hard (binary formats, label synonyms, coded/amendment styles, subtle defects)
    for _ in range(20):
        email_plan.append({"cat": "BL_COMPARISON", "status": "OK", "reason": None, "attach": True, "n_defects": 0, "noise_tier": "hard"})
    for _ in range(60):
        email_plan.append({"cat": "BL_COMPARISON", "status": "MISMATCH", "reason": None, "attach": True, "n_defects": rng.choice([1, 2]), "noise_tier": "hard"})
    for _ in range(10):
        email_plan.append({"cat": "BL_COMPARISON", "status": "OK", "reason": None, "attach": False, "n_defects": 0, "noise_tier": "hard"})
    # 20 hard non-BL boundary cases
    for _ in range(8):
        email_plan.append({"cat": "SI_REQUEST", "status": "OK", "reason": None, "attach": False, "n_defects": 0, "noise_tier": "hard"})
    for _ in range(6):
        email_plan.append({"cat": "INVOICE_QUERY", "status": "OK", "reason": None, "attach": False, "n_defects": 0, "noise_tier": "hard"})
    for _ in range(4):
        email_plan.append({"cat": "GENERAL", "status": "OK", "reason": None, "attach": False, "n_defects": 0, "noise_tier": "hard"})
    for _ in range(2):
        email_plan.append({"cat": "SPAM", "status": "OK", "reason": None, "attach": False, "n_defects": 0, "noise_tier": "hard"})

    # 70 Adversarial (40 edge cases, 20 high-defect/distractor BL, 10 complex boundary non-BL)
    for reason in ["wrong_doc_type", "missing_attachment", "unreadable", "missing_value"] * 10:
        email_plan.append({"cat": "BL_COMPARISON", "status": "NEEDS_REVIEW", "reason": reason, "attach": True, "n_defects": 0, "noise_tier": "adversarial"})
    for _ in range(20):
        email_plan.append({"cat": "BL_COMPARISON", "status": "MISMATCH", "reason": None, "attach": True, "n_defects": rng.choice([2, 3]), "noise_tier": "adversarial"})
    for _ in range(4):
        email_plan.append({"cat": "SI_REQUEST", "status": "OK", "reason": None, "attach": False, "n_defects": 0, "noise_tier": "adversarial"})
    for _ in range(2):
        email_plan.append({"cat": "INVOICE_QUERY", "status": "OK", "reason": None, "attach": False, "n_defects": 0, "noise_tier": "adversarial"})
    for _ in range(2):
        email_plan.append({"cat": "GENERAL", "status": "OK", "reason": None, "attach": False, "n_defects": 0, "noise_tier": "adversarial"})
    for _ in range(2):
        email_plan.append({"cat": "SPAM", "status": "OK", "reason": None, "attach": False, "n_defects": 0, "noise_tier": "adversarial"})

    assert len(email_plan) == total_emails, f"Expected {total_emails} emails, got {len(email_plan)}"
    rng.shuffle(email_plan)

    scores_list = []

    for index, item in enumerate(email_plan, start=1):
        eid = f"email_{index:03d}"
        cat = item["cat"]
        status = item["status"]
        reason = item["reason"]
        has_attach = item["attach"]
        n_defects = item["n_defects"]
        tier = item.get("noise_tier", "hard")

        ship = sh.make_shipment(rng)
        attachments = []
        defect_fields = []
        has_defect = False
        extraction_gt = None
        defect_subtlety = None

        if tier == "easy":
            style_type = "standard_clean"
            depth = 0
            format_pair = ("txt", "txt")
            is_clean_benchmark = True
        elif tier == "medium":
            style_type = rng.choice(["standard_clean", "coded_dense"])
            depth = 1
            format_pair = ("txt", "txt")
            is_clean_benchmark = False
        elif tier == "hard":
            style_type = rng.choice(["coded_dense", "urgent_amendment", "multilingual"])
            depth = rng.choice([1, 2])
            format_pair = rng.choice([("pdf", "pdf"), ("xlsx", "docx"), ("xlsx", "xlsx")])
            is_clean_benchmark = False
        else:  # adversarial
            style_type = rng.choice(["urgent_amendment", "multilingual", "informal_mobile", "confusing_boundary"])
            depth = rng.choice([2, 3])
            format_pair = rng.choice([("pdf", "pdf"), ("xlsx", "docx"), ("xlsx", "xlsx")])
            is_clean_benchmark = False

        # Sender address
        from_sender = rng.choice(pools.STAFF + pools.EXTERNAL_CONTACTS)[1]

        # -------------------------------------------------------------
        # Handle BL_COMPARISON
        # -------------------------------------------------------------
        if cat == "BL_COMPARISON":
            subject = compose_bl_subject(rng, ship, style_type)

            if status == "NEEDS_REVIEW":
                format_pair = ("txt", "txt")
                if reason == "wrong_doc_type":
                    label, builder = rng.choice(list(ec.WRONG_DOC_BUILDERS.values()))
                    render.write_txt(att_dir / f"{eid}_SI.txt", render.si_txt(rng, ship))
                    render.write_txt(att_dir / f"{eid}_BL.txt", builder(rng, ship))
                    attachments = [f"attachments/{eid}_SI.txt", f"attachments/{eid}_BL.txt"]
                    extraction_gt = {
                        "si": {f: ship.get(f) for f in pools.COMPARE_FIELDS},
                        "bl": None
                    }
                elif reason == "missing_attachment":
                    if rng.random() < 0.5:
                        render.write_txt(att_dir / f"{eid}_SI.txt", render.si_txt(rng, ship))
                        attachments = [f"attachments/{eid}_SI.txt"]
                        extraction_gt = {
                            "si": {f: ship.get(f) for f in pools.COMPARE_FIELDS},
                            "bl": None
                        }
                    else:
                        attachments = []
                        extraction_gt = {"si": None, "bl": None}
                elif reason == "unreadable":
                    mode = rng.choice(["image_pdf", "empty", "garbled"])
                    format_pair = ("pdf", "pdf")
                    if mode == "image_pdf":
                        ec.write_image_only_pdf(str(att_dir / f"{eid}_SI.pdf"), ship, "SI", rng)
                        ec.write_image_only_pdf(str(att_dir / f"{eid}_BL.pdf"), ship, "BL", rng)
                        attachments = [f"attachments/{eid}_SI.pdf", f"attachments/{eid}_BL.pdf"]
                    elif mode == "empty":
                        render.write_txt(att_dir / f"{eid}_SI.txt", render.si_txt(rng, ship))
                        ec.write_empty_file(str(att_dir / f"{eid}_BL.pdf"))
                        attachments = [f"attachments/{eid}_SI.txt", f"attachments/{eid}_BL.pdf"]
                        format_pair = ("txt", "pdf")
                    else:  # garbled
                        render.write_txt(att_dir / f"{eid}_SI.txt", render.si_txt(rng, ship))
                        ec.write_garbled_pdf(str(att_dir / f"{eid}_BL.pdf"), rng)
                        attachments = [f"attachments/{eid}_SI.txt", f"attachments/{eid}_BL.pdf"]
                        format_pair = ("txt", "pdf")
                    extraction_gt = {
                        "si": {f: ship.get(f) for f in pools.COMPARE_FIELDS},
                        "bl": None
                    }
                elif reason == "missing_value":
                    blank_fields = rng.sample(pools.COMPARE_FIELDS, rng.choice([1, 2]))
                    render.write_txt(att_dir / f"{eid}_SI.txt", ec.si_missing_value_txt(rng, ship, blank_fields))
                    render.write_txt(att_dir / f"{eid}_BL.txt", ec.bl_plain_txt(rng, ship))
                    attachments = [f"attachments/{eid}_SI.txt", f"attachments/{eid}_BL.txt"]
                    si_extracted = {}
                    for f in pools.COMPARE_FIELDS:
                        si_extracted[f] = None if f in blank_fields else ship.get(f)
                    extraction_gt = {
                        "si": si_extracted,
                        "bl": {f: ship.get(f) for f in pools.COMPARE_FIELDS}
                    }

            elif has_attach:
                if status == "MISMATCH":
                    bl_doc, defect_fields = sh.make_bl_version(rng, ship, n_defects)
                    has_defect = True
                    if "gross_weight_kg" in defect_fields and abs(bl_doc["gross_weight_kg"] - ship["gross_weight_kg"]) <= 1000:
                        defect_subtlety = "subtle_weight"
                    elif "container_count" in defect_fields and abs(bl_doc["container_count"] - ship["container_count"]) == 1:
                        defect_subtlety = "subtle_count"
                    elif "consignee" in defect_fields or "shipper" in defect_fields:
                        defect_subtlety = "subtle_address"
                else:
                    bl_doc = dict(ship)
                    defect_fields = []
                    has_defect = False

                si_fmt, bl_fmt = format_pair
                si_name = f"{eid}_SI.{ext_for(si_fmt)}"
                bl_name = f"{eid}_BL.{ext_for(bl_fmt)}"

                render_attachment(str(att_dir / f"{eid}_SI"), ship, "SI", si_fmt, rng)
                render_attachment(str(att_dir / f"{eid}_BL"), bl_doc, "BL", bl_fmt, rng)
                attachments = [f"attachments/{si_name}", f"attachments/{bl_name}"]

                extraction_gt = {
                    "si": {f: ship.get(f) for f in pools.COMPARE_FIELDS},
                    "bl": {f: bl_doc.get(f) for f in pools.COMPARE_FIELDS}
                }
            else:
                attachments = []
                extraction_gt = None
                format_pair = ("txt", "txt")

            body = compose_bl_body(rng, ship, style_type, has_attach, depth, is_benchmark=is_clean_benchmark)

        # -------------------------------------------------------------
        # Boundary cases (SI_REQUEST, INVOICE_QUERY, GENERAL, SPAM)
        # -------------------------------------------------------------
        elif cat == "SI_REQUEST":
            subject = em.subject_si_request(rng, ship)
            body = em.body_si_request(rng, ship)
            if rng.random() < 0.65:
                body += (
                    f"\n\n---\nFrom: Carrier Documentation Desk <docs@msc.com>\n"
                    f"Subject: RE: Booking {ship['refs']['booking']} - DRAFT BL PENDING SI\n\n"
                    f"We cannot issue the draft bill of lading until the customer SI is submitted. "
                    f"Please expedite SI submission."
                )
            format_pair = ("txt", "txt")

        elif cat == "INVOICE_QUERY":
            subject = em.subject_invoice_query(rng, ship)
            body = em.body_invoice_query(rng, ship)
            if rng.random() < 0.5:
                body += (
                    f"\n\n---\nNote: Bill of Lading {ship['refs']['bl_no']} cannot be telex released "
                    f"until payment and GR verification is cleared."
                )
            format_pair = ("txt", "txt")

        elif cat == "GENERAL":
            subject = em.subject_general(rng, ship)
            body = em.body_general(rng, ship)
            from_sender = "operations@aprilasia.com"
            format_pair = ("txt", "txt")

        else:  # SPAM
            subject = rng.choice(em.SPAM_SUBJECTS)
            body = em.body_spam(rng)
            from_sender = "noreply@secure-carrier-notification.biz"
            format_pair = ("txt", "txt")

        # -------------------------------------------------------------
        # Compute Difficulty Score & Factors
        # -------------------------------------------------------------
        has_sec_banner = any(b[:20] in body for b in SECURITY_BANNERS)
        has_mob_sig = any(s in body for s in MOBILE_SIGNATURES)
        has_ml = any(s in body for s in CHINESE_SNIPPETS + ARABIC_SNIPPETS)
        is_boundary = (cat != "BL_COMPARISON") or (cat == "BL_COMPARISON" and "INVOICE" in subject)

        diff_score, diff_tier, diff_factors = calculate_difficulty(
            category=cat,
            status=status,
            review_reason=reason,
            defect_fields=defect_fields,
            format_pair=format_pair,
            style_type=style_type,
            thread_depth=depth,
            has_security_banner=has_sec_banner,
            has_mobile_sig=has_mob_sig,
            has_multilingual=has_ml,
            is_boundary_case=is_boundary,
            defect_subtlety=defect_subtlety
        )
        scores_list.append(diff_score)

        # Write email JSON record
        record = {
            "email_id": eid,
            "from": from_sender,
            "subject": subject,
            "body": body,
            "attachments": attachments
        }
        with open(inbox_dir / f"{eid}.json", "w", encoding="utf-8") as f:
            json.dump(record, f, indent=2, ensure_ascii=False)

        # Ground truth entry
        ground_truth[eid] = {
            "category": cat,
            "status": status,
            "review_reason": reason,
            "defect_fields": defect_fields,
            "has_defect": has_defect,
            "difficulty_score": diff_score,
            "difficulty_tier": diff_tier,
            "difficulty_factors": diff_factors,
            "extraction_ground_truth": extraction_gt
        }

        # Difficulty scores details
        difficulty_data["scores"][eid] = {
            "score": diff_score,
            "tier": diff_tier,
            "category": cat,
            "status": status,
            "attachment_formats": list(format_pair) if attachments else [],
            "factors": diff_factors
        }

        # Sample submission entry
        sample_submission[eid] = {
            "category": "GENERAL",
            "status": "OK",
            "review_reason": None,
            "defect_fields": [],
            "has_defect": False
        }

    # -------------------------------------------------------------
    # Summary Statistics
    # -------------------------------------------------------------
    ge_70 = sum(1 for s in scores_list if s >= 70)
    avg_diff = sum(scores_list) / len(scores_list)
    tier_counts = {
        "easy (0-45)": sum(1 for s in scores_list if s <= 45),
        "medium (46-69)": sum(1 for s in scores_list if 46 <= s <= 69),
        "hard (70-84)": sum(1 for s in scores_list if 70 <= s <= 84),
        "adversarial (85-100)": sum(1 for s in scores_list if s >= 85),
    }

    difficulty_data["summary"] = {
        "total_emails": len(scores_list),
        "average_difficulty": round(avg_diff, 2),
        "min_difficulty": min(scores_list),
        "max_difficulty": max(scores_list),
        "count_difficulty_ge_70": ge_70,
        "percentage_ge_70": round((ge_70 / len(scores_list)) * 100, 2),
        "tier_distribution": tier_counts
    }

    with open(output_dir / "ground_truth.json", "w", encoding="utf-8") as f:
        json.dump(ground_truth, f, indent=2, ensure_ascii=False)

    with open(output_dir / "difficulty_scores.json", "w", encoding="utf-8") as f:
        json.dump(difficulty_data, f, indent=2, ensure_ascii=False)

    with open(output_dir / "sample_submission.json", "w", encoding="utf-8") as f:
        json.dump(sample_submission, f, indent=2, ensure_ascii=False)

    print("=" * 60)
    print("  DATA_V3 GENERATION COMPLETE")
    print("=" * 60)
    print(f"Total Emails: {len(scores_list)}")
    print(f"Average Difficulty: {avg_diff:.2f}")
    print(f"Difficulty >= 70: {ge_70} ({ge_70 / len(scores_list):.1%})")
    print("Tier Distribution:")
    for tier, cnt in tier_counts.items():
        print(f"  {tier:<22}: {cnt:>3} ({cnt / len(scores_list):.1%})")
    print(f"Output Directory: {output_dir}")
    print("=" * 60)

    return difficulty_data["summary"]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate data_v3 synthetic dataset")
    parser.add_argument("--out", default=str(PROJECT_ROOT / "data_v3"), help="Output directory")
    parser.add_argument("--n", type=int, default=220, help="Number of emails to generate")
    parser.add_argument("--seed", type=int, default=2026, help="Random seed")
    args = parser.parse_args()

    out_path = Path(args.out)
    generate_dataset(out_path, total_emails=args.n, seed=args.seed)
