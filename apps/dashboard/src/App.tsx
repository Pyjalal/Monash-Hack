import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Inbox,
  ChartNoAxesCombined,
  Send,
  Search,
  ArrowUpRight,
  Upload,
  RefreshCw,
  LogOut,
  ShieldCheck,
  Command,
  X,
  ArrowRight,
  CircleHelp,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "./components/ui/button";
import { Mark, DocumentArt } from "./components/Artwork";
import { CaseView } from "./components/CaseView";
import { Measurements, DeliveryLog } from "./components/Measurements";
import { InboxMap } from "./components/InboxMap";
import { Tour, shouldOpenTour } from "./components/Tour";
import {
  createApiClient,
  CATEGORY_LABEL,
  WORKFLOW_LABEL,
  describeError,
  type InboxRow,
  type DashboardReport,
  type Delivery,
  type GmailStatus,
} from "./lib/api";
import {
  clearSession,
  defaultApiUrl,
  readSession,
  SESSION_MAX_AGE_MS,
  writeSession,
  type Session,
} from "./lib/session";
import { openEventStream, type StreamState } from "./lib/sse";
import { counts, duration, filterRows } from "./lib/view-model";

const AUTH_REQUIRED = import.meta.env.VITE_AUTH_REQUIRED !== "false";

/** Long form for screen readers/labels; short form replaces ellipses where screen space is limited. */
const STREAM_LABEL: Record<StreamState, string> = {
  connecting: "Event stream connecting",
  replaying: "Replaying saved events",
  live: "Live event stream",
  reconnecting: "Event stream reconnecting",
  offline: "Event stream offline",
};
const STREAM_LABEL_SHORT: Record<StreamState, string> = {
  connecting: "Connecting…",
  replaying: "Replaying saved events",
  live: "Live event stream",
  reconnecting: "Reconnecting…",
  offline: "Offline",
};

function anonymousSession(): Session {
  return { token: "", apiUrl: defaultApiUrl(), issuedAt: Date.now() };
}

export function App() {
  const [session, setSession] = useState(() =>
    AUTH_REQUIRED ? readSession(sessionStorage) : anonymousSession(),
  );
  const [reason, setReason] = useState("");
  const logout = useCallback((message = "") => {
    if (!AUTH_REQUIRED) {
      setReason(message);
      return;
    }
    clearSession(sessionStorage);
    setSession(null);
    setReason(message);
  }, []);
  useEffect(() => {
    if (!AUTH_REQUIRED || !session) return;
    const timer = setTimeout(
      () => logout("Session expired. Sign in to continue."),
      Math.max(0, session.issuedAt + SESSION_MAX_AGE_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [session, logout]);
  return session ? (
    <Workspace session={session} logout={logout} authRequired={AUTH_REQUIRED} />
  ) : (
    <Login
      reason={reason}
      onLogin={(value) => {
        writeSession(sessionStorage, value);
        setSession(value);
        setReason("");
      }}
    />
  );
}

function Login({
  onLogin,
  reason,
}: {
  onLogin: (value: Session) => void;
  reason: string;
}) {
  const [url, setUrl] = useState(defaultApiUrl);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const parsed = new URL(url);
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      )
        throw new Error(
          "Use an HTTP API address without credentials or query parameters.",
        );
      if (
        parsed.protocol !== "https:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
      )
        throw new Error("Remote API connections require HTTPS.");
      const apiUrl = url.replace(/\/+$/, "");
      await createApiClient(apiUrl, token, () => {}).emails();
      onLogin({ token, apiUrl, issuedAt: Date.now() });
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <section className="login-story">
        <a className="brand" href="#">
          <Mark />
          CargoLens
        </a>
        <div>
          <p className="overline">Shipping operations in focus</p>
          <h1>
            Every document.
            <br />A clearer decision.
          </h1>
          <p>
            Move from correspondence to verified evidence in one considered
            workspace.
          </p>
          <DocumentArt large />
        </div>
        <small>Source-backed decisions. A visible next step.</small>
      </section>
      <section className="login-form">
        <div className="login-box">
          <span className="icon-tile">
            <ShieldCheck />
          </span>
          <h2>Welcome to your workspace</h2>
          <p className="muted">Connect securely to your CargoLens service.</p>
          <form onSubmit={submit}>
            <label htmlFor="api-url">API address</label>
            <input
              id="api-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
              autoComplete="url"
            />
            <label htmlFor="access-token">Workspace access token</label>
            <input
              id="access-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
              autoComplete="current-password"
              aria-describedby="session-note"
            />
            <p id="session-note" className="small muted">
              Access lasts eight hours in this tab. Provider and mailbox
              credentials stay on the server.
            </p>
            {(error || reason) && (
              <p role="alert" className="error-box">
                {error || reason}
              </p>
            )}
            <Button disabled={busy}>
              {busy ? "Connecting…" : "Open workspace"}
              <ArrowRight size={16} />
            </Button>
          </form>
          <p className="small muted">
            Your administrator provides the workspace token. It is never bundled
            with this application.
          </p>
        </div>
      </section>
    </main>
  );
}

export function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.showModal();
    return () => {
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={close}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      aria-labelledby="modal-title"
    >
      <header className="modal-head">
        <h2 id="modal-title">{title}</h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close dialog"
          onClick={close}
        >
          <X size={19} />
        </Button>
      </header>
      {children}
    </dialog>
  );
}

function Workspace({
  session,
  logout,
  authRequired,
}: {
  session: Session;
  logout: (reason?: string) => void;
  authRequired: boolean;
}) {
  const api = useMemo(
    () =>
      createApiClient(session.apiUrl, session.token, () =>
        logout("Session rejected. Sign in again."),
      ),
    [session, logout],
  );
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [report, setReport] = useState<DashboardReport>();
  const [outbox, setOutbox] = useState<Delivery[]>([]);
  const [gmail, setGmail] = useState<GmailStatus>();
  const [page, setPage] = useState("inbox");
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [workflow, setWorkflow] = useState("");
  const [mapStatus, setMapStatus] = useState("");
  const [stream, setStream] = useState<StreamState>("connecting");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [commands, setCommands] = useState(false);
  // New operators get the walkthrough once; it can be replayed from the command list.
  const [tour, setTour] = useState(() => shouldOpenTour());
  const [mobileNav, setMobileNav] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [revision, setRevision] = useState(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inRefresh = useRef(false);
  const visible = useMemo(
    () => filterRows(rows, query, category, workflow, mapStatus),
    [rows, query, category, workflow, mapStatus],
  );
  const virtual = useVirtualizer({
    count: visible.length,
    getScrollElement: () => list.current,
    estimateSize: () => 122,
    overscan: 5,
  });
  const refresh = useCallback(async () => {
    if (inRefresh.current) return;
    inRefresh.current = true;
    try {
      const [inbox, summary, status] = await Promise.all([
        api.emails(),
        api.dashboard(),
        api.gmailStatus(),
      ]);
      setRows(inbox.emails);
      setReport(summary);
      setGmail(status);
      setLoaded(true);
      setError("");
      if (status.configured) setOutbox((await api.gmailOutbox()).items);
      else setOutbox([]);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      inRefresh.current = false;
    }
  }, [api]);
  useEffect(() => {
    void refresh();
    const close = openEventStream(`${session.apiUrl}/events`, session.token, {
      onState: setStream,
      onUnauthorized: () => logout("Session rejected. Sign in again."),
      onEvent(event) {
        if (
          event.caseId === selectedRef.current &&
          ["case.imported", "case.classified", "case.decision"].includes(
            event.type,
          )
        )
          setRevision((value) => value + 1);
        if (event.type === "import.completed") {
          setBusy("");
          setNotice(
            "Inbox import completed. Open Measurements for its saved report.",
          );
        }
        if (event.type === "import.failed") {
          setBusy("");
          setError("Inbox import failed. Retry the import.");
        }
        if (!refreshTimer.current)
          refreshTimer.current = setTimeout(() => {
            refreshTimer.current = null;
            void refresh();
          }, 350);
      },
    });
    return () => {
      close();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [refresh, session]);
  useEffect(() => {
    if (loaded && !selected && rows.length) setSelected(rows[0].id);
  }, [loaded, selected, rows]);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommands((value) => !value);
        return;
      }
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        document.querySelector("dialog[open]") ||
        (event.target instanceof HTMLElement &&
          (event.target.isContentEditable ||
            /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)))
      )
        return;
      if (event.key === "/") {
        event.preventDefault();
        setPage("inbox");
        search.current?.focus();
      }
      if (event.key === "?") setCommands(true);
      if (
        page === "inbox" &&
        ["j", "k", "ArrowDown", "ArrowUp"].includes(event.key) &&
        visible.length
      ) {
        event.preventDefault();
        const current = visible.findIndex((row) => row.id === selected);
        const next = Math.max(
          0,
          Math.min(
            visible.length - 1,
            current + (["j", "ArrowDown"].includes(event.key) ? 1 : -1),
          ),
        );
        setSelected(visible[next].id);
        virtual.scrollToIndex(next);
        requestAnimationFrame(() =>
          document.getElementById(`row-${next}`)?.focus(),
        );
      }
    }
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [page, visible, selected, virtual]);
  async function action(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    setError("");
    try {
      await fn();
      setNotice(
        name === "import"
          ? "Import accepted. Classification results stream into the inbox."
          : "Action accepted. Watch delivery state for the result.",
      );
      await refresh();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy("");
    }
  }
  const stats = report?.counts ?? counts(rows);
  const choose = (value: string) => {
    setPage(value);
    setMobileNav(false);
  };
  return (
    <div
      className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
    >
      <a className="skip" href="#main">
        Skip to workspace
      </a>
      <aside
        id="primary-sidebar"
        className={`sidebar ${mobileNav ? "open" : ""}`}
        aria-label="Workspace navigation"
      >
        <div className="sidebar-head">
          <button
            className="sidebar-toggle"
            aria-controls="primary-sidebar"
            aria-expanded={!sidebarCollapsed}
            aria-label={
              sidebarCollapsed
                ? "Expand workspace navigation"
                : "Collapse workspace navigation"
            }
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setSidebarCollapsed((value) => !value)}
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen size={18} />
            ) : (
              <PanelLeftClose size={18} />
            )}
          </button>
        </div>
        <p className="workspace-label">Operations workspace</p>
        <nav aria-label="Main navigation" data-tour="nav">
          {[
            { id: "inbox", label: "Inbox", icon: Inbox },
            {
              id: "measurements",
              label: "Measurements",
              icon: ChartNoAxesCombined,
            },
            { id: "deliveries", label: "Delivery log", icon: Send },
          ].map((item) => (
            <button
              key={item.id}
              aria-current={page === item.id ? "page" : undefined}
              aria-label={
                item.id === "inbox"
                  ? `${item.label}, ${stats.total} items`
                  : item.label
              }
              title={sidebarCollapsed ? item.label : undefined}
              onClick={() => choose(item.id)}
            >
              <item.icon size={18} />
              <span className="sidebar-label">{item.label}</span>
              {item.id === "inbox" && (
                <span className="nav-count">{stats.total}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div
            className="connection"
            data-tour="stream"
            role="status"
            aria-label={STREAM_LABEL[stream]}
          >
            <span className={`dot ${stream === "live" ? "green" : ""}`} />
            <span className="sidebar-label">{STREAM_LABEL_SHORT[stream]}</span>
          </div>
          <p className="sidebar-label">
            {gmail?.configured
              ? (gmail.mailbox ?? "Gmail configured")
              : "Dataset workspace"}
          </p>
          <small className="sidebar-label">
            {gmail?.enabled
              ? "Unattended sending enabled"
              : "Unattended sending disabled"}
          </small>
          <button
            aria-label="Open keyboard shortcuts"
            data-tour="shortcuts"
            title={sidebarCollapsed ? "Keyboard shortcuts" : undefined}
            onClick={() => setCommands(true)}
          >
            <CircleHelp size={17} />
            <span className="sidebar-label">Keyboard shortcuts</span>
            <kbd className="sidebar-label">?</kbd>
          </button>
          {authRequired && (
            <button
              aria-label="Sign out"
              title={sidebarCollapsed ? "Sign out" : undefined}
              onClick={() => logout()}
            >
              <LogOut size={17} />
              <span className="sidebar-label">Sign out</span>
            </button>
          )}
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-start">
            <Button
              className="mobile-menu"
              variant="ghost"
              size="icon"
              aria-label="Toggle navigation"
              onClick={() => setMobileNav(!mobileNav)}
            >
              <PanelLeftClose size={20} />
            </Button>
            <a
              href="#main"
              className="brand topbar-brand"
              aria-label="CargoLens workspace"
            >
              <Mark />
              <span>CargoLens</span>
            </a>
            <div className="breadcrumb">
              <span>Operations</span>
              <span>/</span>
              <strong>
                {page === "inbox"
                  ? "Inbox"
                  : page === "measurements"
                    ? "Measurements"
                    : "Delivery log"}
              </strong>
            </div>
          </div>
          <div className="top-actions">
            <Button
              variant="outline"
              size="small"
              onClick={() => setCommands(true)}
            >
              <Search size={15} />
              <span>Quick commands</span>
              <kbd>Ctrl K</kbd>
            </Button>
            <span className="workspace-avatar" aria-label="Workspace operator">
              CL
            </span>
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <p className="overline">
                {page === "inbox"
                  ? "Correspondence to confidence"
                  : "Observable operations"}
              </p>
              <h1>
                {page === "inbox"
                  ? "Your operations, in focus."
                  : page === "measurements"
                    ? "Know what really happened."
                    : "Every reply, accounted for."}
              </h1>
              <p className="muted">
                {page === "inbox"
                  ? "A clear view of your documents, decisions and next steps."
                  : page === "measurements"
                    ? "Saved measurements. Explicit limits. No simulated benchmark claims."
                    : "Follow queued, delivered and unresolved messages in one place."}
              </p>
            </div>
            <DocumentArt />
          </div>
          <div
            className="summary-strip"
            aria-label="Inbox classification totals"
            data-tour="counts"
          >
            {[
              { value: stats.total, label: "Emails in workspace" },
              { value: stats.classified, label: "Classified" },
              { value: stats.pending, label: "Pending classification" },
              { value: stats.failed, label: "Classification errors" },
            ].map((metric) => (
              <div className="summary" key={metric.label}>
                <strong>{metric.value.toLocaleString()}</strong>
                <span>{metric.label}</span>
              </div>
            ))}
            <div className="summary-actions" data-tour="import">
              <Button
                variant="outline"
                disabled={!!busy}
                onClick={() => void action("refresh", refresh)}
                aria-label="Refresh workspace"
              >
                <RefreshCw size={16} />
              </Button>
              <Button
                disabled={!!busy}
                onClick={() => void action("import", api.importInbox)}
              >
                <Upload size={16} />
                {busy === "import" ? "Importing…" : "Import inbox"}
              </Button>
            </div>
          </div>
          {report?.mode === "synthetic" && (
            <div className="info-box">
              Synthetic QA workspace. Fixture classifications and timings are
              not live Jev benchmarks. No real messages are sent.
            </div>
          )}
          {error && (
            <div className="error-box" role="alert">
              {error}
              <Button
                variant="ghost"
                size="small"
                onClick={() => void refresh()}
              >
                Retry connection
              </Button>
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              {notice}
              <button
                aria-label="Dismiss notification"
                onClick={() => setNotice("")}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {page === "inbox" ? (
            <>
              <InboxMap
                rows={rows}
                loaded={loaded}
                category={category}
                workflow={workflow}
                status={mapStatus}
                onCategoryChange={(value) => {
                  setCategory(value);
                  setWorkflow("");
                  setMapStatus("");
                }}
                onWorkflowChange={(value) => {
                  setWorkflow(value);
                  setCategory("");
                  setMapStatus("");
                }}
                onStatusChange={(value) => {
                  setMapStatus(value);
                  setCategory("");
                  setWorkflow("");
                }}
                onMessageSelect={(id) => {
                  setSelected(id);
                  requestAnimationFrame(() => {
                    const index = visible.findIndex((row) => row.id === id);
                    if (index >= 0) virtual.scrollToIndex(index);
                    list.current?.scrollIntoView({
                      behavior: "smooth",
                      block: "start",
                    });
                  });
                }}
                onClearFilters={() => {
                  setCategory("");
                  setWorkflow("");
                  setMapStatus("");
                }}
              />
              <div className="inbox-tools" data-tour="filters">
                <label className="search-label">
                  <Search size={17} />
                  <span className="sr-only">Search correspondence</span>
                  <input
                    ref={search}
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search subject, sender or reference…"
                  />
                  <kbd>/</kbd>
                </label>
                <label>
                  <span className="sr-only">Filter category</span>
                  <select
                    value={category}
                    onChange={(e) => {
                      setCategory(e.target.value);
                      setMapStatus("");
                    }}
                  >
                    <option value="">All categories</option>
                    {Object.entries(CATEGORY_LABEL).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="sr-only">Filter verification</span>
                  <select
                    value={workflow}
                    onChange={(e) => {
                      setWorkflow(e.target.value);
                      setMapStatus("");
                    }}
                  >
                    <option value="">All verification states</option>
                    {Object.entries(WORKFLOW_LABEL).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="small muted">{visible.length} visible</span>
              </div>
              <div className="inbox-workspace">
                <section className="inbox-panel" aria-label="Email list" data-tour="list">
                  <div className="panel-label">
                    <strong>Correspondence</strong>
                    <span className="small muted">J / K to navigate</span>
                  </div>
                  <div
                    ref={list}
                    className="virtual-list"
                    role="list"
                    aria-label="Correspondence results"
                  >
                    {!loaded ? (
                      <div className="empty">Loading your workspace…</div>
                    ) : !visible.length ? (
                      <div className="empty">
                        <Inbox size={28} />
                        <h3>
                          {rows.length
                            ? "No matching correspondence"
                            : "Start with your inbox"}
                        </h3>
                        <p>
                          {rows.length
                            ? "Try a different search or filter."
                            : "Import the configured dataset or sync your connected Gmail mailbox."}
                        </p>
                        {rows.length > 0 && (
                          <Button
                            variant="outline"
                            onClick={() => {
                              setQuery("");
                              setCategory("");
                              setWorkflow("");
                              setMapStatus("");
                            }}
                          >
                            Clear filters
                          </Button>
                        )}
                      </div>
                    ) : (
                      <div
                        style={{
                          height: virtual.getTotalSize(),
                          position: "relative",
                        }}
                      >
                        {virtual.getVirtualItems().map((item) => {
                          const row = visible[item.index];
                          return (
                            <div
                              role="listitem"
                              key={row.id}
                              style={{
                                position: "absolute",
                                top: 0,
                                left: 0,
                                width: "100%",
                                transform: `translateY(${item.start}px)`,
                              }}
                            >
                              <button
                                id={`row-${item.index}`}
                                className={`email-row ${selected === row.id ? "selected" : ""}`}
                                aria-pressed={selected === row.id}
                                onClick={() => setSelected(row.id)}
                              >
                                <span className="email-meta">
                                  <span className="sender-avatar">
                                    {row.from
                                      .replace(/[^a-z]/gi, "")
                                      .slice(0, 2)
                                      .toUpperCase() || "EM"}
                                  </span>
                                  <span className="sender">{row.from}</span>
                                  <span className="small muted">
                                    {row.classification?.cached
                                      ? "Cached"
                                      : row.classification
                                        ? duration(row.classification.elapsedMs)
                                        : row.status}
                                  </span>
                                </span>
                                <strong className="email-subject">
                                  {row.subject || "(No subject)"}
                                </strong>
                                <span className="email-badges">
                                  <span className="category-pill">
                                    {row.classification
                                      ? CATEGORY_LABEL[
                                          row.classification.category
                                        ]
                                      : "Pending"}
                                  </span>
                                  <span
                                    className={`status-pill ${row.workflowState.toLowerCase()}`}
                                  >
                                    {row.status === "failed"
                                      ? "Classification failed"
                                      : WORKFLOW_LABEL[row.workflowState]}
                                  </span>
                                </span>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </section>
                <section className="case-panel" aria-label="Selected case" data-tour="case">
                  {selected ? (
                    <CaseView
                      key={selected}
                      api={api}
                      id={selected}
                      revision={revision}
                      delivery={outbox.filter(
                        (item) => item.caseId === selected,
                      )}
                      sendingEnabled={!!gmail?.enabled}
                      refresh={refresh}
                    />
                  ) : (
                    <div className="empty case-empty">
                      <DocumentArt />
                      <h2>Select a conversation</h2>
                      <p>
                        Evidence, decisions and operational replies appear here.
                      </p>
                    </div>
                  )}
                </section>
              </div>
            </>
          ) : page === "measurements" ? (
            <Measurements report={report} api={api} />
          ) : (
            <DeliveryLog
              items={outbox}
              gmail={gmail}
              busy={!!busy}
              sync={() => void action("sync", api.gmailSync)}
              dispatch={() => void action("dispatch", api.gmailDispatch)}
            />
          )}
          <footer className="workspace-footer">
            <span>
              <ShieldCheck size={14} /> Source-backed operational state
            </span>
            <span>
              Saved results ·{" "}
              {report
                ? `Updated ${new Date(report.generatedAt).toLocaleTimeString()}`
                : "Connecting to API"}
            </span>
          </footer>
        </main>
      </div>
      {tour && <Tour close={() => setTour(false)} />}
      {commands && (
        <Modal title="Go to the next thing" close={() => setCommands(false)}>
          <p className="muted">
            Shortcuts pause while you type. J / K navigate emails; / focuses
            search.
          </p>
          <div className="command-list">
            {[
              {
                label: "Search correspondence",
                run: () => {
                  setPage("inbox");
                  requestAnimationFrame(() => search.current?.focus());
                },
                key: "/",
              },
              {
                label: "Open measurements",
                run: () => setPage("measurements"),
                key: "",
              },
              {
                label: "Open delivery log",
                run: () => setPage("deliveries"),
                key: "",
              },
              {
                label: "Replay the walkthrough",
                run: () => {
                  setPage("inbox");
                  setTour(true);
                },
                key: "",
              },
            ].map((item) => (
              <button
                key={item.label}
                onClick={() => {
                  setCommands(false);
                  item.run();
                }}
              >
                <Command size={16} />
                {item.label}
                <kbd>{item.key || "↵"}</kbd>
                <ArrowUpRight size={16} />
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
