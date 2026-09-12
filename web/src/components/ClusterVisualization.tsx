"use client";

import { useEffect, useState } from "react";
import { NodeSnapshot, RaftEvent } from "@/lib/useRaftCluster";
import { pentagonPositions } from "@/lib/clusterLayout";

const COLORS = {
  bg: "#0A0E16",
  leader: "#E8A33D",
  follower: "#4FD1E8",
  dead: "#E85D6B",
  text: "#8B93A7",
};

interface Props {
  nodes: NodeSnapshot[];
  events: RaftEvent[];
  onKillNode: (id: string) => void;
  onReviveNode: (id: string) => void;
}

interface InFlight {
  id: string;
  fromId: string;
  toId: string;
  color: string;
}

export default function ClusterVisualization({ nodes, events, onKillNode, onReviveNode }: Props) {
  const size = 460;
  const center = size / 2;
  const radius = 150;
  const positions = pentagonPositions(nodes.length, center, center, radius);
  const posById = Object.fromEntries(nodes.map((n, i) => [n.ID, positions[i]]));
  const leaderIdx = nodes.findIndex((n) => n.State === "Leader" && n.Alive);
  const maxLog = Math.max(1, ...nodes.map((n) => n.LogLength));

  const [flash, setFlash] = useState<Record<string, "granted" | "rejected">>({});
  const [inFlight, setInFlight] = useState<InFlight[]>([]);

  useEffect(() => {
    const last = events[events.length - 1];
    if (!last) return;

    if (last.Type === "vote_granted" || last.Type === "vote_rejected") {
      const kind = last.Type === "vote_granted" ? "granted" : "rejected";
      setFlash((prev) => ({ ...prev, [last.NodeID]: kind }));
      setTimeout(() => {
        setFlash((prev) => {
          const next = { ...prev };
          delete next[last.NodeID];
          return next;
        });
      }, 450);

      // animate the vote reply traveling back to the candidate (Detail holds candidateID)
      if (last.Detail && posById[last.Detail] && posById[last.NodeID]) {
        const id = `${last.NodeID}-${last.Detail}-${Date.now()}`;
        setInFlight((prev) => [...prev, { id, fromId: last.NodeID, toId: last.Detail, color: kind === "granted" ? COLORS.follower : COLORS.dead }]);
        setTimeout(() => setInFlight((prev) => prev.filter((m) => m.id !== id)), 500);
      }
    }

    if (last.Type === "election_started") {
      // animate the vote request going out from the candidate to every other alive node
      const candidate = last.NodeID;
      nodes.forEach((n) => {
        if (n.ID === candidate || !n.Alive || !posById[n.ID]) return;
        const id = `${candidate}-${n.ID}-${Date.now()}-${Math.random()}`;
        setInFlight((prev) => [...prev, { id, fromId: candidate, toId: n.ID, color: COLORS.leader }]);
        setTimeout(() => setInFlight((prev) => prev.filter((m) => m.id !== id)), 500);
      });
    }
  }, [events]);

  return (
    <div className="cluster-panel">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <defs>
          <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <radialGradient id="sweepFade" cx="0%" cy="0%" r="100%">
            <stop offset="0%" stopColor={COLORS.follower} stopOpacity="0.35" />
            <stop offset="100%" stopColor={COLORS.follower} stopOpacity="0" />
          </radialGradient>
        </defs>

        {[radius * 0.5, radius, radius * 1.25].map((r, i) => (
          <circle key={i} cx={center} cy={center} r={r} fill="none" stroke={COLORS.text} strokeOpacity={0.08} />
        ))}

        <g style={{ transformOrigin: `${center}px ${center}px` }} className="sweep">
          <path
            d={`M${center},${center} L${center},${center - radius * 1.3} A${radius * 1.3},${radius * 1.3} 0 0 1 ${
              center + radius * 1.3 * Math.sin((Math.PI * 2) / 8)
            },${center - radius * 1.3 * Math.cos((Math.PI * 2) / 8)} Z`}
            fill="url(#sweepFade)"
          />
        </g>

        {positions.map((p, i) =>
  positions.slice(i + 1).map((q, j) => {
    const a = nodes[i], b = nodes[i + 1 + j];
    const cutOff = a.Unreachable.includes(b.ID) || b.Unreachable.includes(a.ID);
    return (
      <line
        key={`${i}-${j}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y}
        stroke={cutOff ? COLORS.dead : COLORS.text}
        strokeOpacity={cutOff ? 0.4 : 0.15}
        strokeDasharray={cutOff ? "4 4" : undefined}
        strokeWidth={1}
      />
    );
  })
)}

        {leaderIdx >= 0 &&
  positions.map((q, i) => {
    if (i === leaderIdx) return null;
    const p = positions[leaderIdx];
    const peer = nodes[i];
    const leaderNode = nodes[leaderIdx];
    const cutOff = leaderNode.Unreachable.includes(peer.ID) || peer.Unreachable.includes(leaderNode.ID);
    if (!peer.Alive || cutOff) return null;
    return (
      <circle key={`pulse-${i}`} r={3} fill={COLORS.leader}>
        <animateMotion dur="1s" repeatCount="indefinite" path={`M${p.x},${p.y} L${q.x},${q.y}`} />
      </circle>
    );
  })}

        {/* message-in-flight dots for elections/votes */}
        {inFlight.map((m) => {
          const from = posById[m.fromId];
          const to = posById[m.toId];
          if (!from || !to) return null;
          return (
            <circle key={m.id} r={4} fill={m.color}>
              <animateMotion dur="0.5s" fill="freeze" path={`M${from.x},${from.y} L${to.x},${to.y}`} />
            </circle>
          );
        })}

        {nodes.map((n, i) => {
          const p = positions[i];
          const color = !n.Alive ? COLORS.dead : n.State === "Leader" ? COLORS.leader : COLORS.follower;
          const isLeader = i === leaderIdx;
          const flashKind = flash[n.ID];
          const barW = (n.LogLength / maxLog) * 32;

          return (
            <g key={n.ID} onClick={() => (n.Alive ? onKillNode(n.ID) : onReviveNode(n.ID))} className="node-group">
              {isLeader && (
                <circle cx={p.x} cy={p.y} r={30} fill="none" stroke={COLORS.leader} strokeWidth={1.5} strokeDasharray="4 4" className="leader-ring" opacity={0.8} />
              )}

              {n.State === "Candidate" && (
                <circle cx={p.x} cy={p.y} r={26} fill="none" stroke={color} strokeWidth={2} opacity={0.6}>
                  <animate attributeName="r" values="20;32;20" dur="1.2s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.6;0;0.6" dur="1.2s" repeatCount="indefinite" />
                </circle>
              )}

              {flashKind && (
                <circle cx={p.x} cy={p.y} r={24} fill="none" stroke={flashKind === "granted" ? COLORS.follower : COLORS.dead} strokeWidth={3} opacity={0.9} />
              )}

              <circle cx={p.x} cy={p.y} r={20} fill={color} filter="url(#glow)" opacity={n.Alive ? 1 : 0.35} />
              <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize={11} fontFamily="IBM Plex Mono, monospace" fill={COLORS.bg} fontWeight={700}>
                {n.ID}
              </text>
              <text x={p.x} y={p.y + 38} textAnchor="middle" fontSize={11} fontFamily="IBM Plex Mono, monospace" fill={COLORS.text}>
                {n.State} · T{n.CurrentTerm}
              </text>

              <rect x={p.x - 16} y={p.y + 46} width={32} height={3} rx={1.5} fill={COLORS.text} opacity={0.15} />
<rect x={p.x - 16} y={p.y + 46} width={barW} height={3} rx={1.5} fill={color} opacity={0.9} />
<text x={p.x} y={p.y + 60} textAnchor="middle" fontSize={9} fontFamily="IBM Plex Mono, monospace" fill={COLORS.text}>
  log {n.LogLength}/{maxLog}
</text>
            </g>
          );
        })}
      </svg>

      <style jsx>{`
        .cluster-panel {
          background: radial-gradient(circle at 50% 40%, #0d1220 0%, ${COLORS.bg} 70%);
          border: 1px solid rgba(139, 147, 167, 0.15);
          border-radius: 16px;
          padding: 24px;
          box-shadow: 0 0 40px rgba(79, 209, 232, 0.06) inset;
        }
        .sweep { animation: rotate 4s linear infinite; }
        .leader-ring { animation: rotate 6s linear infinite; transform-box: fill-box; transform-origin: center; }
        @keyframes rotate { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .node-group { cursor: pointer; transition: transform 0.15s ease; }
        .node-group:hover { transform: scale(1.06); }
      `}</style>
    </div>
  );
}