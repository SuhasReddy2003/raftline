"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRaftCluster } from "@/lib/useRaftCluster";
import ClusterVisualization from "@/components/ClusterVisualization";
import TermSparkline from "@/components/TermSparkline";

const COLORS = {
  bg: "#0A0E16",
  leader: "#E8A33D",
  follower: "#4FD1E8",
  dead: "#E85D6B",
  text: "#8B93A7",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ALL_IDS = ["n1", "n2", "n3", "n4", "n5", "n6", "n7"];

export default function Home() {
  const {
    ready, loadError, snapshot, events,
    killNode, reviveNode, partition, healPartition, submitWrite, resizeCluster,
  } = useRaftCluster();

  const [toast, setToast] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [scenarioCaption, setScenarioCaption] = useState<string | null>(null);
  const [presentMode, setPresentMode] = useState(false);
  const [clusterSize, setClusterSize] = useState(5);
  const [diffPair, setDiffPair] = useState<[string, string] | null>(null);
  const prevCommitted = useRef(0);
  const termHistory = useRef<number[]>([]);

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

  const leader = snapshot.nodes.find((n) => n.State === "Leader" && n.Alive);
  const aliveIds = snapshot.nodes.filter((n) => n.Alive).map((n) => n.ID);
  const aliveCount = aliveIds.length;
  const uptimeSec = Math.floor((Date.now() - new Date(snapshot.stats.StartedAt).getTime()) / 1000);

  const statusText = leader
    ? `Healthy — ${leader.ID} leading, term ${leader.CurrentTerm}`
    : aliveCount * 2 <= snapshot.nodes.length
    ? `No quorum — only ${aliveCount} of ${snapshot.nodes.length} nodes alive, can't elect a leader`
    : "Electing a new leader…";
  const statusColor = leader ? COLORS.follower : aliveCount * 2 <= snapshot.nodes.length ? COLORS.dead : COLORS.leader;

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

  const changeClusterSize = (n: number) => {
    setClusterSize(n);
    termHistory.current = [];
    resizeCluster(ALL_IDS.slice(0, n));
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

  const diffNodes = diffPair
    ? [snapshot.nodes.find((n) => n.ID === diffPair[0]), snapshot.nodes.find((n) => n.ID === diffPair[1])]
    : null;

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

        <div className="grid">
          <ClusterVisualization nodes={snapshot.nodes} events={events} onKillNode={killNode} onReviveNode={reviveNode} />

          {!presentMode && (
            <div className="panel side-panel">
              <div className="panel-label">Cluster state (click a row for its log, ctrl+click to diff two)</div>
              {snapshot.nodes.map((n) => (
                <div key={n.ID}>
                  <div
                    className="row"
                    style={{ color: n.Alive ? "white" : COLORS.dead, cursor: "pointer" }}
                    onClick={(e) => {
                      if (e.ctrlKey || e.metaKey) {
                        setDiffPair((prev) => {
                          if (!prev) return [n.ID, n.ID];
                          if (prev[0] === n.ID) return prev;
                          return [prev[0], n.ID];
                        });
                        return;
                      }
                      setExpanded(expanded === n.ID ? null : n.ID);
                    }}
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

        {diffNodes && diffNodes[0] && diffNodes[1] && (
          <div className="panel diff-panel">
            <div className="panel-label">Log comparison — {diffPair![0]} vs {diffPair![1]} <span className="diff-close" onClick={() => setDiffPair(null)}>✕</span></div>
            <div className="diff-grid">
              {[diffNodes[0], diffNodes[1]].map((n) => (
                <div key={n!.ID}>
                  <div className="diff-header">{n!.ID}</div>
                  {n!.Log.length === 0 && <div className="log-empty">empty</div>}
                  {n!.Log.map((e) => {
                    const other = (n === diffNodes[0] ? diffNodes[1] : diffNodes[0])!;
                    const otherEntry = other.Log[e.Index - 1];
                    const matches = otherEntry && otherEntry.Term === e.Term && otherEntry.Command === e.Command;
                    return (
                      <div key={e.Index} className="log-entry" style={{ color: matches ? COLORS.follower : COLORS.dead }}>
                        #{e.Index} · term {e.Term} · {e.Command} {matches ? "✓" : "⚠ diverges"}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="status-banner" style={{ borderColor: `${statusColor}55`, color: statusColor }}>
          <span className="status-dot" style={{ background: statusColor }} />
          {statusText}
        </div>

        <div className="actions">
          <button disabled={!leader} onClick={() => leader && killNode(leader.ID)} className="btn btn-danger">
            Kill the leader
          </button>
          <button disabled={!leader} onClick={() => submitWrite(`SET x=${Date.now() % 1000}`)} className="btn">
            Submit write
          </button>
          <button
            onClick={() => {
              const half = Math.ceil(aliveIds.length / 2);
              partition(aliveIds.slice(0, half), aliveIds.slice(half));
            }}
            className="btn"
          >
            Partition network
          </button>
          <button onClick={() => healPartition()} className="btn">
            Heal partition
          </button>
          <button disabled={!leader || !!scenarioCaption} onClick={runScenario} className="btn btn-accent">
            Run chaos demo
          </button>
          {!presentMode && (
            <button onClick={exportHistory} className="btn btn-ghost">
              Export event history
            </button>
          )}
        </div>

        {!presentMode && (
          <div className="size-control">
            <span className="size-label">Cluster size:</span>
            {[3, 5, 7].map((n) => (
              <button key={n} className={`btn btn-small ${clusterSize === n ? "btn-active" : ""}`} onClick={() => changeClusterSize(n)}>
                {n} nodes
              </button>
            ))}
          </div>
        )}

        {scenarioCaption && <div className="scenario-caption">{scenarioCaption}</div>}
      </div>

      <div className="ticker">
        <span>Uptime <b style={{ color: "white" }}>{uptimeSec}s</b></span>
        <span>Elections <b style={{ color: COLORS.leader }}>{snapshot.stats.ElectionsHeld}</b></span>
        <span>Writes committed <b style={{ color: COLORS.follower }}>{snapshot.stats.WritesCommitted}</b></span>
        <span>Avg RPC latency <b style={{ color: COLORS.follower }}>{snapshot.stats.AvgLatencyMs.toFixed(0)}ms</b></span>
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
        .subtitle { color: ${COLORS.text}; margin-bottom: 36px; font-size: 15px; }
        .grid { display: flex; gap: 32px; flex-wrap: wrap; }
        .panel {
          flex: 1; min-width: 280px;
          background: rgba(255,255,255,0.02);
          border: 1px solid rgba(139,147,167,0.15);
          border-radius: 16px; padding: 20px;
          font-family: "IBM Plex Mono", monospace; font-size: 13px;
        }
        .diff-panel { width: 100%; margin-top: 24px; flex: none; }
        .diff-grid { display: flex; gap: 32px; margin-top: 10px; }
        .diff-grid > div { flex: 1; }
        .diff-header { color: white; font-weight: 700; margin-bottom: 6px; }
        .diff-close { float: right; cursor: pointer; color: ${COLORS.text}; }
        .panel-label { color: ${COLORS.text}; margin-bottom: 10px; font-size: 12px; }
        .row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid rgba(139,147,167,0.08); }
        .cell { flex: 1; }
        .log-entries { padding: 6px 0 6px 12px; border-bottom: 1px solid rgba(139,147,167,0.08); }
        .log-entry { color: ${COLORS.follower}; font-size: 11px; padding: 2px 0; }
        .log-empty { color: ${COLORS.text}; font-size: 11px; padding: 2px 0; }
        .events { max-height: 170px; overflow-y: auto; }
        .event-row { color: ${COLORS.text}; font-size: 11px; padding: 3px 0; }
        .status-banner {
          margin-top: 28px; padding: 10px 16px; border: 1px solid; border-radius: 8px;
          font-family: "IBM Plex Mono", monospace; font-size: 13px;
          display: inline-flex; align-items: center; gap: 8px;
        }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; }
        .actions { display: flex; gap: 12px; margin-top: 16px; flex-wrap: wrap; }
        .size-control { display: flex; gap: 8px; align-items: center; margin-top: 16px; }
        .size-label { color: ${COLORS.text}; font-family: "IBM Plex Mono", monospace; font-size: 12px; margin-right: 4px; }
        .btn {
          background: transparent; border: 1px solid ${COLORS.text}55; color: white;
          padding: 10px 18px; border-radius: 8px; cursor: pointer;
          font-family: "Space Grotesk", sans-serif; font-weight: 600;
          transition: border-color 0.15s ease, transform 0.1s ease;
        }
        .btn-small { padding: 6px 12px; font-size: 12px; }
        .btn-active { border-color: ${COLORS.follower}; color: ${COLORS.follower}; }
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