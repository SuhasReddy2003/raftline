"use client";

interface Props {
  aliveCount: number;
  total: number;
  hasQuorum: boolean;
  avgLatencyMs: number;
}

export default function HealthMeter({ aliveCount, total, hasQuorum, avgLatencyMs }: Props) {
  // A simple composite score: quorum status matters most (50 points),
  // then how many nodes are alive (30 points), then network latency (20
  // points) as a rough proxy for "how strained the simulated network is."
  // This is a demo-friendly heuristic, not a real production SLI — its
  // job is to give one glanceable number, not to be rigorously defined.
  const aliveRatio = aliveCount / total;
  const latencyScore = Math.max(0, 1 - avgLatencyMs / 100);
  const score = Math.round((hasQuorum ? 50 : 0) + aliveRatio * 30 + latencyScore * 20);
  const color = score >= 70 ? "#4FD1E8" : score >= 40 ? "#E8A33D" : "#E85D6B";

  return (
    <div className="health-meter">
      <div className="health-label">Cluster health · {score}</div>
      <div className="health-track">
        <div className="health-fill" style={{ width: `${score}%`, background: color }} />
      </div>
      <style jsx>{`
        .health-meter { font-family: "IBM Plex Mono", monospace; font-size: 12px; color: #8B93A7; }
        .health-label { margin-bottom: 6px; }
        .health-track { width: 220px; height: 6px; background: rgba(139,147,167,0.15); border-radius: 3px; overflow: hidden; }
        .health-fill { height: 100%; transition: width 0.3s ease, background 0.3s ease; }
      `}</style>
    </div>
  );
}