import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, X } from "lucide-react";
import { Button } from "./ui/button";

/** Bumped when the steps change, so a returning operator sees what is new. */
export const TOUR_VERSION = 5;
const STORAGE_KEY = "cargolens.tour.seen";

export interface TourStep {
  page?: 'inbox' | 'builder';
  /** Matches a `data-tour` attribute in the app. Absent means a centred step. */
  target?: string;
  title: string;
  body: string;
  /** Shown when the step's target is not on screen, e.g. a collapsed sidebar. */
  fallback?: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    title: "CargoLens reads the inbox for you",
    body:
      "It decides what every email is asking for, then checks the shipping instruction against the draft bill of lading using the actual attached documents. This walkthrough covers every part of the workspace. Use the arrow keys to move, Escape to leave.",
  },
  {
    target: 'chat-launcher',
    title: 'Ask your inbox',
    body: 'The floating chat button opens your email assistant. Ask about urgent shipments, missing documents, a sender or a booking reference. It searches the emails already imported into this workspace.',
  },
  {
    target: 'chat-scope',
    title: 'Choose the emails to search',
    body: 'Search all workspace emails or just the selected email. Try “Summarize email_001” or ask a follow-up. Switching scope starts a fresh conversation so answers stay tied to the right records.',
  },
  {
    target: 'chat-compose',
    title: 'Answers checked against evidence',
    body: 'Jev screens retrieved text for injected instructions, then checks each generated claim against its cited chunk. Numbered source buttons open the matching email. The assistant is read-only; inspect sources before acting.',
  },
  {
    target: "nav",
    title: "Four places to work",
    body:
      "Inbox holds the queue and case detail. Measurements records run history. Workflow builder lets you configure the checking flow. Delivery log shows operational replies. The number beside Inbox is the live case count.",
    fallback: "Open the sidebar with the toggle at the top left to see the four sections.",
  },
  {
    target: "counts",
    title: "What the workspace holds right now",
    body:
      "Total, classified, still queued, and failed. Failed means the classifier errored on that row and it can be retried from the case; it never means the email was quietly dropped.",
  },
  {
    target: "import",
    title: "Bring the inbox in",
    body:
      "Import reads the configured dataset and classifies everything that is new or whose source changed. Re-importing is safe: unchanged emails keep their existing decision rather than being reclassified.",
  },
  {
    target: "map",
    title: "The inbox map",
    body:
      "Every classified intent and operational state at a glance. Select a labelled node to filter the list to that branch, then use the breadcrumb to come back. Drag to pan, scroll to zoom.",
  },
  {
    target: "filters",
    title: "Search and filter",
    body:
      "Search matches subject, sender and reference. The two dropdowns narrow by classified category and by verification state. They combine, so you can ask for BL comparisons that are still awaiting documents.",
  },
  {
    target: "list",
    title: "The correspondence list",
    body:
      "Each row shows the sender, the classified category and the verification state. Press J and K to move through the list without leaving the keyboard.",
  },
  {
    target: "case",
    title: "One case at a time",
    body:
      "The header carries the verification state, how many documents were supplied, and which decision version you are looking at. Decisions are versioned and never overwritten, so the history stays readable.",
  },
  {
    target: "tabs",
    title: "Three views of a case",
    body:
      "Document check is the evidence. Message and intent is what the sender actually asked for and how confident the classifier was. Activity is the full event trail for the case.",
  },
  {
    target: "check",
    title: "Seven fields, each with its source",
    body:
      "Shipper, consignee, notify party, both ports, container count and gross weight. Each result opens to show the exact excerpt, its location in the document and the hash of the file it came from. Where a comparison does not apply, this panel says why instead of showing an empty grid.",
  },
  {
    target: "sources",
    title: "Inspect the documents",
    body:
      "View sources opens the parsed excerpts, the recovery evidence for scanned files, and the hash of every attachment read. It appears when the case actually has documents.",
  },
  {
    target: "next-action",
    title: "The next action, and the reply",
    body:
      "Compare documents runs the seven-field check. Preview shows the exact reply the case would send, and nothing is sent from a preview. A match can only be confirmed when all seven fields are verified from two different documents with no blockers.",
  },
  {
    target: 'flow-canvas',
    page: 'builder',
    title: "The workflow builder",
    body:
      "Workflow builder, in the sidebar, draws the SI-to-BL checking flow as a graph you can change: six node types, a trigger, the comparison, conditions and the two outcomes. It runs through the same functions as the pipeline, and a graph that would not execute is refused with the reason rather than saved as a drawing.",
  },
  {
    target: "deliveries",
    title: "Operational replies",
    body:
      "Every reply the system queued or sent, with its state. Sending stays off until it is explicitly enabled; until then validated replies wait here rather than going out.",
  },
  {
    target: "stream",
    title: "Live event stream",
    body:
      "The workspace follows server events as they happen and replays anything missed after a reconnect, so the view does not silently go stale.",
  },
  {
    target: "shortcuts",
    title: "Keyboard shortcuts",
    body:
      "Open the shortcut list here at any time. You can restart this walkthrough from the same menu whenever you want it again.",
  },
];

export const FLOW_TOUR_STEPS: TourStep[] = [
  { target: 'flow-canvas', title: 'Your document workflow', body: 'Follow the graph from trigger through document comparison to an outcome. Drag the canvas to pan and use its zoom controls. Connections define the order the interpreter executes.' },
  { target: 'flow-palette', title: 'Add the right step', body: 'Choose a trigger, a Jev question, field comparison, condition, draft reply or escalation. Adding a node gives it a valid starting configuration; connect it into the graph before saving.' },
  { target: 'flow-inspector', title: 'Configure a selected node', body: 'Select a node on the canvas to edit its settings here. Choose the question, fields or condition it uses. A condition has separate true and false outputs. Removing a node also removes its connections.' },
  { target: 'flow-save', title: 'Validate and save', body: 'Save flow becomes available when the graph validates. Invalid connections or incomplete paths are explained above the canvas. Saving stores a new configuration; it does not send an email or run the workflow.' },
  { target: 'flow-help', title: 'Return to this guide', body: 'Open Builder guide whenever you need a reminder. Use the workspace chat to inspect email evidence, then return here to configure how cases should move through your workflow.' },
];

export function shouldOpenFlowTour(): boolean {
  try { return globalThis.localStorage?.getItem('cargolens.flow-tour.seen') !== '1'; }
  catch { return true; }
}
export function markFlowTourSeen(): void {
  try { globalThis.localStorage?.setItem('cargolens.flow-tour.seen', '1'); }
  catch { return; }
}

function readSeen(storage: Storage | undefined): number {
  try {
    return Number(storage?.getItem(STORAGE_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

export function shouldOpenTour(storage: Storage | undefined = globalThis.localStorage): boolean {
  return readSeen(storage) < TOUR_VERSION;
}

export function markTourSeen(storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(STORAGE_KEY, String(TOUR_VERSION));
  } catch {
    /* A workspace with storage blocked simply sees the tour again. */
  }
}

type Box = { top: number; left: number; width: number; height: number } | null;

export function Tour({ close, steps = TOUR_STEPS, onStepChange, onFinish = markTourSeen }: { close: () => void; steps?: TourStep[]; onStepChange?: (step: TourStep) => void; onFinish?: () => void }) {
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState<Box>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const step = steps[index];
  const last = index === steps.length - 1;
  useEffect(() => { onStepChange?.(step); }, [step, onStepChange]);

  const finish = useCallback(() => {
    onFinish();
    close();
  }, [close, onFinish]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => opener?.focus?.();
  }, []);

  // Measure after paint so the ring lands on the element's real position.
  useLayoutEffect(() => {
    if (!step.target) {
      setBox(null);
      return;
    }
    const measure = () => {
      const node = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
      if (!node) { setBox(null); return; }
      const rect = node.getBoundingClientRect();
      const next = rect.width && rect.height ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height } : null;
      setBox(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    const node = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
    node?.scrollIntoView({ block: "center", behavior: "instant" });
    measure();
    const timer = window.setTimeout(measure, 320);
    const observer = new MutationObserver(measure);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [step.target, index]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setIndex((current) => Math.min(current + 1, steps.length - 1));
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setIndex((current) => Math.max(current - 1, 0));
    }
  }

  const missing = !!step.target && !box;

  return (
    <dialog
      className="tour"
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        finish();
      }}
      onKeyDown={onKeyDown}
      aria-labelledby="tour-title"
    >
      {box && (
        <div
          className="tour-ring"
          aria-hidden="true"
          style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
        />
      )}
      <div className={`tour-card ${step.target?.startsWith('chat-') ? 'tour-card--chat' : ''} ${step.target === 'chat-scope' ? 'tour-card--chat-scope' : ''}`} role="document">
        <p className="overline">
          Step {index + 1} of {steps.length}
        </p>
        <h2 id="tour-title">{step.title}</h2>
        <p>{step.body}</p>
        {missing && step.fallback && <p className="tour-hint">{step.fallback}</p>}
        <div
          className="tour-progress"
          role="progressbar"
          aria-valuenow={index + 1}
          aria-valuemin={1}
          aria-valuemax={steps.length}
          aria-label="Walkthrough progress"
        >
          <span style={{ inlineSize: `${((index + 1) / steps.length) * 100}%` }} />
        </div>
        <div className="tour-actions">
          <Button variant="ghost" size="small" onClick={finish}>
            Skip the walkthrough
          </Button>
          <div className="tour-step-buttons">
            <Button
              variant="outline"
              size="small"
              disabled={index === 0}
              onClick={() => setIndex((current) => Math.max(current - 1, 0))}
            >
              <ArrowLeft size={15} />
              Back
            </Button>
            <Button
              size="small"
              onClick={() => (last ? finish() : setIndex((current) => current + 1))}
            >
              {last ? "Start working" : "Next"}
              {!last && <ArrowRight size={15} />}
            </Button>
          </div>
        </div>
      </div>
      <button className="tour-close" type="button" onClick={finish} aria-label="Close the walkthrough">
        <X size={18} />
      </button>
    </dialog>
  );
}
