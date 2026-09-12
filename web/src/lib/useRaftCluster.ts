"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type NodeState = "Follower" | "Candidate" | "Leader";

export interface NodeSnapshot {
  ID: string;
  State: NodeState;
  CurrentTerm: number;
  VotedFor: string;
  LogLength: number;
  CommitIndex: number;
  Alive: boolean;
  Log: { Term: number; Index: number; Command: string }[];
  Unreachable: string[];
  StateMachine: Record<string, string>;
}

export interface Stats {
  StartedAt: string;
  ElectionsHeld: number;
  WritesSubmitted: number;
  WritesCommitted: number;
  AvgLatencyMs: number;
}

export interface ClusterSnapshot {
  nodes: NodeSnapshot[];
  stats: Stats;
}

export type RaftEventType =
  | "election_started"
  | "leader_elected"
  | "vote_granted"
  | "vote_rejected"
  | "node_failed"
  | "node_recovered"
  | "partitioned"
  | "healed"
  | "write_submitted"
  | "committed";

export interface RaftEvent {
  Time: string;
  Type: RaftEventType;
  NodeID: string;
  Term: number;
  Index: number;
  Detail: string;
}

interface RaftlineBridge {
  newCluster: (ids: string[]) => void;
  start: () => { error: string } | undefined;
  stop: () => { error: string } | undefined;
  pause: () => void;
  resume: () => void;
  killNode: (id: string) => { error: string } | undefined;
  reviveNode: (id: string) => { error: string } | undefined;
  partition: (groupA: string[], groupB: string[]) => { error: string } | undefined;
  healPartition: () => { error: string } | undefined;
  submitWrite: (command: string) => { index: number } | { error: string };
  getSnapshot: () => ClusterSnapshot | { error: string };
  setOnEvent: (cb: (e: RaftEvent) => void) => { error: string } | undefined;
  resizeCluster: (ids: string[]) => void;
}

declare global {
  interface Window {
    raftline?: RaftlineBridge;
    Go: new () => {
      importObject: WebAssembly.Imports;
      run: (instance: WebAssembly.Instance) => Promise<void>;
    };
    // Deliberately stored on window, not as a module-level variable. A
    // module-level `let` survives React Strict Mode's synthetic
    // mount->cleanup->remount just fine, but does NOT survive Next.js Fast
    // Refresh actually re-executing this module on a real code edit —
    // which resets any module-level variable back to its initial value.
    // Each such reset would otherwise call newCluster() again, spinning up
    // a brand-new Cluster (with its own full set of goroutines) while the
    // previous one is never stopped and keeps running orphaned in the
    // background, silently competing for the same single-threaded WASM
    // scheduler. Over a long dev session with many edits, these orphaned
    // clusters compound and starve the real one of scheduling time badly
    // enough to trigger genuine spurious elections. window survives module
    // reloads (only a full page navigation clears it), so anchoring the
    // singleton here makes newCluster() truly call at most once per real
    // page load, no matter how many times Fast Refresh touches this file.
    __raftlineBootPromise?: Promise<void>;
  }
}

const DEFAULT_NODE_IDS = ["n1", "n2", "n3", "n4", "n5"];

function isErrorResult(v: unknown): v is { error: string } {
  return typeof v === "object" && v !== null && "error" in v;
}

/**
 * Boots the WASM module and cluster exactly once per real page load, no
 * matter how many times React (re)invokes the effect that calls this, or
 * how many times Next.js Fast Refresh re-executes this module on a live
 * edit. See the __raftlineBootPromise comment on the Window interface
 * above for why this lives on window rather than as a module-level
 * variable.
 */
function ensureRaftlineBooted(nodeIds: string[], log: (msg: string) => void): Promise<void> {
  if (window.__raftlineBootPromise) return window.__raftlineBootPromise;

  window.__raftlineBootPromise = (async () => {
    log("waiting for window.Go...");
    await waitForGo();
    log(`window.Go ready: ${typeof window.Go}`);

    const go = new window.Go();
    log("fetching /main.wasm...");
    const resp = await fetch("/main.wasm");
    log(`fetch status: ${resp.status} ${resp.headers.get("content-type")}`);
    const bytes = await resp.arrayBuffer();
    log(`got ${bytes.byteLength} bytes`);
    const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
    log("wasm instantiated");

    go.run(instance);
    log("go.run() called, waiting for window.raftline...");

    await waitForRaftline();
    log(`window.raftline appeared: ${typeof window.raftline}`);

    window.raftline!.newCluster(nodeIds);
    log("cluster created");
    window.raftline!.start();
    log("cluster started");
  })();

  return window.__raftlineBootPromise;
}

export function useRaftCluster(nodeIds: string[] = DEFAULT_NODE_IDS) {
  const [ready, setReady] = useState(false);
  const [snapshot, setSnapshot] = useState<ClusterSnapshot | null>(null);
  const [events, setEvents] = useState<RaftEvent[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [debugLog, setDebugLog] = useState<string[]>([]);

  const log = useCallback((msg: string) => {
    setDebugLog((prev) => [...prev, `[${new Date().toISOString().slice(11, 23)}] ${msg}`]);
  }, []);

  const refreshSnapshot = useCallback(() => {
    if (!window.raftline) return;
    const snap = window.raftline.getSnapshot();
    if (isErrorResult(snap)) return;
    setSnapshot(snap);
  }, []);

  useEffect(() => {
    let mounted = true;

    ensureRaftlineBooted(nodeIds, log)
      .then(() => {
        if (!mounted) return;
        window.raftline!.setOnEvent((e) => {
          setEvents((prev) => [...prev.slice(-199), e]);
          refreshSnapshot();
        });
        refreshSnapshot();
        setReady(true);
        log("READY!");
      })
      .catch((err) => {
        if (!mounted) return;
        const msg = err instanceof Error ? err.message : String(err);
        log(`ERROR: ${msg}`);
        setLoadError(msg);
      });

    return () => {
      mounted = false;
      // Deliberately NOT calling window.raftline?.stop() here. In React 18
      // Strict Mode (dev only), this cleanup fires as part of a synthetic
      // mount -> cleanup -> remount cycle; stopping the cluster here would
      // kill it right before the surviving mount tries to use it. The
      // cluster is a page-level singleton by design and is meant to keep
      // running for the life of the page, not any single component mount.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pause/resume the simulation while the browser tab is hidden. Chrome
  // throttles JS timers heavily in background tabs, which otherwise
  // causes a burst of backed-up election timeouts to fire all at once the
  // moment the tab regains focus — producing a runaway spike of spurious
  // elections. Pausing sidesteps this entirely rather than trying to
  // compensate for throttled timing after the fact.
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) window.raftline?.pause();
      else window.raftline?.resume();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const killNode = useCallback((id: string) => {
    window.raftline?.killNode(id);
    refreshSnapshot();
  }, [refreshSnapshot]);

  const reviveNode = useCallback((id: string) => {
    window.raftline?.reviveNode(id);
    refreshSnapshot();
  }, [refreshSnapshot]);

  const partition = useCallback((groupA: string[], groupB: string[]) => {
    window.raftline?.partition(groupA, groupB);
    refreshSnapshot();
  }, [refreshSnapshot]);

  const healPartition = useCallback(() => {
    window.raftline?.healPartition();
    refreshSnapshot();
  }, [refreshSnapshot]);

  const submitWrite = useCallback((command: string) => {
    const result = window.raftline?.submitWrite(command);
    refreshSnapshot();
    return result;
  }, [refreshSnapshot]);

  const resizeCluster = useCallback((ids: string[]) => {
    window.raftline?.resizeCluster(ids);
    setEvents([]);
    refreshSnapshot();
  }, [refreshSnapshot]);

  return {
    ready,
    loadError,
    snapshot,
    events,
    debugLog,
    killNode,
    reviveNode,
    partition,
    healPartition,
    submitWrite,
    resizeCluster,
  };
}

function waitForGo(timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (typeof window.Go !== "undefined") {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("window.Go did not appear within 5s — wasm_exec.js Script tag likely blocked or failed"));
        return;
      }
      setTimeout(check, 20);
    };
    check();
  });
}

function waitForRaftline(timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.raftline) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("window.raftline did not appear after WASM start"));
        return;
      }
      setTimeout(check, 20);
    };
    check();
  });
}