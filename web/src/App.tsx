import { useEffect, useState } from "react";
import { useNotifications } from "@/hooks/useNotifications";
import { useStuckDetection } from "@/hooks/useStuckDetection";
import { useTitleAlert } from "@/hooks/useTitleAlert";
import { useDashboardState } from "@/hooks/useDashboardState";
import { useNow } from "@/hooks/useNow";
import { useRoute } from "@/hooks/useRoute";
import { useViewMode } from "@/hooks/useViewMode";
import { AlertTriangle, LayoutGrid } from "lucide-react";
import { FleetView } from "@/components/FleetView";
import { ShareButtons } from "@/components/ShareButtons";
import { NotificationsToggle } from "@/components/NotificationsToggle";
import { OperatorView } from "@/components/OperatorView";
import { OwnerView } from "@/components/owner/OwnerView";
import { PastSessionsModal } from "@/components/PastSessions";
import { PendingQuestionPanel } from "@/components/PendingQuestionPanel";
import { PermissionModal } from "@/components/PermissionModal";
import { SessionMeta } from "@/components/SessionMeta";
import { SessionSwitcher } from "@/components/SessionSwitcher";
import { ViewToggle } from "@/components/ViewToggle";
import { displayName, greeting } from "@/lib/format";

// Which server is this bundle being served by? The hub answers GET /fleet
// with { hub: true }; a session server 404s it. A /s/<key> path is proof of
// hub on its own (only the hub serves that route). "locked" means the hub
// answered 401: this device fetched the shell but holds no valid pairing
// token, so show the pairing screen instead of a dashboard of failed fetches.
type Origin = "probe" | "hub" | "session" | "locked";

async function probeHub(): Promise<Exclude<Origin, "probe">> {
  try {
    const res = await fetch("/fleet", { signal: AbortSignal.timeout(1500) });
    if (res.status === 401) return "locked";
    if (!res.ok) return "session";
    const body = (await res.json()) as { hub?: boolean };
    return body.hub === true ? "hub" : "session";
  } catch {
    return "session";
  }
}

function PairingRequired(): React.JSX.Element {
  return (
    <div className="mx-auto flex min-h-[80vh] max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <span
        aria-hidden
        className="inline-block h-10 w-10 rounded-xl bg-gradient-to-br from-blue-500 via-indigo-500 to-violet-500 shadow-sm"
      />
      <h1 className="text-xl font-semibold text-zinc-50">Pair this device</h1>
      <p className="text-sm text-zinc-400">
        Murmur is reachable, but this device holds no pairing token. On the Mac
        that runs your sessions, open the fleet view and choose{" "}
        <span className="text-zinc-200">Pair phone</span>, then scan the QR code
        from here.
      </p>
      <button
        type="button"
        onClick={() => location.reload()}
        className="period-pill mt-2"
      >
        Retry
      </button>
    </div>
  );
}

export function App(): React.JSX.Element | null {
  const { path, navigate } = useRoute();
  const drill = path.match(/^\/s\/([A-Za-z0-9_-]+)/);
  const [origin, setOrigin] = useState<Origin>(drill ? "hub" : "probe");

  useEffect(() => {
    let cancelled = false;
    void probeHub().then((probed) => {
      if (cancelled) return;
      setOrigin((prev) => {
        if (probed === "locked") return "locked";
        return prev === "probe" ? probed : prev;
      });
    });
    return () => {
      cancelled = true;
    };
    // One probe per load: it classifies the server, which doesn't change
    // across client-side navigations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (origin === "locked") {
    return <PairingRequired />;
  }
  if (drill) {
    return (
      <SessionDashboard
        key={drill[1]}
        basePath={`/s/${drill[1]}`}
        onFleetHome={() => navigate("/")}
        onSwitchSession={(key) => navigate(`/s/${key}`)}
      />
    );
  }
  if (origin === "hub") {
    return <FleetView onOpenSession={(key) => navigate(`/s/${key}`)} />;
  }
  if (origin === "session") {
    return <SessionDashboard basePath="" />;
  }
  return null; // origin probe in flight (local, resolves in milliseconds)
}

function SessionDashboard({
  basePath,
  onFleetHome,
  onSwitchSession,
}: {
  basePath: string;
  onFleetHome?: () => void;
  onSwitchSession?: (key: string) => void;
}): React.JSX.Element {
  const {
    state,
    isStale,
    isWarning,
    lastWarning,
    sessions,
    submitAnswer,
    cancelQuestion,
    submitPermission,
  } = useDashboardState(basePath);
  const now = useNow(5000);
  const [pastOpen, setPastOpen] = useState(false);
  const { view, setView } = useViewMode();

  const stuckWarnings = useStuckDetection(state?.rows ?? [], state?.activities ?? [], now);
  const notifications = useNotifications({
    pendingQuestion: state?.pendingQuestion ?? null,
    pendingPermission: state?.pendingPermission ?? null,
    lastWarning,
    stuckWarnings,
    nativeAlerts: state?.nativeAlerts ?? false,
    nativeSupported: state?.nativeSupported ?? false,
  });
  useTitleAlert(
    state?.pendingQuestion ?? null,
    state?.pendingPermission ?? null
  );

  const userName = state?.sessionInfo?.userName ?? "there";
  const greet = `${greeting()}, ${displayName(userName)}`;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 space-y-8 sm:px-6 sm:py-10">
      {/* Greeting */}
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-baseline gap-3 min-w-0">
            <span
              aria-hidden
              className="inline-block h-7 w-7 rounded-md bg-gradient-to-br from-blue-500 via-indigo-500 to-violet-500 shadow-sm shrink-0"
            />
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-50 truncate sm:text-3xl">
              Murmur
              <span className="ml-3 hidden align-middle text-base font-normal text-zinc-400 sm:inline">
                {greet}
              </span>
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {onFleetHome && (
              <button
                type="button"
                onClick={onFleetHome}
                className="period-pill inline-flex items-center gap-1.5"
                title="Back to the fleet"
              >
                <LayoutGrid className="h-4 w-4 text-zinc-400" />
                <span className="hidden sm:inline">Fleet</span>
              </button>
            )}
            <ViewToggle view={view} onChange={setView} />
            <NotificationsToggle {...notifications} />
            <ShareButtons ctx={{ state, sessions }} />
            <SessionSwitcher
              sessions={sessions}
              agentSessions={state?.agentSessions ?? []}
              onBrowsePast={() => setPastOpen(true)}
              onSwitch={onSwitchSession ? (s) => onSwitchSession(s.key) : undefined}
            />
          </div>
        </div>
        {state && (
          <SessionMeta
            sessionInfo={state.sessionInfo}
            startedAt={state.startedAt}
            isStale={isStale}
            isWarning={isWarning}
          />
        )}
      </header>

      {/* Pending question pinned high. Gated by the "In this tab" channel: the
          in-page overlay IS the in-tab surface, so turning that channel off
          hides it and you rely on the channels you enabled (e.g. native). */}
      {state?.pendingQuestion && notifications.channels.browser && (
        <PendingQuestionPanel
          question={state.pendingQuestion}
          onSubmit={submitAnswer}
          onCancel={cancelQuestion}
        />
      )}

      {view === "owner" ? (
        <OwnerView
          state={state}
          isStale={isStale}
          stuckWarnings={stuckWarnings}
          now={now}
          submitAnswer={submitAnswer}
          cancelQuestion={cancelQuestion}
          submitPermission={submitPermission}
        />
      ) : (
        <OperatorView
          state={state}
          stuckWarnings={stuckWarnings}
          now={now}
          submitAnswer={submitAnswer}
          cancelQuestion={cancelQuestion}
          submitPermission={submitPermission}
        />
      )}

      <PastSessionsModal open={pastOpen} onClose={() => setPastOpen(false)} />
      {/* The in-page permission overlay is the "In this tab" surface too —
          gated by that channel so it doesn't blanket the screen on top of
          native/push when the user has the in-tab channel off. */}
      <PermissionModal
        permission={
          notifications.channels.browser ? (state?.pendingPermission ?? null) : null
        }
        session={state?.sessionInfo?.cwdBasename}
        onDecide={submitPermission}
      />

      {/* mirror warning toast */}
      {isWarning && lastWarning && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          <AlertTriangle className="mr-2 inline h-4 w-4" />
          {lastWarning}
        </div>
      )}
    </div>
  );
}
