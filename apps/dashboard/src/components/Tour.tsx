import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, X } from "lucide-react";
import { Button } from "./ui/button";

/** Bumped when the steps change, so a returning operator sees what is new. */
export const TOUR_VERSION = 3;
const STORAGE_KEY = "cargolens.tour.seen";

export interface TourStep {
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
    target: "nav",
    title: "Three places to work",
    body:
      "Inbox is the queue and the case detail. Measurements is the recorded run history. Delivery log is every operational reply, sent or held. The number beside Inbox is the live case count.",
    fallback: "Open the sidebar with the toggle at the top left to see the three sections.",
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

export function Tour({ close }: { close: () => void }) {
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState<Box>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const step = TOUR_STEPS[index];
  const last = index === TOUR_STEPS.length - 1;

  const finish = useCallback(() => {
    markTourSeen();
    close();
  }, [close]);

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
    const node = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
    if (!node) {
      setBox(null);
      return;
    }
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setBox(
        rect.width && rect.height
          ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
          : null,
      );
    };
    measure();
    const timer = window.setTimeout(measure, 320);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [step.target, index]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setIndex((current) => Math.min(current + 1, TOUR_STEPS.length - 1));
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
      <div className="tour-card" role="document">
        <p className="overline">
          Step {index + 1} of {TOUR_STEPS.length}
        </p>
        <h2 id="tour-title">{step.title}</h2>
        <p>{step.body}</p>
        {missing && step.fallback && <p className="tour-hint">{step.fallback}</p>}
        <div
          className="tour-progress"
          role="progressbar"
          aria-valuenow={index + 1}
          aria-valuemin={1}
          aria-valuemax={TOUR_STEPS.length}
          aria-label="Walkthrough progress"
        >
          <span style={{ inlineSize: `${((index + 1) / TOUR_STEPS.length) * 100}%` }} />
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
