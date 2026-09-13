"use client";

import { useEffect, useRef, useState } from "react";
import { useRaftCluster, ClusterSnapshot } from "@/lib/useRaftCluster";
import ClusterVisualization from "@/components/ClusterVisualization";
import TermSparkline from "@/components/TermSparkline";
import HealthMeter from "@/components/HealthMeter";

const COLORS = {
  bg: "#0A0E16",
  leader: "#E8A33D",
  follower: "#4FD1E8",
  dead: "#E85D6B",
  text: "#8B93A7",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HISTORY_CAP = 200;

export default function Home() {
  const { ready, loadError, snapshot, events, killNode, reviveNode, partition, healPartition, submitWrite } = useRaftCluster();

  const [toast, setToast] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [scenarioCaption, setScenarioCaption] = useState<string | null>(null);
  const [presentMode, setPresentMode] = useState(false);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);

  const prevCommitted = useRef(0);
  const termHistory = useRef<number[]>([]);
  const snapshotHistory = useRef<ClusterSnapshot[]>([]);
  const lastEventCount = useRef(0);

  useEffect(() => {
    if (!snapshot) return;
    const leader = snapshot.nodes.find((n) => n.State === "Leader" && n.Alive);
    if (leader) {
      const last = termHistory.current[termHistory.current.length - 1];
      if (last !== leader.CurrentTerm) {
        termHistory.current = [...termHistory.current.slice(-49), leader.CurrentTerm];
      }
    }
  }, [snapshot?.stats.ElectionsHeld]);

  // Record a snapshot into history every time a new event arrives, so the
  // scrubber can reconstruct "what the cluster looked like at that point."
  // This is a simple in-memory ring buffer, not a real event-sourced
  // replay — good enough for a bounded recent-history scrubber.
  useEffect(() => {
    if (!snapshot) return;
    if (events.length !== lastEventCount.current) {
      lastEventCount.current = events.length;
      snapshotHistory.current = [...snapshotHistory.current.slice(-(HISTORY_CAP - 1)), snapshot];
    }
  }, [events.length, snapshot]);

  useEffect(() => {
    if (!snapshot) return;
    if (snapshot.stats.WritesCommitted > prevCommitted.current) {
      const lastCommit = [...events].reverse().find((e) => e.Type === "committed");
      setToast(`Committed at index ${lastCommit?.Index ?? "?"}`);
      const t = setTimeout(() => setToast(null), 2200);
      prevCommitted.current = snapshot.stats.WritesCommitted;
      return () => clearTimeout(t);
    }
    prevCommitted.current = snapshot.stats.WritesCommitted;
  }, [snapshot?.stats.WritesCommitted, events]);

  if (loadError) {
    return <div style={{ padding: 24, color: COLORS.dead, fontFamily: "IBM Plex Mono, monospace" }}>Failed to load WASM: {loadError}</div>;
  }
  if (!ready || !snapshot) {
    return <div style={{ padding: 24, color: COLORS.text, fontFamily: "IBM Plex Mono, monospace" }}>Booting cluster…</div>;
  }

  const isScrubbing = scrubIndex !== null && snapshotHistory.current.length > 0;
  const viewSnapshot = isScrubbing
    ? snapshotHistory.current[Math.min(scrubIndex!, snapshotHistory.current.length - 1)]
    : snapshot;

  const aliveLeaders = viewSnapshot.nodes.filter((n) => n.State === "Leader" && n.Alive);
  const splitBrain = aliveLeaders.length > 1;
  const leader = aliveLeaders.reduce<typeof aliveLeaders[number] | null>(
    (best, n) => (!best || n.CurrentTerm > best.CurrentTerm ? n : best),
    null
  );

  const aliveIds = viewSnapshot.nodes.filter((n) => n.Alive).map((n) => n.ID);
  const aliveCount = aliveIds.length;
  const hasQuorum = aliveCount * 2 > viewSnapshot.nodes.length;
  const uptimeSec = Math.floor((Date.now() - new Date(viewSnapshot.stats.StartedAt).getTime()) / 1000);

  const statusText = leader
    ? `Healthy — ${leader.ID} leading, term ${leader.CurrentTerm}`
    : !hasQuorum
    ? `No quorum — only ${aliveCount} of ${viewSnapshot.nodes.length} nodes alive, can't elect a leader`
    : "Electing a new leader…";
  const statusColor = leader ? COLORS.follower : !hasQuorum ? COLORS.dead : COLORS.leader;

  const runScenario = async () => {
    const currentLeader = snapshot.nodes.find((n) => n.State === "Leader" && n.Alive);
    if (!currentLeader) return;
    setScenarioCaption(`Killing leader ${currentLeader.ID}…`);
    killNode(currentLeader.ID);
    await sleep(2500);
    setScenarioCaption("Cluster is electing a new leader…");
    await sleep(2500);
    setScenarioCaption("Recovered — cluster is healthy again");
    await sleep(2000);
    setScenarioCaption(null);
  };

  const exportHistory = () => {
    const blob = new Blob([JSON.stringify(events, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `raftline-events-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const allKeys = Array.from(new Set(viewSnapshot.nodes.flatMap((n) => Object.keys(n.StateMachine || {})))).sort();

  return (
    <div className="page">
      <div className="wrap">
        <div className="header-row">
          <div>
            <h1 className="title">Raftline</h1>
            <p className="subtitle">A live Raft consensus cluster, running in your browser via WASM.</p>
          </div>
          <button className="btn btn-ghost" onClick={() => setPresentMode((p) => !p)}>
            {presentMode ? "Exit presentation mode" : "Presentation mode"}
          </button>
        </div>

        {!presentMode && (
          <div className="health-row">
            <HealthMeter aliveCount={aliveCount} total={viewSnapshot.nodes.length} hasQuorum={hasQuorum} avgLatencyMs={viewSnapshot.stats.AvgLatencyMs} />
          </div>
        )}

        {splitBrain && leader && (
          <div className="split-brain-banner">
            ⚠ Split leadership detected — {aliveLeaders.map((l) => `${l.ID} (term ${l.CurrentTerm})`).join(" vs ")}.
            Cluster is correctly routing writes to {leader.ID} (highest term); the other{aliveLeaders.length > 2 ? "s are" : " is"} stale and powerless.
          </div>
        )}

        <div className="grid">
          <ClusterVisualization nodes={viewSnapshot.nodes} events={events} onKillNode={killNode} onReviveNode={reviveNode} />

          {!presentMode && (
            <div className="panel side-panel">
              <div className="panel-label">Cluster state (click a row for its log)</div>
              {viewSnapshot.nodes.map((n) => (
                <div key={n.ID}>
                  <div
                    className="row"
                    style={{ color: n.Alive ? "white" : COLORS.dead, cursor: "pointer" }}
                    onClick={() => setExpanded(expanded === n.ID ? null : n.ID)}
                  >
                    <span className="cell">{n.ID}</span>
                    <span className="cell">{n.State}</span>
                    <span className="cell">term {n.CurrentTerm}</span>
                    <span className="cell">log {n.LogLength}</span>
                  </div>
                  {expanded === n.ID && (
                    <div className="log-entries">
                      {n.Log.length === 0 && <div className="log-empty">no entries yet</div>}
                      {n.Log.map((e) => (
                        <div key={e.Index} className="log-entry">
                          #{e.Index} · term {e.Term} · {e.Command}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}

              <div className="panel-label" style={{ marginTop: 20 }}>Applied state (per node)</div>
              {allKeys.length === 0 && <div className="log-empty">no writes applied yet</div>}
              {allKeys.length > 0 && (
                <div className="kv-table">
                  <div className="kv-row kv-header">
                    <span>key</span>
                    {viewSnapshot.nodes.map((n) => <span key={n.ID}>{n.ID}</span>)}
                  </div>
                  {allKeys.map((k) => (
                    <div className="kv-row" key={k}>
                      <span>{k}</span>
                      {viewSnapshot.nodes.map((n) => (
                        <span key={n.ID} style={{ color: n.Alive ? "white" : COLORS.text }}>
                          {n.StateMachine?.[k] ?? "—"}
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              )}

              <div className="panel-label" style={{ marginTop: 20 }}>Term over time</div>
              <TermSparkline history={termHistory.current} color={COLORS.leader} />

              <div className="panel-label" style={{ marginTop: 20 }}>Recent events</div>
              <div className="events">
                {events.slice(-10).reverse().map((e, i) => (
                  <div key={i} className="event-row">
                    {e.Type} · {e.NodeID} · term {e.Term}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="status-banner" style={{ borderColor: `${statusColor}55`, color: statusColor }}>
          <span className="status-dot" style={{ background: statusColor }} />
          {statusText}
          {isScrubbing && <span className="scrub-tag">— viewing history (not live)</span>}
        </div>

        {!presentMode && (
          <div className="scrubber-row">
            <span className="size-label">Time travel:</span>
            <input
              type="range"
              min={0}
              max={Math.max(0, snapshotHistory.current.length - 1)}
              value={scrubIndex ?? snapshotHistory.current.length - 1}
              onChange={(e) => setScrubIndex(Number(e.target.value))}
              className="scrub-slider"
            />
            <button className="btn btn-small" onClick={() => setScrubIndex(null)} disabled={!isScrubbing}>
              Back to live
            </button>
          </div>
        )}

        <div className="actions">
          <button disabled={!leader || isScrubbing} onClick={() => leader && killNode(leader.ID)} className="btn btn-danger">
            Kill the leader
          </button>
          <button disabled={!leader || isScrubbing} onClick={() => submitWrite(`SET x=${Date.now() % 1000}`)} className="btn">
            Submit write
          </button>
          <button
            disabled={isScrubbing}
            onClick={() => {
              const half = Math.ceil(aliveIds.length / 2);
              partition(aliveIds.slice(0, half), aliveIds.slice(half));
            }}
            className="btn"
          >
            Partition network
          </button>
          <button disabled={isScrubbing} onClick={() => healPartition()} className="btn">
            Heal partition
          </button>
          <button disabled={!leader || !!scenarioCaption || isScrubbing} onClick={runScenario} className="btn btn-accent">
            Run chaos demo
          </button>
          {!presentMode && (
            <button onClick={exportHistory} className="btn btn-ghost">
              Export event history
            </button>
          )}
        </div>

        {scenarioCaption && <div className="scenario-caption">{scenarioCaption}</div>}
      </div>

      <div className="ticker">
        <span>Uptime <b style={{ color: "white" }}>{uptimeSec}s</b></span>
        <span>Elections <b style={{ color: COLORS.leader }}>{viewSnapshot.stats.ElectionsHeld}</b></span>
        <span>Writes committed <b style={{ color: COLORS.follower }}>{viewSnapshot.stats.WritesCommitted}</b></span>
        <span>Avg RPC latency <b style={{ color: COLORS.follower }}>{viewSnapshot.stats.AvgLatencyMs.toFixed(0)}ms</b></span>
      </div>

      {toast && <div className="toast">{toast}</div>}

      <style jsx global>{`
        body { background: ${COLORS.bg}; }
      `}</style>
      <style jsx>{`
        .page {
          min-height: 100vh;
          background:
            linear-gradient(rgba(139,147,167,0.04) 1px, transparent 1px),
            linear-gradient(90deg, rgba(139,147,167,0.04) 1px, transparent 1px),
            ${COLORS.bg};
          background-size: 32px 32px, 32px 32px, auto;
          color: white;
          font-family: "Space Grotesk", sans-serif;
        }
        .wrap { max-width: 1100px; margin: 0 auto; padding: 48px 24px 32px; }
        .header-row { display: flex; justify-content: space-between; align-items: flex-start; }
        .title { font-size: 34px; margin-bottom: 6px; letter-spacing: -0.02em; }
        .subtitle { color: ${COLORS.text}; margin-bottom: 20px; font-size: 15px; }
        .health-row { margin-bottom: 16px; }
        .split-brain-banner {
          background: rgba(232, 93, 107, 0.1); border: 1px solid ${COLORS.dead}55; color: ${COLORS.dead};
          padding: 10px 16px; border-radius: 8px; font-family: "IBM Plex Mono", monospace; font-size: 12px;
          margin-bottom: 20px;
        }
        .grid { display: flex; gap: 32px; flex-wrap: wrap; }
        .panel {
          flex: 1; min-width: 280px;
          background: rgba(255,255,255,0.02);
          border: 1px solid rgba(139,147,167,0.15);
          border-radius: 16px; padding: 20px;
          font-family: "IBM Plex Mono", monospace; font-size: 13px;
        }
        .panel-label { color: ${COLORS.text}; margin-bottom: 10px; font-size: 12px; }
        .row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid rgba(139,147,167,0.08); }
        .cell { flex: 1; }
        .log-entries { padding: 6px 0 6px 12px; border-bottom: 1px solid rgba(139,147,167,0.08); }
        .log-entry { color: ${COLORS.follower}; font-size: 11px; padding: 2px 0; }
        .log-empty { color: ${COLORS.text}; font-size: 11px; padding: 2px 0; }
        .kv-table { font-size: 11px; }
        .kv-row { display: flex; gap: 12px; padding: 3px 0; border-bottom: 1px solid rgba(139,147,167,0.06); }
        .kv-row span { flex: 1; }
        .kv-header { color: ${COLORS.text}; font-weight: 700; }
        .events { max-height: 170px; overflow-y: auto; }
        .event-row { color: ${COLORS.text}; font-size: 11px; padding: 3px 0; }
        .status-banner {
          margin-top: 28px; padding: 10px 16px; border: 1px solid; border-radius: 8px;
          font-family: "IBM Plex Mono", monospace; font-size: 13px;
          display: inline-flex; align-items: center; gap: 8px;
        }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; }
        .scrub-tag { color: ${COLORS.leader}; margin-left: 6px; }
        .scrubber-row { display: flex; align-items: center; gap: 10px; margin-top: 16px; }
        .scrub-slider { flex: 1; max-width: 400px; }
        .actions { display: flex; gap: 12px; margin-top: 16px; flex-wrap: wrap; }
        .btn {
          background: transparent; border: 1px solid ${COLORS.text}55; color: white;
          padding: 10px 18px; border-radius: 8px; cursor: pointer;
          font-family: "Space Grotesk", sans-serif; font-weight: 600;
          transition: border-color 0.15s ease, transform 0.1s ease;
        }
        .btn-small { padding: 6px 12px; font-size: 12px; }
        .btn-ghost { border-color: transparent; color: ${COLORS.text}; }
        .btn:hover:not(:disabled) { border-color: ${COLORS.follower}; transform: translateY(-1px); }
        .btn:disabled { opacity: 0.35; cursor: not-allowed; }
        .btn-danger { background: ${COLORS.dead}; border-color: ${COLORS.dead}; }
        .btn-accent { background: ${COLORS.leader}; border-color: ${COLORS.leader}; color: ${COLORS.bg}; }
        .scenario-caption {
          margin-top: 12px; color: ${COLORS.leader}; font-family: "IBM Plex Mono", monospace; font-size: 13px;
        }
        .toast {
          position: fixed; bottom: 90px; left: 50%; transform: translateX(-50%);
          background: ${COLORS.follower}; color: ${COLORS.bg};
          padding: 10px 20px; border-radius: 8px; font-weight: 600;
          font-family: "IBM Plex Mono", monospace; font-size: 13px;
          animation: fadein 0.2s ease;
        }
        @keyframes fadein { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
        .ticker {
          border-top: 1px solid rgba(139,147,167,0.15); padding: 18px 24px;
          display: flex; justify-content: center; gap: 40px; flex-wrap: wrap;
          font-family: "IBM Plex Mono", monospace; font-size: 13px; color: ${COLORS.text};
        }
      `}</style>
    </div>
  );
}